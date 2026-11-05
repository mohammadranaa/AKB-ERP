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
  creditDays: 30,
  delivery: 'x',
  lines: [{ productId: I.products['SONA-U'], bags: 100, rate: '4500' }],
  ...over
});

// A dispatch with the details distribution must record: vehicle, driver and a photo of the loading.
const PHOTO = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]).toString('base64');
const truck = (over: Record<string, unknown> = {}) => ({
  truckNo: 'LES-4471',
  vehicleDetails: 'Hino 22-wheeler',
  driverName: 'Muhammad Akram',
  driverPhone: '0300-1234567',
  freightSettlement: 'none',
  photos: [{ mime: 'image/jpeg', data: PHOTO }],
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
    const created = await owner('POST', '/api/ogs', og({ customerId: I.parties.C002, branchId: I.branches.SWL, delivery: 'pohnch',
      lines: [{ productId: I.products['SARS-U'], bags: 300, rate: '4400' }] }));
    // C002 owes 6.4 lakh against a 20 lakh limit; 300 bags x 4400 = 13.2 lakh fits
    expect(created.body.status).toBe('approved');
    ogId = created.body.id;
    const detail = await dist('GET', `/api/ogs/${ogId}`);
    expect(detail.body.total_value).toBeUndefined(); // distribution sees no money
    lineId = Number(detail.body.lines[0].id);

    const before = (await ownerQuery('select bags from stock_on_hand where product_id = $1 and branch_id = $2', [I.products['SARS-U'], I.branches.SWL]))[0].bags;
    // Pohnch: AKB pays the transporter, so freight is AKB's cost and not added to the customer.
    const d1 = await dist('POST', `/api/ogs/${ogId}/dispatches`, truck({ biltyNo: '88120', transporterId: I.parties.T001, freightSettlement: 'akb_cost', freightPerBag: '38', lines: [{ ogLineId: lineId, bags: 200 }] }));
    expect(d1.status).toBe(200);
    expect((await status(ogId)).fulfilment).toBe('Partly dispatched');
    // too many bags on the second truck
    expect((await dist('POST', `/api/ogs/${ogId}/dispatches`, truck({ truckNo: 'LHR-9032', freightSettlement: 'akb_cost', lines: [{ ogLineId: lineId, bags: 101 }] }))).status).toBe(422);
    // Second truck: the customer paid the transporter Rs 30 a bag for AKB, so the customer is credited Rs 3,000.
    const d2 = await dist('POST', `/api/ogs/${ogId}/dispatches`, truck({ truckNo: 'LHR-9032', freightSettlement: 'customer_paid', freightPerBag: '30', lines: [{ ogLineId: lineId, bags: 100 }] }));
    expect(d2.status).toBe(200);
    const st = await status(ogId);
    expect(st.fulfilment).toBe('Dispatched');
    expect(st.total_value).toBe('1317000.00'); // 300*4400 - 100*30 paid by the customer

    const after = (await ownerQuery('select bags from stock_on_hand where product_id = $1 and branch_id = $2', [I.products['SARS-U'], I.branches.SWL]))[0].bags;
    expect(Number(before) - Number(after)).toBe(300);
    // the two dispatch entries leave the customer owing exactly the OG value
    const posted = await ownerQuery(
      `select sum(l.debit - l.credit) as d from journal_lines l join journal_entries e on e.id = l.entry_id
        where e.source_type = 'dispatch' and l.party_id = $1 and e.source_id in (select dispatch_no from dispatches where og_id = $2)`,
      [I.parties.C002, ogId]
    );
    expect(posted[0].d).toBe('1317000.00');
    // and AKB's freight cost is 200 x 38 + 100 x 30
    const freight = await ownerQuery(
      `select sum(l.debit) as d from journal_lines l join journal_entries e on e.id = l.entry_id join accounts a on a.id = l.account_id
        where e.source_type = 'dispatch' and a.code = '5200' and e.source_id in (select dispatch_no from dispatches where og_id = $1)`,
      [ogId]
    );
    expect(freight[0].d).toBe('10600.00');
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
      partyId: I.parties.C002, mode: 'online', accountId: bank, instrumentNo: 'IBFT-77881', amount: '517000', allocations: [{ ogId: Number(ogId), amount: '517000' }]
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
    const held = await dist('POST', `/api/ogs/${c.body.id}/dispatches`, truck({ truckNo: 'BWP-1100', lines: [{ ogLineId: lid, bags: 50 }] }));
    expect(held.status).toBe(422);
    expect(held.body.message).toMatch(/Cash before delivery/);
    await accounts('POST', '/api/receipts', { partyId: I.parties.C006, mode: 'cash', accountId: I.accounts['1101'], amount: '455000', allocations: [{ ogId: Number(c.body.id), amount: '455000' }] });
    expect((await dist('POST', `/api/ogs/${c.body.id}/dispatches`, truck({ truckNo: 'BWP-1100', lines: [{ ogLineId: lid, bags: 50 }] }))).status).toBe(200);
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

describe('customers added by sales', () => {
  it('get a system code and belong to the rep who added them', async () => {
    const r = await sales1('POST', '/api/parties', { kind: 'customer', nameEn: 'Noor Kissan Markaz', city: 'Okara', phone: '0301-5550000', creditLimit: '500000', creditDays: 30 });
    expect(r.status).toBe(200);
    expect(r.body.code).toMatch(/^C\d{4}$/);
    const row = (await ownerQuery('select code, rep_user_id from parties where id = $1', [r.body.id]))[0];
    expect(row.rep_user_id).toBe(I.users.sales1);
    // visible to sales1, not to sales2
    const sales2 = as(t.app, await login(t.app, 'sales2'));
    expect((await sales1('GET', '/api/parties?kind=customer&q=Noor')).body.map((p: { id: number }) => p.id)).toContain(r.body.id);
    expect((await sales2('GET', '/api/parties?kind=customer&q=Noor')).body).toEqual([]);
    // the same customer cannot be added twice; sales cannot add suppliers; a code sent in is ignored
    expect((await sales1('POST', '/api/parties', { kind: 'customer', nameEn: 'noor kissan markaz', city: 'okara' })).status).toBe(422);
    expect((await sales1('POST', '/api/parties', { kind: 'supplier', nameEn: 'Some Company' })).status).toBe(403);
    const withCode = await owner('POST', '/api/parties', { kind: 'customer', code: 'MINE-1', nameEn: 'Code Test Traders', city: 'Kasur' });
    expect(withCode.body.code).toMatch(/^C\d{4}$/);
  });
});

describe('collection source, delivery and freight', () => {
  it('only credit or cash terms; no discount or loan', async () => {
    expect((await sales1('POST', '/api/ogs/preview', og({ terms: 'loan' }))).status).toBe(400);
    const r = await sales1('POST', '/api/ogs/preview', og({ discount: '5000' }));
    expect(r.status).toBe(200);
    expect(r.body.totalValue).toBe('450000.00'); // discount ignored
  });

  it('X: the customer collects; no freight unless AKB paid it and adds it to the account', async () => {
    const c = await owner('POST', '/api/ogs', og({ customerId: I.parties.C001, branchId: I.branches.PK, lines: [{ productId: I.products['SONA-U'], bags: 40, rate: '4500' }] }));
    const lid = Number((await owner('GET', `/api/ogs/${c.body.id}`)).body.lines[0].id);
    expect((await dist('POST', `/api/ogs/${c.body.id}/dispatches`, truck({ freightSettlement: 'akb_cost', lines: [{ ogLineId: lid, bags: 10 }] }))).status).toBe(422);
    expect((await dist('POST', `/api/ogs/${c.body.id}/dispatches`, truck({ photos: [], lines: [{ ogLineId: lid, bags: 10 }] }))).status).toBe(400);
    expect((await dist('POST', `/api/ogs/${c.body.id}/dispatches`, truck({ driverPhone: '', lines: [{ ogLineId: lid, bags: 10 }] }))).status).toBe(400);
    // a fake photo is refused
    expect((await dist('POST', `/api/ogs/${c.body.id}/dispatches`, truck({ photos: [{ mime: 'image/jpeg', data: Buffer.alloc(200, 1).toString('base64') }], lines: [{ ogLineId: lid, bags: 10 }] }))).status).toBe(422);
    const d = await dist('POST', `/api/ogs/${c.body.id}/dispatches`, truck({ freightSettlement: 'charged_to_customer', transporterId: I.parties.T002, freightPerBag: '25', lines: [{ ogLineId: lid, bags: 40 }] }));
    expect(d.status).toBe(200);
    expect((await status(c.body.id)).total_value).toBe('181000.00'); // 40 x 4500 + 40 x 25 freight added
    // the photo can be viewed by those who can see the OG, as the image itself
    const det = await dist('GET', `/api/dispatches/${d.body.id}`);
    expect(det.body.photos).toHaveLength(1);
    expect(det.body.vehicle_details).toBe('Hino 22-wheeler');
    const img = await t.app.inject({ method: 'GET', url: `/api/dispatches/${d.body.id}/photos/${det.body.photos[0].id}`, headers: { authorization: `Bearer ${await login(t.app, 'dist')}` } });
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/jpeg');
    expect(img.rawPayload.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    // sales2 does not own C001, so the photo is hidden from them
    const s2 = await t.app.inject({ method: 'GET', url: `/api/dispatches/${d.body.id}/photos/${det.body.photos[0].id}`, headers: { authorization: `Bearer ${await login(t.app, 'sales2')}` } });
    expect(s2.statusCode).toBe(404);
  });

  it('company warehouse and customer warehouse (amanat) hold stock; trading dealers do not', async () => {
    const site = await dist('POST', '/api/locations', { kind: 'company_site', nameEn: 'Engro Daharki Plant', city: 'Daharki' });
    expect(site.status).toBe(200);
    expect(site.body.code).toMatch(/^CS\d{3}$/);
    const amanat = await sales1('POST', '/api/locations', { kind: 'amanat', partyId: I.parties.C002 });
    expect(amanat.status).toBe(200);
    // the same customer warehouse cannot be added twice
    expect((await sales1('POST', '/api/locations', { kind: 'amanat', partyId: I.parties.C002 })).status).toBe(422);
    expect(amanat.body.code).toMatch(/^AM\d{3}$/);
    const dealer = await sales1('POST', '/api/locations', { kind: 'dealer', partyId: I.parties.C004 });
    expect(dealer.status).toBe(200);
    // only administrators add AKB stores
    expect((await dist('POST', '/api/locations', { kind: 'godown', nameEn: 'New Godown' })).status).toBe(403);

    // goods received at the company plant and moved to the customer warehouse
    expect((await dist('POST', '/api/stock/goods-receipts', { branchId: site.body.id, supplierId: I.parties.S003, lines: [{ productId: I.products['ENG-U'], bagsReceived: 500 }] })).status).toBe(200);
    const tr = await dist('POST', '/api/stock/transfers', { fromBranchId: site.body.id, toBranchId: amanat.body.id, lines: [{ productId: I.products['ENG-U'], bags: 200 }] });
    expect(tr.status).toBe(200);
    expect((await dist('POST', `/api/stock/transfers/${tr.body.id}/receive`, {})).status).toBe(200);
    expect((await dist('POST', '/api/stock/transfers', { fromBranchId: site.body.id, toBranchId: dealer.body.id, lines: [{ productId: I.products['ENG-U'], bags: 1 }] })).status).toBe(422);
    const matrix = await owner('GET', '/api/stock/matrix');
    const cell = (b: number) => matrix.body.cells.find((x: { product_id: number; branch_id: number }) => x.product_id === I.products['ENG-U'] && x.branch_id === b);
    expect(Number(cell(site.body.id).on_hand)).toBe(300);
    expect(Number(cell(amanat.body.id).on_hand)).toBe(200);
    expect(matrix.body.branches.some((b: { id: number }) => b.id === dealer.body.id)).toBe(false);

    // an OG collected from the amanat warehouse takes stock from there
    const fromAmanat = await owner('POST', '/api/ogs', og({ customerId: I.parties.C001, branchId: amanat.body.id, lines: [{ productId: I.products['ENG-U'], bags: 50, rate: '4600' }] }));
    expect(fromAmanat.body.checks.unpurchasedBags).toBe(0);
    const la = Number((await owner('GET', `/api/ogs/${fromAmanat.body.id}`)).body.lines[0].id);
    expect((await dist('POST', `/api/ogs/${fromAmanat.body.id}/dispatches`, truck({ lines: [{ ogLineId: la, bags: 50 }] }))).status).toBe(200);
    expect(Number((await ownerQuery('select bags from stock_on_hand where product_id = $1 and branch_id = $2', [I.products['ENG-U'], amanat.body.id]))[0].bags)).toBe(150);

    // trading: no stock check and no stock movement
    const trade = await owner('POST', '/api/ogs', og({ customerId: I.parties.C001, branchId: dealer.body.id, lines: [{ productId: I.products['FFC-DAP'], bags: 100, rate: '12500' }] }));
    expect(trade.body.checks.unpurchasedBags).toBe(0);
    const lt = Number((await owner('GET', `/api/ogs/${trade.body.id}`)).body.lines[0].id);
    const before = await ownerQuery('select count(*)::int as n from stock_movements');
    expect((await dist('POST', `/api/ogs/${trade.body.id}/dispatches`, truck({ lines: [{ ogLineId: lt, bags: 100 }] }))).status).toBe(200);
    expect((await ownerQuery('select count(*)::int as n from stock_movements'))[0].n).toBe(before[0].n);
  });
});
