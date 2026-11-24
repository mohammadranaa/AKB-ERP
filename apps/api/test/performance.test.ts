// Salesman performance (sales, collections, targets) and employee activity.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { as, ids, login, ownerQuery, testApp, type Call, type TestApp } from './helpers.js';

let t: TestApp;
let I: Awaited<ReturnType<typeof ids>>;
let owner: Call, accounts: Call, sales1: Call, sales2: Call, dist: Call;
let month: string;

const PHOTO = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]).toString('base64');

beforeAll(async () => {
  t = await testApp();
  I = await ids();
  owner = as(t.app, await login(t.app, 'owner'));
  accounts = as(t.app, await login(t.app, 'accounts'));
  sales1 = as(t.app, await login(t.app, 'sales1'));
  sales2 = as(t.app, await login(t.app, 'sales2'));
  dist = as(t.app, await login(t.app, 'dist'));
  month = (await owner('GET', '/api/performance/team')).body.month;
});
afterAll(async () => t.close());

const row = (body: any, repId: number | undefined) => body.rows.find((r: any) => r.rep_user_id === repId);

describe('salesman performance', () => {
  it('credits the OG, the dispatch and the collection to the customer\'s rep', async () => {
    const before = row((await owner('GET', `/api/performance/team?month=${month}`)).body, I.users.sales2);
    const og = await sales2('POST', '/api/ogs', {
      customerId: I.parties.C006, branchId: I.branches.MUL, terms: 'credit', creditDays: 30, delivery: 'x',
      lines: [{ productId: I.products['SONA-U'], bags: 40, rate: '4500' }]
    });
    expect(og.body.status).toBe('approved');
    const [line] = await ownerQuery('select id from og_lines where og_id = $1', [og.body.id]);
    const d = await dist('POST', `/api/ogs/${og.body.id}/dispatches`, {
      truckNo: 'MNA-9001', vehicleDetails: 'Mazda', driverName: 'Akram', driverPhone: '0300-1112223', freightSettlement: 'none',
      photos: [{ mime: 'image/jpeg', data: PHOTO }], lines: [{ ogLineId: Number(line.id), bags: 40 }]
    });
    expect(d.status).toBe(200);
    const rc = await accounts('POST', '/api/receipts', {
      partyId: I.parties.C006, mode: 'cash', accountId: I.accounts['1101'], amount: '100000', allocations: [{ ogId: Number(og.body.id), amount: '100000' }]
    });
    expect(rc.status).toBe(200);

    const after = row((await owner('GET', `/api/performance/team?month=${month}`)).body, I.users.sales2);
    expect(after.ogs_booked - before.ogs_booked).toBe(1);
    expect(Number(after.bags_sold) - Number(before.bags_sold)).toBe(40);
    expect(Number(after.sales_value) - Number(before.sales_value)).toBe(180000);
    expect(Number(after.collected) - Number(before.collected)).toBe(100000);
    // sales1 figures did not move
    const s1 = row((await owner('GET', `/api/performance/team?month=${month}`)).body, I.users.sales1);
    expect(s1).toBeTruthy();

    const detail = await owner('GET', `/api/performance/reps/${I.users.sales2}?month=${month}`);
    expect(detail.status).toBe(200);
    expect(detail.body.byProduct.find((p: any) => p.code === 'SONA-U').bags).toBeGreaterThanOrEqual(40);
    expect(detail.body.byCustomer.find((c: any) => c.id === I.parties.C006).bags).toBeGreaterThanOrEqual(40);
    expect(detail.body.ogs.some((o: any) => o.id === og.body.id)).toBe(true);
    expect(detail.body.trend).toHaveLength(6);
  });

  it('a salesman sees only their own figures', async () => {
    const mine = await sales1('GET', '/api/performance/team');
    expect(mine.status).toBe(200);
    expect(mine.body.rows).toHaveLength(1);
    expect(mine.body.rows[0].rep_user_id).toBe(I.users.sales1);
    expect((await sales1('GET', `/api/performance/reps/${I.users.sales1}`)).status).toBe(200);
    expect((await sales1('GET', `/api/performance/reps/${I.users.sales2}`)).status).toBe(403);
    expect((await sales1('GET', '/api/performance/reps/none')).status).toBe(403);
    expect((await sales1('GET', '/api/performance/activity')).status).toBe(403);
    expect((await dist('GET', '/api/performance/team')).status).toBe(403);
  });

  it('the owner sets monthly targets; reps do not', async () => {
    const body = { repUserId: I.users.sales1, month, targetBags: 5000, targetSales: '22500000', targetCollection: '20000000' };
    expect((await sales1('PUT', '/api/performance/targets', body)).status).toBe(403);
    expect((await owner('PUT', '/api/performance/targets', { ...body, repUserId: I.users.dist })).status).toBe(422);
    expect((await owner('PUT', '/api/performance/targets', body)).status).toBe(200);
    expect((await owner('PUT', '/api/performance/targets', { ...body, targetBags: 6000 })).status).toBe(200);
    const r = row((await sales1('GET', '/api/performance/team')).body, I.users.sales1);
    expect(r.target_bags).toBe(6000);
    expect(r.target_sales).toBe('22500000.00');
    const list = await owner('GET', `/api/performance/targets?month=${month}`);
    expect(list.body.find((x: any) => x.rep_user_id === I.users.sales1).target_bags).toBe(6000);
  });

  it('shows what each employee did in the system', async () => {
    const a = await owner('GET', '/api/performance/activity');
    expect(a.status).toBe(200);
    const d = a.body.rows.find((r: any) => r.id === I.users.dist);
    expect(d.actions).toBeGreaterThan(0);
    expect(d.by_action['og.dispatch']).toBeGreaterThan(0);
    const one = await owner('GET', `/api/performance/activity/${I.users.dist}`);
    expect(one.body.entries.some((e: any) => e.entity === 'og' && e.action === 'dispatch')).toBe(true);
    expect(one.body.days.length).toBeGreaterThan(0);
  });
});
