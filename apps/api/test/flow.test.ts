// End-to-end business flows through the API: OG -> approval -> dispatch -> receipt -> cheque return -> day close.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, ids, login, ownerQuery, testApp, type Call, type TestApp } from './helpers.js';

let t: TestApp;
let I: Awaited<ReturnType<typeof ids>>;
let owner: Call, accounts: Call, sales1: Call, dist: Call;

beforeAll(async () => {
  t = await testApp();
  I = await ids();
  owner = as(t.app, await login(t.app, 'owner'));
  accounts = as(t.app, await login(t.app, 'accounts'));
  sales1 = as(t.app, await login(t.app, 'sales1'));
  dist = as(t.app, await login(t.app, 'dist'));
});
afterAll(async () => t.close());

const og = (over: Record<string, unknown> = {}) => ({
  customerId: I.parties.C001,
  branchId: I.branches.PK,
  terms: 'credit',
  advancePct: 0,
  creditDays: 30,
  freightBy: 'customer',
  freightPerBag: '0',
  discount: '0',
  lines: [{ productId: I.products['SONA-U'], bags: 100, rate: '4500' }],
  ...over
});

async function status(id: string | number) {
  return (await ownerQuery('select fulfilment, payment, paid, outstanding, total_value from og_status where og_id = $1', [id]))[0];
}

describe('OG approval rules', () => {
  it('approves automatically when within credit limit, floor price and stock', async () => {
    const r = await sales1('POST', '/api/ogs', og());
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('approved');
    expect(r.body.ogNo).toMatch(/^OG-2627-\d{5}$/);
    expect((await status(r.body.id)).fulfilment).toBe('Approved');
  });

  it('sends an over-limit, below-floor OG for approval, and the creator cannot approve it', async () => {
    const r = await sales1('POST', '/api/ogs', og({ customerId: I.parties.C003, lines: [{ productId: I.products['FFC-DAP'], bags: 200, rate: '11000' }] }));
    expect(r.body.status).toBe('submitted');
    expect(r.body.checks.reasons.join(' ')).toMatch(/below the floor price/);
    expect(r.body.checks.reasons.join(' ')).toMatch(/Credit limit exceeded/);
    // sales cannot approve at all; owner can, but needs a comment
    expect((await sales1('POST', `/api/ogs/${r.body.id}/decide`, { approve: true, comment: 'ok' })).status).toBe(403);
    expect((await owner('POST', `/api/ogs/${r.body.id}/decide`, { approve: true, comment: '' })).status).toBe(400);
    const ok = await owner('POST', `/api/ogs/${r.body.id}/decide`, { approve: true, comment: 'Paid on time for three seasons' });
    expect(ok.body.status).toBe('approved');
    // once approved, its lines are frozen
    await expect(ownerQuery('update og_lines set bags = 1 where og_id = $1', [r.body.id])).rejects.toThrow(/cannot be changed/);
  });

  it('an owner cannot approve their own OG', async () => {
    const r = await owner('POST', '/api/ogs', og({ customerId: I.parties.C004, lines: [{ productId: I.products['CAN'], bags: 10, rate: '100' }] }));
    expect(r.body.status).toBe('submitted');
    expect((await owner('POST', `/api/ogs/${r.body.id}/decide`, { approve: true, comment: 'mine' })).status).toBe(403);
  });

  it('flags bags sold ahead of stock as unpurchased without blocking', async () => {
    const r = await owner('POST', '/api/ogs/preview', og({ customerId: I.parties.C005, branchId: I.branches.MUL, lines: [{ productId: I.products['ENG-U'], bags: 300, rate: '4500' }] }));
    expect(r.status).toBe(200);
    expect(r.body.unpurchasedBags).toBe(300); // MUL has no Engro Urea
    expect(r.body.needsApproval).toBe(false);
  });

  it('a sales rep cannot raise an OG for another rep\'s customer', async () => {
    const r = await sales1('POST', '/api/ogs', og({ customerId: I.parties.C005 }));
    expect(r.status).toBe(404);
  });
});

describe('dispatch, receipt, allocation, cheque return', () => {
  let ogId: string;
  let lineId: number;

  it('dispatches in two trucks and posts the receivable', async () => {
    const created = await owner('POST', '/api/ogs', og({ customerId: I.parties.C002, branchId: I.branches.SWL, freightPerBag: '30', discount: '1000',
      lines: [{ productId: I.products['SARS-U'], bags: 300, rate: '4400' }] }));
    // C002 owes 6.4 lakh against a 20 lakh limit; 300 bags x 4430 net = 13.28 lakh fits
    expect(created.body.status).toBe('approved');
    ogId = created.body.id;
    const detail = await dist('GET', `/api/ogs/${ogId}`);
    expect(detail.body.total_value).toBeUndefined(); // distribution sees no money
    lineId = Number(detail.body.lines[0].id);

    const before = (await ownerQuery('select bags from stock_on_hand where product_id = $1 and branch_id = $2', [I.products['SARS-U'], I.branches.SWL]))[0].bags;
    const d1 = await dist('POST', `/api/ogs/${ogId}/dispatches`, { truckNo: 'LES-4471', biltyNo: '88120', transporterId: I.parties.T001, freightPerBag: '38', lines: [{ ogLineId: lineId, bags: 200 }] });
    expect(d1.status).toBe(200);
    expect((await status(ogId)).fulfilment).toBe('Partly dispatched');
    // too many bags on the second truck
    expect((await dist('POST', `/api/ogs/${ogId}/dispatches`, { truckNo: 'LHR-9032', lines: [{ ogLineId: lineId, bags: 101 }] })).status).toBe(422);
    const d2 = await dist('POST', `/api/ogs/${ogId}/dispatches`, { truckNo: 'LHR-9032', lines: [{ ogLineId: lineId, bags: 100 }] });
    expect(d2.status).toBe(200);
    const st = await status(ogId);
    expect(st.fulfilment).toBe('Dispatched');
    expect(st.total_value).toBe('1328000.00'); // 300*4400 + 300*30 - 1000

    const after = (await ownerQuery('select bags from stock_on_hand where product_id = $1 and branch_id = $2', [I.products['SARS-U'], I.branches.SWL]))[0].bags;
    expect(Number(before) - Number(after)).toBe(300);
    // the two dispatch entries add up to exactly the OG value, discount rounding included
    const posted = await ownerQuery(
      `select sum(l.debit) as d from journal_lines l join journal_entries e on e.id = l.entry_id
        where e.source_type = 'dispatch' and l.party_id = $1 and e.source_id in (select dispatch_no from dispatches where og_id = $2)`,
      [I.parties.C002, ogId]
    );
    expect(posted[0].d).toBe('1328000.00');
  });

  it('records a cheque, allocates part of it, and keeps the rest as advance', async () => {
    const bank = I.accounts['1201'];
    const r = await accounts('POST', '/api/receipts', {
      partyId: I.parties.C002, mode: 'cheque', accountId: bank, instrumentNo: '004512', drawerBank: 'Faysal Bank', amount: '1000000',
      allocations: [{ ogId: Number(ogId), amount: '800000' }]
    });
    expect(r.status).toBe(200);
    expect(r.body.advance).toBe('200000.00');
    expect((await status(ogId)).payment).toBe('Partly paid');
    // the same cheque cannot be recorded twice
    const dup = await accounts('POST', '/api/receipts', { partyId: I.parties.C002, mode: 'cheque', accountId: bank, instrumentNo: '004512', drawerBank: 'faysal bank', amount: '5' });
    expect(dup.status).toBe(409);
    // cannot allocate more than is outstanding
    const over = await accounts('POST', `/api/receipts/${r.body.id}/allocations`, { allocations: [{ ogId: Number(ogId), amount: '600000' }] });
    expect(over.status).toBe(422);
    const rest = await accounts('POST', '/api/receipts', {
      partyId: I.parties.C002, mode: 'online', accountId: bank, instrumentNo: 'IBFT-77881', amount: '528000', allocations: [{ ogId: Number(ogId), amount: '528000' }]
    });
    expect(rest.status).toBe(200);
    expect((await status(ogId)).payment).toBe('Paid');
  });

  it('a returned cheque reverses its allocation and the OG is no longer paid', async () => {
    const rc = (await ownerQuery("select id from receipts where instrument_no = '004512'"))[0].id;
    const ret = await accounts('POST', `/api/receipts/${rc}/return`, { reason: 'Insufficient funds', bankCharges: '1500' });
    expect(ret.status).toBe(200);
    expect(ret.body.ogsAffected).toContain(ogId);
    const st = await status(ogId);
    expect(st.payment).toBe('Partly paid');
    expect(st.outstanding).toBe('800000.00');
    // the receipt itself cannot be edited, and cannot be returned twice
    expect((await accounts('POST', `/api/receipts/${rc}/return`, { reason: 'again please' })).status).toBe(422);
    await expect(ownerQuery("update receipts set amount = 1 where id = $1", [rc])).rejects.toThrow(/cannot be changed/);
  });

  it('cash before delivery: dispatch is held until the full amount is received', async () => {
    const c = await owner('POST', '/api/ogs', og({ customerId: I.parties.C006, branchId: I.branches.BWP, terms: 'cbd', lines: [{ productId: I.products['SARS-NP'], bags: 50, rate: '9100' }] }));
    expect(c.body.status).toBe('approved');
    const lid = Number((await owner('GET', `/api/ogs/${c.body.id}`)).body.lines[0].id);
    const held = await dist('POST', `/api/ogs/${c.body.id}/dispatches`, { truckNo: 'BWP-1100', lines: [{ ogLineId: lid, bags: 50 }] });
    expect(held.status).toBe(422);
    expect(held.body.message).toMatch(/Cash before delivery/);
    await accounts('POST', '/api/receipts', { partyId: I.parties.C006, mode: 'cash', accountId: I.accounts['1101'], amount: '455000', allocations: [{ ogId: Number(c.body.id), amount: '455000' }] });
    expect((await dist('POST', `/api/ogs/${c.body.id}/dispatches`, { truckNo: 'BWP-1100', lines: [{ ogLineId: lid, bags: 50 }] })).status).toBe(200);
  });
});

describe('idempotency', () => {
  it('a retried request with the same key posts once and returns the same result', async () => {
    const body = { partyId: I.parties.C001, mode: 'cash', accountId: I.accounts['1101'], amount: '1234.50' };
    const a = await accounts('POST', '/api/receipts', body, { 'idempotency-key': 'retry-test-1' });
    const b = await accounts('POST', '/api/receipts', body, { 'idempotency-key': 'retry-test-1' });
    expect(a.status).toBe(200);
    expect(b.body).toEqual(a.body);
    const n = await ownerQuery("select count(*)::int as n from receipts where amount = 1234.50");
    expect(n[0].n).toBe(1);
  });
});

describe('manual journals need a second person', () => {
  it('the maker cannot approve; another approver posts it', async () => {
    const j = await owner('POST', '/api/ledger/journals', {
      narration: 'Shop rent received in cash',
      lines: [
        { accountId: I.accounts['1101'], debit: '85000' },
        { accountId: I.accounts['4300'], credit: '85000', costCentreId: 2 }
      ]
    });
    expect(j.body.status).toBe('pending_approval');
    expect((await owner('POST', `/api/ledger/journals/${j.body.id}/approve`, { comment: 'self' })).status).toBe(422);
    const approver = as(t.app, await login(t.app, 'owner')); // same person, new session: still refused
    expect((await approver('POST', `/api/ledger/journals/${j.body.id}/approve`, { comment: 'self again' })).status).toBe(422);
    await ownerQuery("insert into role_permissions values ('finance','journal.approve') on conflict do nothing");
    const fin = as(t.app, await login(t.app, 'finance'));
    const ok = await fin('POST', `/api/ledger/journals/${j.body.id}/approve`, { comment: 'Checked against rent register' });
    expect(ok.status).toBe(200);
    expect(ok.body.entryNo).toMatch(/^JV-/);
    const unbalanced = await owner('POST', '/api/ledger/journals', { narration: 'bad entry', lines: [{ accountId: I.accounts['1101'], debit: '10' }, { accountId: I.accounts['4300'], credit: '9' }] });
    expect(unbalanced.status).toBe(422);
  });

  it('reversals are requested by one person and approved by another', async () => {
    const entry = (await ownerQuery("select id from journal_entries where narration = 'Shop rent received in cash'"))[0].id;
    const req = await accounts('POST', `/api/ledger/journals/${entry}/reversal-requests`, { reason: 'Posted to wrong tenant' });
    expect(req.status).toBe(200);
    const acc2 = as(t.app, await login(t.app, 'accounts'));
    expect((await acc2('POST', `/api/approvals/reversals/${req.body.requestId}/decide`, { approve: true, note: 'x' })).status).toBe(403);
    const ok = await owner('POST', `/api/approvals/reversals/${req.body.requestId}/decide`, { approve: true, note: 'Agreed' });
    expect(ok.body.reversalEntryId).toBeTruthy();
  });
});

describe('trial balance and day close', () => {
  it('the trial balance always balances', async () => {
    const tb = await accounts('GET', '/api/ledger/trial-balance');
    expect(tb.body.totals.balanced).toBe(true);
  });

  it('locks a day only when every cash and bank balance is confirmed, then serves a fixed day book', async () => {
    const date = '2026-10-01';
    const day = await accounts('GET', `/api/days/${date}`);
    expect(day.status).toBe(200);
    const counts = day.body.accounts.map((a: { account_id: number; closing: string }) => ({ accountId: a.account_id, amount: a.closing }));
    const wrong = await accounts('POST', `/api/days/${date}/lock`, { counts: counts.map((x: { accountId: number; amount: string }, i: number) => (i === 0 ? { ...x, amount: '1' } : x)) });
    expect(wrong.status).toBe(422);
    expect(wrong.body.details.join(' ')).toMatch(/difference/);
    const missing = await accounts('POST', `/api/days/${date}/lock`, { counts: counts.slice(1) });
    expect(missing.status).toBe(422);
    const locked = await accounts('POST', `/api/days/${date}/lock`, { counts });
    expect(locked.status).toBe(200);
    expect(locked.body.sha256).toMatch(/^[0-9a-f]{64}$/);

    const x1 = await t.app.inject({ method: 'GET', url: `/api/days/${date}/daybook?format=xlsx`, headers: { authorization: (await authHeader('accounts')) } });
    const x2 = await t.app.inject({ method: 'GET', url: `/api/days/${date}/daybook?format=xlsx`, headers: { authorization: (await authHeader('accounts')) } });
    expect(x1.statusCode).toBe(200);
    expect(x1.headers['x-content-sha256']).toBe(locked.body.sha256);
    expect(x1.rawPayload.equals(x2.rawPayload)).toBe(true);
    const csv = await t.app.inject({ method: 'GET', url: `/api/days/${date}/daybook?format=csv`, headers: { authorization: (await authHeader('accounts')) } });
    expect(csv.body.split('\n')[0]).toBe('entry_no,narration,source_type,account_code,account_name,party,debit,credit');

    // nothing can be posted into the locked day any more
    const late = await accounts('POST', '/api/receipts', { businessDate: date, partyId: I.parties.C001, mode: 'cash', accountId: I.accounts['1101'], amount: '10' });
    expect(late.status).toBe(422);
    expect(late.body.message).toMatch(/locked/);
    const exports = await ownerQuery("select count(*)::int as n from audit_log where action = 'export' and entity_id = $1", [date]);
    expect(exports[0].n).toBe(3);
  });
});

async function authHeader(user: string) {
  return `Bearer ${await login(t.app, user)}`;
}
