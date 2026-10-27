#!/usr/bin/env node
// Builds a single-file, read-only demo of AKB ERP that opens on any phone or computer with no server.
// It records what each demo user sees from a running API (DEMO DATA ONLY), then bundles the screens,
// fonts and that recording into one HTML file.
//
//   1. Start the system with demo data (never point this at real company data).
//   2. node tools/build-demo.mjs [--api http://localhost:4000] [--out dist-demo/akb-erp-demo.html]
//
// It refuses to run if the database has users other than the demo ones, so real data cannot leak into the file.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : def;
};
const API = arg('--api', 'http://localhost:4000');
const OUT = resolve(root, arg('--out', 'dist-demo/akb-erp-demo.html'));
const ROUTER = process.argv.includes('--memory-router') ? 'memory' : 'hash';
const PASSWORD = 'Demo-Pass-2026';
const DEMO_USERS = ['owner', 'accounts', 'accounts2', 'sales1', 'sales2', 'dist', 'procure', 'finance', 'auditor', 'admin'];
const ROLE_LABEL = {
  owner: 'Owner / Director', finance: 'Finance', procurement: 'Procurement', sales: 'Sales rep',
  distribution: 'Distribution', accounts: 'Accounts', auditor: 'Auditor', admin: 'Admin'
};

// ---------------- 1. record ----------------
async function session(username) {
  const r = await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password: PASSWORD }) });
  const j = await r.json();
  if (!r.ok || !j.token) throw new Error(`Cannot sign in as demo user ${username}: ${j.message ?? r.status}. Is the API running with demo data?`);
  return j.token;
}

const bodies = new Map(); // hash -> body (shared between users)
async function record(username) {
  const token = await session(username);
  const gets = {};
  const get = async (path) => {
    if (path in gets) return bodies.get(gets[path]);
    const r = await fetch(API + path, { headers: { authorization: `Bearer ${token}` } });
    if (!r.ok) return null;
    const body = await r.json();
    const h = createHash('sha1').update(JSON.stringify(body)).digest('hex').slice(0, 12);
    bodies.set(h, body);
    gets[path] = h;
    return body;
  };
  const me = await get('/api/auth/me');
  const lists = [
    '/api/dashboard', '/api/approvals', '/api/dispatch-queue', '/api/ogs',
    ...['all', 'awaiting', 'unpaid', 'unpurchased', 'held'].map((v) => `/api/ogs?view=${v}`),
    '/api/stock/matrix', '/api/stock/goods-receipts', '/api/stock/transfers', '/api/receipts',
    '/api/parties', '/api/parties?active=true',
    ...['customer', 'supplier', 'transporter', 'tenant', 'employee', 'other'].flatMap((k) => [`/api/parties?kind=${k}`, `/api/parties?active=true&kind=${k}`]),
    '/api/products', '/api/branches', '/api/accounts', '/api/cost-centres', '/api/money-accounts', '/api/users/reps',
    '/api/ledger/journals', '/api/ledger/trial-balance', `/api/ledger/trial-balance?asOf=${me.businessDate}`,
    '/api/admin/users', '/api/admin/roles', '/api/admin/audit', '/api/admin/audit?limit=300', '/api/admin/audit/verify'
  ];
  for (const p of lists) await get(p);

  for (const o of (await get('/api/ogs')) ?? []) {
    const og = await get(`/api/ogs/${o.id}`);
    for (const d of og?.dispatches ?? []) await get(`/api/dispatches/${d.id}`);
  }
  for (const p of (await get('/api/parties')) ?? []) {
    await get(`/api/parties/${p.id}`);
    await get(`/api/parties/${p.id}/statement`);
    if (p.kind === 'customer') {
      await get(`/api/ogs?customerId=${p.id}`);
      await get(`/api/receipts/open-ogs?partyId=${p.id}`);
    }
  }
  for (const j of (await get('/api/ledger/journals')) ?? []) await get(`/api/ledger/journals/${j.id}`);
  for (const a of (await get('/api/accounts')) ?? []) if (a.postable) await get(`/api/ledger/accounts/${a.id}/ledger`);
  const m = await get('/api/stock/matrix');
  for (const pr of m?.products ?? []) for (const b of m.branches) await get(`/api/stock/movements?branchId=${b.id}&productId=${pr.id}`);
  const end = Date.parse(me.businessDate);
  for (let t = end - 45 * 86400000; t <= end; t += 86400000) await get(`/api/days/${new Date(t).toISOString().slice(0, 10)}`);
  return { me, gets };
}

// Safety: only ever demo data.
{
  const token = await session('admin');
  const r = await fetch(`${API}/api/admin/users`, { headers: { authorization: `Bearer ${token}` } });
  const users = await r.json();
  const others = users.filter((u) => !DEMO_USERS.includes(u.username));
  if (others.length) {
    console.error(`Refusing: this database has non-demo users (${others.map((u) => u.username).join(', ')}). Build the demo from demo data only.`);
    process.exit(1);
  }
}

const users = [];
const gets = {};
for (const u of DEMO_USERS) {
  process.stdout.write(`recording ${u}… `);
  const r = await record(u);
  users.push({ username: u, fullName: r.me.fullName, role: r.me.role, roleLabel: ROLE_LABEL[r.me.role] ?? r.me.role });
  gets[u] = r.gets;
  console.log(`${Object.keys(r.gets).length} views`);
}

// ---------------- 2. build the screens ----------------
const tmp = join(root, 'dist-demo', '.build');
rmSync(tmp, { recursive: true, force: true });
execFileSync('pnpm', ['--filter', '@akb/client', 'exec', 'vite', 'build', '--base', './', '--outDir', tmp, '--emptyOutDir'], { cwd: root, stdio: 'inherit' });

// ---------------- 3. inline everything into one file ----------------
let html = readFileSync(join(tmp, 'index.html'), 'utf8');
const assets = join(tmp, 'assets');
const fontsDir = join(root, 'apps/client/public/fonts');
const dataUri = (file, type) => `data:${type};base64,${readFileSync(file).toString('base64')}`;

for (const f of readdirSync(assets)) {
  const p = join(assets, f);
  if (f.endsWith('.css')) {
    let css = readFileSync(p, 'utf8').replace(/url\((['"]?)(?:\.\.?)?\/fonts\/([^'")]+)\1\)/g, (_m, _q, name) => `url(${dataUri(join(fontsDir, name), 'font/woff2')})`);
    css = css.replace(/<\/style/gi, '<\\/style');
    html = html.replace(new RegExp(`<link[^>]+href="\\./assets/${f.replace('.', '\\.')}"[^>]*>`), () => `<style>${css}</style>`);
  }
}
const iconUri = dataUri(join(root, 'apps/client/public/icon-192.png'), 'image/png');
html = html
  .replace(/<link rel="manifest"[^>]*>\s*/, '')
  .replace(/<link rel="icon"[^>]*>/, `<link rel="icon" type="image/png" href="${iconUri}" />`)
  .replace(/<link rel="apple-touch-icon"[^>]*>/, `<link rel="apple-touch-icon" href="${iconUri}" />`)
  .replace('<title>AKB ERP</title>', '<title>AKB ERP Demo</title>');

const data = { builtAt: new Date().toISOString(), password: PASSWORD, users, bodies: Object.fromEntries(bodies), gets };
const json = JSON.stringify(data).replace(/</g, '\\u003c');
const dataScript = `<script>(function(){var d=${json};var g={};for(var u in d.gets){g[u]={};for(var p in d.gets[u])g[u][p]=d.bodies[d.gets[u][p]];}window.__AKB_DEMO__={builtAt:d.builtAt,password:d.password,users:d.users,gets:g,router:'${ROUTER}'};})();</script>`;

for (const f of readdirSync(assets)) {
  if (!f.endsWith('.js')) continue;
  const js = readFileSync(join(assets, f), 'utf8').replace(/<\/script/gi, '<\\/script');
  html = html.replace(new RegExp(`<script type="module" crossorigin src="\\./assets/${f.replace('.', '\\.')}"></script>`), () => `${dataScript}\n<script type="module">${js}</script>`);
}
if (/src="\.\/assets|href="\.\/assets/.test(html) || /url\((['"]?)(\.\.?)?\/fonts\//.test(html)) throw new Error('Some assets were not inlined');

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, html);
rmSync(tmp, { recursive: true, force: true });
console.log(`\nDemo written: ${OUT} (${(html.length / 1024 / 1024).toFixed(1)} MB). Open it in any browser; it needs no server.`);
if (!existsSync(OUT)) process.exit(1);
