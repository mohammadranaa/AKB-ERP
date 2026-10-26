// Demo data for development and testing. Every name and number here is invented.
// Refuses to run in production or on a database that already has users.
import pg from 'pg';
import { hashPassword } from '../auth.js';

export const DEMO_PASSWORD = 'Demo-Pass-2026';

export const DEMO_USERS = [
  { username: 'owner', fullName: 'Demo Owner', role: 'owner' },
  { username: 'accounts', fullName: 'Demo Accounts', role: 'accounts' },
  { username: 'accounts2', fullName: 'Demo Accounts Two', role: 'accounts' },
  { username: 'sales1', fullName: 'Demo Sales Rep One', role: 'sales' },
  { username: 'sales2', fullName: 'Demo Sales Rep Two', role: 'sales' },
  { username: 'dist', fullName: 'Demo Distribution', role: 'distribution' },
  { username: 'procure', fullName: 'Demo Procurement', role: 'procurement' },
  { username: 'finance', fullName: 'Demo Finance', role: 'finance' },
  { username: 'auditor', fullName: 'Demo Auditor', role: 'auditor' },
  { username: 'admin', fullName: 'Demo Admin', role: 'admin' }
] as const;

export async function seed(url: string, opts: { date: string; log?: (s: string) => void } = { date: '2026-10-01' }) {
  const log = opts.log ?? console.log;
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    const existing = await c.query('select count(*)::int as n from users');
    if (existing.rows[0].n > 0) throw new Error('Database already has users; seed only runs on an empty database');
    await c.query('begin');
    await c.query("select set_config('TimeZone', 'Asia/Karachi', true)");

    const firm = (await c.query("insert into firms(code, name) values ('AKB','AKB Group (demo)') returning id")).rows[0].id;

    const branches: Record<string, number> = {};
    for (const [code, en, ur, kind] of [
      ['PK', 'PK Godown', 'پی کے گودام', 'godown'],
      ['SWL', 'Sahiwal', 'ساہیوال', 'godown'],
      ['MUL', 'Multan', 'ملتان', 'godown'],
      ['BWP', 'Bahawalpur', 'بہاولپور', 'godown'],
      ['FSD', 'Faisalabad', 'فیصل آباد', 'godown'],
      ['HO', 'Head office', 'ہیڈ آفس', 'office']
    ] as const) {
      branches[code] = (await c.query('insert into branches(firm_id, code, name_en, name_ur, kind) values ($1,$2,$3,$4,$5) returning id', [firm, code, en, ur, kind])).rows[0].id;
    }

    const pw = await hashPassword(DEMO_PASSWORD);
    const users: Record<string, number> = {};
    for (const u of DEMO_USERS) {
      users[u.username] = (
        await c.query(
          'insert into users(username, full_name, role_code, password_hash, must_change_pw) values ($1,$2,$3,$4,false) returning id',
          [u.username, u.fullName, u.role, pw]
        )
      ).rows[0].id;
    }

    // Bank accounts under 1200.
    const bankParent = (await c.query("select id from accounts where code = '1200'")).rows[0].id;
    const banks: Record<string, number> = {};
    for (const [code, bank, no] of [
      ['1201', 'Allied Bank', '0011-0098-2231'],
      ['1202', 'Meezan Bank', '0230-0101-7766'],
      ['1203', 'Bank Alfalah', '1190-0045-8823'],
      ['1204', 'Habib Metro', '0067-2290-1104'],
      ['1205', 'Faysal Bank', '0402-7781-0012']
    ] as const) {
      const id = (await c.query("insert into accounts(code, name, type, parent_id, control) values ($1,$2,'asset',$3,'bank') returning id", [code, `${bank} ${no.slice(0, 4)}`, bankParent])).rows[0].id;
      await c.query('insert into bank_accounts(account_id, bank_name, account_title, account_no) values ($1,$2,$3,$4)', [id, bank, 'AKB Group (demo)', no]);
      banks[code] = id;
    }

    const products: Record<string, number> = {};
    for (const [code, en, ur, mk, nut, floor] of [
      ['SONA-U', 'Sona Urea', 'سونا یوریا', 'Fauji (FFC)', 'urea', '4400'],
      ['SARS-U', 'Sarsabz Urea', 'سرسبز یوریا', 'Fatima', 'urea', '4350'],
      ['ENG-U', 'Engro Urea', 'اینگرو یوریا', 'Engro', 'urea', '4380'],
      ['FFC-DAP', 'FFC DAP', 'ایف ایف سی ڈی اے پی', 'Fauji (FFC)', 'DAP', '11850'],
      ['SARS-NP', 'Sarsabz NP', 'سرسبز این پی', 'Fatima', 'NP', '8900'],
      ['BS-U', 'Babbar Sher Urea', 'ببر شیر یوریا', 'Pakarab', 'urea', '4300'],
      ['CAN', 'CAN', 'کین', 'Pakarab', 'CAN', '4950']
    ] as const) {
      products[code] = (await c.query('insert into products(code, name_en, name_ur, manufacturer, nutrient, floor_price) values ($1,$2,$3,$4,$5,$6) returning id', [code, en, ur, mk, nut, floor])).rows[0].id;
    }

    const parties: Record<string, number> = {};
    const customers = [
      ['C001', 'Yousaf Traders', 'یوسف ٹریڈرز', 'Lahore', '6000000', 'sales1'],
      ['C002', 'Saad Green Agri Mall', 'سعد گرین ایگری مال', 'Aminabad', '2000000', 'sales1'],
      ['C003', 'Haji Noor Adda Arooti', 'حاجی نور اڈا آڑھتی', 'Chishtian', '1000000', 'sales1'],
      ['C004', 'Kissan Dost Traders', 'کسان دوست ٹریڈرز', 'Sahiwal', '1500000', 'sales1'],
      ['C005', 'Al-Rehman Agro', 'الرحمان ایگرو', 'Bahawalpur', '12000000', 'sales2'],
      ['C006', 'Malik Fertilizer House', 'ملک فرٹیلائزر ہاؤس', 'Rahim Yar Khan', '12000000', 'sales2'],
      ['C007', 'Chaudhry Khad Store', 'چوہدری کھاد سٹور', 'Multan', '3000000', 'sales2']
    ] as const;
    for (const [code, en, ur, city, limit, rep] of customers) {
      parties[code] = (
        await c.query(
          "insert into parties(code, kind, name_en, name_ur, city, credit_limit, credit_days, rep_user_id) values ($1,'customer',$2,$3,$4,$5,30,$6) returning id",
          [code, en, ur, city, limit, users[rep]]
        )
      ).rows[0].id;
    }
    for (const [code, kind, en] of [
      ['S001', 'supplier', 'Fatima Fertilizer'],
      ['S002', 'supplier', 'Fauji Fertilizer (FFC)'],
      ['S003', 'supplier', 'Engro Fertilizers'],
      ['S004', 'supplier', 'Pakarab Fertilizers'],
      ['T001', 'transporter', 'Al-Madina Goods Transport'],
      ['T002', 'transporter', 'Bismillah Cargo Service']
    ] as const) {
      parties[code] = (await c.query('insert into parties(code, kind, name_en) values ($1,$2,$3) returning id', [code, kind, en])).rows[0].id;
    }

    // Opening stock.
    const opening: [string, string, number][] = [
      ['SONA-U', 'PK', 4200], ['SONA-U', 'SWL', 3100], ['SONA-U', 'MUL', 2600], ['SONA-U', 'BWP', 1800], ['SONA-U', 'FSD', 2900],
      ['SARS-U', 'PK', 3800], ['SARS-U', 'SWL', 1200], ['SARS-U', 'MUL', 2200], ['SARS-U', 'FSD', 2400],
      ['ENG-U', 'PK', 2100], ['ENG-U', 'SWL', 900], ['ENG-U', 'BWP', 1300], ['ENG-U', 'FSD', 1700],
      ['FFC-DAP', 'PK', 1600], ['FFC-DAP', 'SWL', 2400], ['FFC-DAP', 'MUL', 1100], ['FFC-DAP', 'FSD', 1200],
      ['SARS-NP', 'PK', 900], ['SARS-NP', 'SWL', 600], ['SARS-NP', 'BWP', 500],
      ['BS-U', 'PK', 1200], ['BS-U', 'SWL', 800], ['BS-U', 'BWP', 400],
      ['CAN', 'PK', 600], ['CAN', 'SWL', 450], ['CAN', 'MUL', 300]
    ];
    for (const [p, b, bags] of opening) {
      await c.query(
        "insert into stock_movements(business_date, kind, product_id, branch_id, bags, ref_type, ref_id, note, created_by) values ($1,'opening',$2,$3,$4,'opening','OPENING','Opening stock (demo)',$5)",
        [opts.date, products[p], branches[b], bags, users.admin]
      );
    }

    // Opening balances: cash, banks, and a few customers who already owe money.
    const acc = async (code: string) => (await c.query('select id from accounts where code = $1', [code])).rows[0].id as number;
    const entry = (await c.query(
      "insert into journal_entries(firm_id, business_date, narration, source_type, status, created_by, approved_by, approved_at) values ($1,$2,'Opening balances (demo)','opening','posted',$3,$3,now()) returning id",
      [firm, opts.date, users.admin]
    )).rows[0].id;
    const lines: [number, string, string, number | null][] = [
      [await acc('1101'), '625000.00', '0', null],
      [banks['1201']!, '21455300.00', '0', null],
      [banks['1202']!, '3434450.00', '0', null],
      [banks['1203']!, '10244900.00', '0', null],
      [banks['1204']!, '4118600.00', '0', null],
      [banks['1205']!, '8620150.00', '0', null],
      [await acc('1300'), '2850000.00', '0', parties.C001!],
      [await acc('1300'), '640000.00', '0', parties.C002!],
      [await acc('1300'), '1250000.00', '0', parties.C005!]
    ];
    let total = 0;
    let n = 1;
    for (const [a, d, cr, party] of lines) {
      await c.query('insert into journal_lines(entry_id, line_no, account_id, debit, credit, party_id) values ($1,$2,$3,$4,$5,$6)', [entry, n++, a, d, cr, party]);
      total += Number(d);
    }
    await c.query('insert into journal_lines(entry_id, line_no, account_id, debit, credit) values ($1,$2,$3,0,$4)', [entry, n, await acc('3300'), total.toFixed(2)]);

    await c.query("insert into audit_log(user_id, action, entity, entity_id, detail) values ($1,'seed','database',null,'{\"demo\":true}')", [users.admin]);
    await c.query('commit');
    log(`Seeded demo data. Sign in as owner / ${DEMO_PASSWORD} (other users: ${DEMO_USERS.map((u) => u.username).join(', ')})`);
    return { firm, branches, users, products, parties, banks };
  } catch (err) {
    await c.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    await c.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.env.NODE_ENV === 'production') {
    console.error('Refusing to load demo data in production');
    process.exit(1);
  }
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) {
    console.error('Set MIGRATION_DATABASE_URL (the akb_owner connection)');
    process.exit(1);
  }
  const date = process.env.SEED_DATE ?? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(new Date());
  seed(url, { date }).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
