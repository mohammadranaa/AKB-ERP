// The ledger's guarantees are enforced by the database itself. These tests talk to Postgres as
// akb_app (what the API uses) and try to break each rule.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Database, type Db } from '../src/db.js';
import { postEntry } from '../src/services/posting.js';
import { APP_URL } from './env.js';
import { ids, ownerQuery } from './helpers.js';

let db: Database;
let I: Awaited<ReturnType<typeof ids>>;
let firm: number;
const tx = <T>(fn: (c: Db) => Promise<T>) => db.tx({ userId: I.users.accounts!, role: 'accounts' }, fn);

beforeAll(async () => {
  db = new Database(APP_URL);
  I = await ids();
  firm = Number((await ownerQuery('select id from firms limit 1'))[0].id);
});
afterAll(async () => db.close());

const cash = () => I.accounts['1101']!;
const bank = () => I.accounts['1201']!;
const recv = () => I.accounts['1300']!;

async function simpleEntry(c: Db, date = '2026-10-05', amount = '1000.00') {
  return postEntry(c, {
    firmId: firm,
    businessDate: date,
    narration: 'test transfer',
    sourceType: 'test',
    createdBy: I.users.accounts!,
    lines: [
      { accountId: bank(), debit: amount },
      { accountId: cash(), credit: amount }
    ]
  });
}

describe('double entry', () => {
  it('rejects an entry whose debits and credits differ, at commit time', async () => {
    await expect(
      tx(async (c) => {
        const e = await c.query(
          "insert into journal_entries(firm_id, business_date, narration, source_type, created_by) values ($1,'2026-10-05','bad','test',$2) returning id",
          [firm, I.users.accounts]
        );
        await c.query("insert into journal_lines(entry_id, line_no, account_id, debit) values ($1,1,$2,100)", [e.rows[0].id, bank()]);
        await c.query("insert into journal_lines(entry_id, line_no, account_id, credit) values ($1,2,$2,99.99)", [e.rows[0].id, cash()]);
      })
    ).rejects.toThrow(/does not balance/);
  });

  it('rejects a single-line entry', async () => {
    await expect(
      tx(async (c) => {
        const e = await c.query(
          "insert into journal_entries(firm_id, business_date, narration, source_type, created_by) values ($1,'2026-10-05','one line','test',$2) returning id",
          [firm, I.users.accounts]
        );
        await c.query("insert into journal_lines(entry_id, line_no, account_id, debit) values ($1,1,$2,100)", [e.rows[0].id, bank()]);
      })
    ).rejects.toThrow(/at least two lines/);
  });

  it('rejects a line with both a debit and a credit', async () => {
    await expect(
      tx(async (c) => {
        const e = await c.query(
          "insert into journal_entries(firm_id, business_date, narration, source_type, created_by) values ($1,'2026-10-05','both','test',$2) returning id",
          [firm, I.users.accounts]
        );
        await c.query("insert into journal_lines(entry_id, line_no, account_id, debit, credit) values ($1,1,$2,100,100)", [e.rows[0].id, bank()]);
      })
    ).rejects.toThrow();
  });

  it('requires a party on receivable lines', async () => {
    await expect(
      tx((c) =>
        postEntry(c, {
          firmId: firm, businessDate: '2026-10-05', narration: 'no party', sourceType: 'test', createdBy: I.users.accounts!,
          lines: [{ accountId: recv(), debit: '10.00' }, { accountId: cash(), credit: '10.00' }]
        })
      )
    ).rejects.toThrow(/must name a party/);
  });

  it('refuses to post to a header account', async () => {
    await expect(
      tx((c) =>
        postEntry(c, {
          firmId: firm, businessDate: '2026-10-05', narration: 'header', sourceType: 'test', createdBy: I.users.accounts!,
          lines: [{ accountId: I.accounts['1200']!, debit: '10.00' }, { accountId: cash(), credit: '10.00' }]
        })
      )
    ).rejects.toThrow(/not open for posting/);
  });
});

describe('posted entries are permanent', () => {
  let entryId: string;
  beforeAll(async () => {
    entryId = (await tx((c) => simpleEntry(c))).id;
  });

  it('cannot be updated', async () => {
    await expect(tx((c) => c.query("update journal_entries set narration = 'changed' where id = $1", [entryId]))).rejects.toThrow(/cannot be changed/);
  });
  it('cannot be deleted', async () => {
    await expect(tx((c) => c.query('delete from journal_entries where id = $1', [entryId]))).rejects.toThrow(/cannot be deleted/);
  });
  it('lines cannot be changed', async () => {
    await expect(tx((c) => c.query('update journal_lines set debit = 5 where entry_id = $1 and debit > 0', [entryId]))).rejects.toThrow(/cannot be changed/);
  });
  it('lines cannot be added later', async () => {
    await expect(
      tx((c) => c.query("insert into journal_lines(entry_id, line_no, account_id, debit) values ($1, 99, $2, 1)", [entryId, bank()]))
    ).rejects.toThrow(/cannot be added/);
  });
  it('akb_app has no privilege to delete lines of other tables like the audit log', async () => {
    await expect(tx((c) => c.query('delete from audit_log'))).rejects.toThrow();
  });

  it('is corrected by a reversal that mirrors it, once', async () => {
    const revId = await tx(async (c) => (await c.query("select reverse_entry($1, $2, 'test correction', '2026-10-06') as id", [entryId, I.users.owner])).rows[0].id);
    const lines = await ownerQuery('select debit, credit, account_id from journal_lines where entry_id = $1 order by line_no', [revId]);
    expect(lines.map((l) => [l.debit, l.credit])).toEqual([['0.00', '1000.00'], ['1000.00', '0.00']]);
    const orig = await ownerQuery('select reversed_by from journal_entries where id = $1', [entryId]);
    expect(orig[0].reversed_by).toBe(revId);
    await expect(tx((c) => c.query("select reverse_entry($1, $2, 'again', '2026-10-06')", [entryId, I.users.owner]))).rejects.toThrow(/already reversed/);
    await expect(tx((c) => c.query("select reverse_entry($1, $2, 'reverse the reversal', '2026-10-06')", [revId, I.users.owner]))).rejects.toThrow(/cannot itself be reversed/);
  });
});

describe('numbering', () => {
  it('is gapless: a rolled-back posting does not use up a number', async () => {
    const a = await tx((c) => simpleEntry(c));
    await expect(
      tx(async (c) => {
        await simpleEntry(c);
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    const b = await tx((c) => simpleEntry(c));
    const n = (s: string | null) => Number(s!.split('-').pop());
    expect(n(b.entryNo)).toBe(n(a.entryNo) + 1);
    expect(a.entryNo).toMatch(/^JV-2627-\d{5}$/);
  });
});

describe('day locks', () => {
  it('blocks postings and stock movements on a locked day, and a locked day cannot reopen', async () => {
    await ownerQuery("insert into business_days(business_date, status, locked_at) values ('2026-10-02','locked',now())");
    await expect(tx((c) => simpleEntry(c, '2026-10-02'))).rejects.toThrow(/is locked/);
    await expect(
      tx((c) =>
        c.query(
          "insert into stock_movements(business_date, kind, product_id, branch_id, bags, ref_type, ref_id, created_by) values ('2026-10-02','receipt',$1,$2,10,'t','t',$3)",
          [I.products['CAN'], I.branches.PK, I.users.dist]
        )
      )
    ).rejects.toThrow(/is locked/);
    await expect(tx((c) => c.query("update business_days set status = 'open' where business_date = '2026-10-02'"))).rejects.toThrow(/cannot be reopened/);
  });
});

describe('stock', () => {
  it('cannot go below zero, and movements are append-only', async () => {
    await expect(
      tx((c) =>
        c.query(
          "insert into stock_movements(business_date, kind, product_id, branch_id, bags, ref_type, ref_id, created_by) values ('2026-10-05','dispatch',$1,$2,-999999,'t','t',$3)",
          [I.products['CAN'], I.branches.PK, I.users.dist]
        )
      )
    ).rejects.toThrow(/Not enough stock/);
    await expect(tx((c) => c.query('update stock_movements set bags = bags + 1'))).rejects.toThrow();
  });
});

describe('audit log', () => {
  it('is hash-chained and detects tampering', async () => {
    const ok = await ownerQuery('select audit_log_verify() as broken');
    expect(ok[0].broken).toBeNull();
    // Even the owner has to disable the trigger to edit history, and the chain then shows the break.
    await ownerQuery('alter table audit_log disable trigger audit_log_no_update');
    const target = (await ownerQuery('select id from audit_log order by id limit 1'))[0].id;
    await ownerQuery("update audit_log set action = 'tampered' where id = $1", [target]);
    const broken = await ownerQuery('select audit_log_verify() as broken');
    expect(broken[0].broken).toBe(target);
    await ownerQuery("update audit_log set action = 'seed' where id = $1", [target]);
    await ownerQuery('alter table audit_log enable trigger audit_log_no_update');
    expect((await ownerQuery('select audit_log_verify() as broken'))[0].broken).toBeNull();
  });
});

describe('row-level security', () => {
  it('a sales rep sees only their own customers, and nothing at all without a role', async () => {
    const mine = await db.tx({ userId: I.users.sales1!, role: 'sales' }, async (c) => (await c.query("select code from parties where kind = 'customer' order by code")).rows.map((r) => r.code));
    expect(mine).toEqual(['C001', 'C002', 'C003', 'C004']);
    const none = await db.pool.query('select count(*)::int as n from parties');
    expect(none.rows[0].n).toBe(0);
  });
});
