// Company orders, company invoices (PV), payments to companies (CPV), receipt vouchers (CRV),
// opening vouchers (OPV), the chart of accounts and sale points: the EduSoft screens the team uses daily.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dueDate } from '../src/routes/purchases.js';
import { as, ids, login, ownerQuery, testApp, type Call, type TestApp } from './helpers.js';

let t: TestApp;
let I: Awaited<ReturnType<typeof ids>>;
let owner: Call, accounts: Call, procure: Call, sales1: Call, dist: Call, auditor: Call;
let dealerCodeId: number;
let accountsToken: string;

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 3)]).toString('base64');
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(200, 32)]).toString('base64');

beforeAll(async () => {
  t = await testApp();
  I = await ids();
  owner = as(t.app, await login(t.app, 'owner'));
  accountsToken = await login(t.app, 'accounts');
  accounts = as(t.app, accountsToken);
  procure = as(t.app, await login(t.app, 'procure'));
  sales1 = as(t.app, await login(t.app, 'sales1'));
  dist = as(t.app, await login(t.app, 'dist'));
  auditor = as(t.app, await login(t.app, 'auditor'));
  const dc = await ownerQuery<{ id: number }>("select id from dealer_codes where code = '2130004749'");
  dealerCodeId = Number(dc[0]!.id);
});
afterAll(async () => t.close());

const order = (over: Record<string, unknown> = {}) => ({
  dealerCodeId,
  companyOrderNo: `CO-${Math.floor(Math.random() * 1e9)}`,
  productId: I.products['SONA-U'],
  locationId: I.branches.SWL,
  bags: 1000,
  rate: '4250',
  bgChargePerBag: '10',
  creditDays: 30,
  ...over
});

describe('due dates', () => {
  it('is invoice date + credit days - 1, or the same day with no credit', () => {
    expect(dueDate('2026-11-01', 30)).toBe('2026-11-30');
    expect(dueDate('2026-12-15', 60)).toBe('2027-02-12');
    expect(dueDate('2026-11-01', 0)).toBe('2026-11-01');
  });
});

describe('company orders', () => {
  it('books an order, records invoices as PVs, receives goods and tracks what is owed', async () => {
    const o = await procure('POST', '/api/purchases/orders', order());
    expect(o.status).toBe(200);
    expect(o.body.orderNo).toMatch(/^PO-\d{4}-\d{5}$/);
    const id = Number(o.body.id);

    // Value = bags x (rate + BG charge)
    let d = await procure('GET', `/api/purchases/orders/${id}`);
    expect(d.body.order_value).toBe('4260000.00');
    expect(d.body.supplier_id).toBe(I.parties.S002);

    // Invoice for 600 bags: amount defaults to 600 x 4260; due date from the order's credit days.
    const inv = await procure('POST', `/api/purchases/orders/${id}/invoices`, { invoiceNo: 'FFC-INV-1', invoiceDate: '2026-11-01', bags: 600 });
    expect(inv.status).toBe(200);
    expect(inv.body.entryNo).toMatch(/^PV-2627-\d{5}$/);
    expect(inv.body.amount).toBe('2556000.00');
    expect(inv.body.dueDate).toBe('2026-11-30');
    const lines = await ownerQuery(
      `select a.code, l.debit, l.credit, l.party_id, l.branch_id from journal_lines l join accounts a on a.id = l.account_id
        where l.entry_id = (select journal_entry_id from company_invoices where id = $1) order by l.line_no`,
      [inv.body.id]
    );
    expect(lines.map((l) => [l.code, l.debit, l.credit])).toEqual([['5050', '2556000.00', '0.00'], ['2100', '0.00', '2556000.00']]);
    expect(Number(lines[1].party_id)).toBe(I.parties.S002);
    expect(Number(lines[0].branch_id)).toBe(I.branches.SWL);

    // The same invoice number twice, or more bags than ordered, are refused.
    expect((await procure('POST', `/api/purchases/orders/${id}/invoices`, { invoiceNo: 'FFC-INV-1', bags: 10 })).status).toBe(422);
    const over = await procure('POST', `/api/purchases/orders/${id}/invoices`, { invoiceNo: 'FFC-INV-2', bags: 401 });
    expect(over.status).toBe(422);
    expect(over.body.message).toMatch(/Only 400 bags/);

    // Rate cannot change once invoiced; bags cannot drop below invoiced.
    const upd = await procure('PUT', `/api/purchases/orders/${id}`, { ...order(), rate: '4300', locationId: I.branches.SWL });
    expect(upd.status).toBe(422);
    expect((await procure('PUT', `/api/purchases/orders/${id}`, { ...order(), bags: 500 })).status).toBe(422);

    // Goods received against the order, by distribution, without seeing money.
    const open = await dist('GET', '/api/purchases/open-for-receipt');
    expect(open.status).toBe(200);
    const row = open.body.find((r: any) => Number(r.id) === id);
    expect(row.bags_left).toBe(1000);
    expect(row.rate).toBeUndefined();
    const gr = await dist('POST', '/api/stock/goods-receipts', {
      branchId: I.branches.SWL, companyOrderId: id, truckNo: 'MNA-101', lines: [{ productId: I.products['SONA-U'], bagsReceived: 600 }]
    });
    expect(gr.status).toBe(200);
    const wrong = await dist('POST', '/api/stock/goods-receipts', {
      branchId: I.branches.SWL, companyOrderId: id, lines: [{ productId: I.products['ENG-U'], bagsReceived: 10 }]
    });
    expect(wrong.status).toBe(422);
    const tooMany = await dist('POST', '/api/stock/goods-receipts', {
      branchId: I.branches.SWL, companyOrderId: id, lines: [{ productId: I.products['SONA-U'], bagsReceived: 401 }]
    });
    expect(tooMany.status).toBe(422);
    expect((await ownerQuery('select supplier_id from goods_receipts where id = $1', [gr.body.id]))[0].supplier_id).toBe(I.parties.S002);

    // Pay the company online with the IBFT screenshot, allocated to the order.
    const bank = I.accounts['1201'];
    const pay = await accounts('POST', '/api/vouchers', {
      kind: 'payment', moneyAccountId: bank, mode: 'online', referenceNo: 'IBFT-99812', partyId: I.parties.S002,
      narration: 'Payment to FFC', lines: [{ accountId: I.accounts['2100'], amount: '1000000' }],
      allocations: [{ companyOrderId: id, amount: '1000000' }], attachment: { mime: 'image/png', data: PNG }
    });
    expect(pay.status).toBe(200);
    expect(pay.body.entryNo).toMatch(/^CPV-2627-\d{5}$/);

    d = await procure('GET', `/api/purchases/orders/${id}`);
    expect(d.body.invoiced_bags).toBe(600);
    expect(d.body.received_bags).toBe(600);
    expect(d.body.paid).toBe('1000000.00');
    expect(d.body.payable).toBe('1556000.00');
    expect(d.body.due_date).toBe('2026-11-30');
    expect(d.body.invoices).toHaveLength(1);
    expect(d.body.receipts).toHaveLength(1);
    expect(d.body.payments).toHaveLength(1);

    // Cannot cancel an order with activity; closing stops further invoices.
    expect((await procure('POST', `/api/purchases/orders/${id}/cancel`, { reason: 'changed our mind' })).status).toBe(422);
    expect((await procure('POST', `/api/purchases/orders/${id}/close`, {})).status).toBe(200);
    expect((await procure('POST', `/api/purchases/orders/${id}/invoices`, { invoiceNo: 'FFC-INV-3', bags: 10 })).status).toBe(422);

    // Payables summary
    const p = await accounts('GET', '/api/purchases/payables?asOf=2026-12-05');
    const ffc = p.body.rows.find((r: any) => r.supplier_id === I.parties.S002);
    expect(ffc.balance).toBe('1556000.00');
    expect(ffc.overdue).toBe('1556000.00');
  });

  it('a reversed invoice no longer counts against the order', async () => {
    const o = await procure('POST', '/api/purchases/orders', order({ bags: 100 }));
    const id = Number(o.body.id);
    const inv = await procure('POST', `/api/purchases/orders/${id}/invoices`, { invoiceNo: 'X-1', bags: 100, amount: '426000' });
    expect(inv.status).toBe(200);
    const [je] = await ownerQuery('select journal_entry_id from company_invoices where id = $1', [inv.body.id]);
    const req = await accounts('POST', `/api/ledger/journals/${je.journal_entry_id}/reversal-requests`, { reason: 'Wrong invoice amount' });
    expect(req.status).toBe(200);
    const ap = await owner('POST', `/api/approvals/reversals/${req.body.requestId}/decide`, { approve: true, note: 'ok' });
    expect(ap.status).toBe(200);
    const d = await procure('GET', `/api/purchases/orders/${id}`);
    expect(d.body.invoiced_bags).toBe(0);
    expect(d.body.invoices[0].reversed).toBe(true);
    expect((await procure('POST', `/api/purchases/orders/${id}/invoices`, { invoiceNo: 'X-2', bags: 100, amount: '425000' })).status).toBe(200);
  });

  it('cancels an order with no activity, and checks dealer code and location', async () => {
    const o = await procure('POST', '/api/purchases/orders', order());
    expect((await procure('POST', `/api/purchases/orders/${o.body.id}/cancel`, { reason: 'Company cancelled the allocation' })).status).toBe(200);
    const fatimaCode = (await ownerQuery("select id from dealer_codes where code = 'FF-88231'"))[0].id;
    const dealer = await ownerQuery("insert into branches(firm_id, code, name_en, kind, party_id) select id, 'DL-T1', 'Test dealer', 'dealer', $1 from firms limit 1 returning id", [I.parties.S004]);
    expect((await procure('POST', '/api/purchases/orders', order({ locationId: Number(dealer[0].id) }))).status).toBe(422);
    // dealer code of another company than the product's? the order takes the company from the dealer code
    const f = await procure('POST', '/api/purchases/orders', order({ dealerCodeId: Number(fatimaCode), productId: I.products['SARS-U'] }));
    expect(f.status).toBe(200);
    expect((await procure('GET', `/api/purchases/orders/${f.body.id}`)).body.supplier_id).toBe(I.parties.S001);
  });

  it('keeps purchases away from sales and distribution', async () => {
    expect((await sales1('GET', '/api/purchases/orders')).status).toBe(403);
    expect((await dist('GET', '/api/purchases/orders')).status).toBe(403);
    expect((await auditor('GET', '/api/purchases/orders')).status).toBe(200);
    expect((await auditor('POST', '/api/purchases/orders', order())).status).toBe(403);
  });
});

describe('cash and bank vouchers', () => {
  it('posts a cash payment voucher for expenses', async () => {
    const r = await accounts('POST', '/api/vouchers', {
      kind: 'payment', moneyAccountId: I.accounts['1101'], mode: 'cash', narration: 'Godown labour and tea',
      lines: [{ accountId: I.accounts['5200'], amount: '1500' }, { accountId: I.accounts['5900'], amount: '350.50' }]
    });
    expect(r.status).toBe(200);
    expect(r.body.entryNo).toMatch(/^CPV-/);
    expect(r.body.amount).toBe('1850.50');
    const v = await accounts('GET', `/api/vouchers/${r.body.id}`);
    expect(v.body.lines.at(-1).account_code).toBe('1101');
    expect(v.body.lines.at(-1).credit).toBe('1850.50');
  });

  it('enforces mode, reference and party rules', async () => {
    const base = { kind: 'payment', narration: 'Test', lines: [{ accountId: I.accounts['5300'], amount: '100' }] };
    expect((await accounts('POST', '/api/vouchers', { ...base, moneyAccountId: I.accounts['1101'], mode: 'online', referenceNo: 'x' })).status).toBe(422);
    expect((await accounts('POST', '/api/vouchers', { ...base, moneyAccountId: I.accounts['1201'], mode: 'cash' })).status).toBe(422);
    expect((await accounts('POST', '/api/vouchers', { ...base, moneyAccountId: I.accounts['1201'], mode: 'cheque' })).status).toBe(422);
    expect((await accounts('POST', '/api/vouchers', { ...base, moneyAccountId: I.accounts['5300'], mode: 'dd', referenceNo: '1' })).status).toBe(422);
    // A payable line needs a party
    expect((await accounts('POST', '/api/vouchers', { ...base, moneyAccountId: I.accounts['1201'], mode: 'cheque', referenceNo: '1', lines: [{ accountId: I.accounts['2100'], amount: '5' }] })).status).toBe(422);
    // Customer money goes through Receipts
    const crv = await accounts('POST', '/api/vouchers', {
      kind: 'receipt', moneyAccountId: I.accounts['1101'], mode: 'cash', partyId: I.parties.C001, narration: 'cash from customer',
      lines: [{ accountId: I.accounts['1300'], amount: '100' }]
    });
    expect(crv.status).toBe(422);
    expect(crv.body.message).toMatch(/Receipts screen/);
    // Rent received: a CRV
    const rent = await accounts('POST', '/api/vouchers', {
      kind: 'receipt', moneyAccountId: I.accounts['1101'], mode: 'cash', narration: 'Shop rent November', lines: [{ accountId: I.accounts['4300'], amount: '25000' }]
    });
    expect(rent.status).toBe(200);
    expect(rent.body.entryNo).toMatch(/^CRV-/);
  });

  it('accepts a PDF proof later and refuses a fake one', async () => {
    const r = await accounts('POST', '/api/vouchers', {
      kind: 'payment', moneyAccountId: I.accounts['1201'], mode: 'online', referenceNo: 'IB-1', narration: 'Bank charges',
      lines: [{ accountId: I.accounts['5300'], amount: '250' }]
    });
    expect((await accounts('POST', `/api/vouchers/${r.body.id}/attachments`, { mime: 'application/pdf', data: PDF })).status).toBe(200);
    expect((await accounts('POST', `/api/vouchers/${r.body.id}/attachments`, { mime: 'application/pdf', data: PNG })).status).toBe(422);
    const v = await accounts('GET', `/api/vouchers/${r.body.id}`);
    expect(v.body.attachments).toHaveLength(1);
    const f = await t.app.inject({ method: 'GET', url: `/api/vouchers/${r.body.id}/attachments/${v.body.attachments[0].id}`, headers: { authorization: `Bearer ${accountsToken}` } });
    expect(f.statusCode).toBe(200);
    expect(f.headers['content-type']).toBe('application/pdf');
    expect((await sales1('GET', '/api/vouchers')).status).toBe(403);
  });

  it('allocates an earlier advance to a new order, but not beyond the payment', async () => {
    const pay = await accounts('POST', '/api/vouchers', {
      kind: 'payment', moneyAccountId: I.accounts['1201'], mode: 'cds', referenceNo: 'CDS-1', partyId: I.parties.S002,
      narration: 'Advance to FFC', lines: [{ accountId: I.accounts['2100'], amount: '500000' }]
    });
    expect(pay.status).toBe(200);
    const o = await procure('POST', '/api/purchases/orders', order());
    expect((await accounts('POST', `/api/vouchers/${pay.body.id}/allocations`, { allocations: [{ companyOrderId: Number(o.body.id), amount: '500000.01' }] })).status).toBe(422);
    expect((await accounts('POST', `/api/vouchers/${pay.body.id}/allocations`, { allocations: [{ companyOrderId: Number(o.body.id), amount: '300000' }] })).status).toBe(200);
    const d = await procure('GET', `/api/purchases/orders/${o.body.id}`);
    expect(d.body.paid).toBe('300000.00');
    expect(d.body.payable).toBe('-300000.00');
    // Another company's order is refused
    const fat = await ownerQuery("select id from company_orders where supplier_id = $1 limit 1", [I.parties.S001]);
    expect((await accounts('POST', `/api/vouchers/${pay.body.id}/allocations`, { allocations: [{ companyOrderId: Number(fat[0].id), amount: '1' }] })).status).toBe(422);
  });
});

describe('opening voucher', () => {
  it('waits for a second person, then posts as OPV', async () => {
    const unbalanced = { businessDate: '2026-07-01', narration: 'Opening balances', lines: [{ accountId: I.accounts['1101'], debit: '100' }, { accountId: I.accounts['2100'], partyId: I.parties.S003, credit: '60' }] };
    expect((await accounts('POST', '/api/vouchers/opening', unbalanced)).status).toBe(422);
    const r = await accounts('POST', '/api/vouchers/opening', { ...unbalanced, balanceToEquity: true });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('pending_approval');
    expect((await accounts('POST', `/api/ledger/journals/${r.body.id}/approve`, { comment: 'self' })).status).toBe(403);
    const own = await owner('POST', '/api/vouchers/opening', { ...unbalanced, balanceToEquity: true });
    expect((await owner('POST', `/api/ledger/journals/${own.body.id}/approve`, { comment: 'self' })).status).toBe(422);
    const ap = await owner('POST', `/api/ledger/journals/${r.body.id}/approve`, { comment: 'checked against the old books' });
    expect(ap.status).toBe(200);
    expect(ap.body.entryNo).toMatch(/^OPV-2627-\d{5}$/);
    const eq = await ownerQuery("select l.credit from journal_lines l join accounts a on a.id = l.account_id where l.entry_id = $1 and a.code = '3300'", [r.body.id]);
    expect(eq[0].credit).toBe('40.00');
  });
});

describe('chart of accounts', () => {
  it('adds a bank account with a suggested code under Banks', async () => {
    const banks = I.accounts['1200'];
    const s = await accounts('GET', `/api/accounts/next-code?parentId=${banks}`);
    expect(s.body.code).toMatch(/^12\d\d$/);
    const r = await accounts('POST', '/api/accounts', { name: 'Bank Alfalah SWL', parentId: banks, control: 'bank', bank: { bankName: 'Bank Alfalah', accountNo: '0011-22' } });
    expect(r.status).toBe(200);
    expect(r.body.code).toBe(s.body.code);
    const m = await accounts('GET', '/api/money-accounts');
    expect(m.body.some((a: any) => a.code === r.body.code && a.bank_name === 'Bank Alfalah')).toBe(true);
  });

  it('adds groups and accounts, and refuses wrong placements', async () => {
    const g = await accounts('POST', '/api/accounts', { name: 'Office expenses', parentId: I.accounts['5000'], postable: false });
    expect(g.status).toBe(200);
    const a = await accounts('POST', '/api/accounts', { name: 'Stationery', parentId: g.body.id });
    expect(a.status).toBe(200);
    expect(a.body.code.startsWith(g.body.code.slice(0, 2))).toBe(true);
    expect((await accounts('POST', '/api/accounts', { name: 'Under a postable', parentId: a.body.id })).status).toBe(422);
    expect((await accounts('POST', '/api/accounts', { name: 'Dup', parentId: g.body.id, code: a.body.code })).status).toBe(422);
    expect((await accounts('POST', '/api/accounts', { name: 'Cash in expenses', parentId: g.body.id, control: 'cash' })).status).toBe(422);
    expect((await sales1('POST', '/api/accounts', { name: 'x', parentId: g.body.id })).status).toBe(403);
    // Close an account with a balance: refused
    const close = await accounts('PUT', `/api/accounts/${I.accounts['1101']}`, { name: 'Main cash', active: false });
    expect(close.status).toBe(422);
    expect((await accounts('PUT', `/api/accounts/${a.body.id}`, { name: 'Stationery & printing', active: false })).status).toBe(200);
  });
});

describe('sale points', () => {
  it('adds a sale point with a code and links customers to it', async () => {
    const r = await owner('POST', '/api/sale-points', { nameEn: 'Haroonabad', district: 'Bahawalnagar', tehsil: 'Haroonabad', repUserId: I.users.sales1 });
    expect(r.status).toBe(200);
    expect(r.body.code).toMatch(/^SP\d{3}$/);
    const p = await owner('GET', `/api/parties/${I.parties.C002}`);
    const put = await owner('PUT', `/api/parties/${I.parties.C002}`, {
      kind: 'customer', nameEn: p.body.name_en, city: p.body.city, creditLimit: p.body.credit_limit, creditDays: p.body.credit_days, salePointId: r.body.id
    });
    expect(put.status).toBe(200);
    const list = await owner('GET', '/api/parties?kind=customer');
    expect(list.body.find((x: any) => x.id === I.parties.C002).sale_point_name).toBe('Haroonabad');
    const sp = await owner('GET', '/api/sale-points');
    expect(sp.body.find((x: any) => x.code === r.body.code).customers).toBe(1);
    expect((await owner('POST', '/api/sale-points', { nameEn: 'haroonabad' })).status).toBe(422);
  });
});
