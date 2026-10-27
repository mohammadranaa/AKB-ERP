import { useEffect, useState, type ReactNode } from 'react';
import { BrowserRouter, HashRouter, MemoryRouter, Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { useSession } from './lib/session';
import { api } from './lib/api';
import { d, initials } from './lib/format';
import { Icon } from './components/icons';
import { DEMO } from './lib/demo';

// The demo copy is a single file opened from anywhere, so it keeps its place in the URL hash.
// A hosted demo page (published link) cannot use the address bar, so it keeps its place in memory.
const Router = DEMO ? (DEMO.router === 'memory' ? MemoryRouter : HashRouter) : BrowserRouter;
import { Login, AccountSetup } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { Approvals } from './pages/Approvals';
import { OgList, OgDetail } from './pages/Ogs';
import { NewOg } from './pages/NewOg';
import { DispatchQueue, GatePass } from './pages/Dispatch';
import { Stock, GoodsReceipts, Transfers } from './pages/Stock';
import { Receipts, NewReceipt } from './pages/Receipts';
import { Customers, CustomerDetail } from './pages/Customers';
import { Journals, JournalDetail, NewJournal, TrialBalance, AccountLedger } from './pages/Ledger';
import { DayClose } from './pages/DayClose';
import { Users, AuditLog, Masters } from './pages/Admin';
import { Finance } from './pages/Finance';

interface NavItem { to: string; label: string; perms: string[]; badge?: number }

function useNav(): { group: string; items: NavItem[] }[] {
  const { can } = useSession();
  const [pending, setPending] = useState(0);
  const canApprove = can('og.approve', 'journal.approve', 'reversal.approve', 'stock.adjust.approve');
  const loc = useLocation();
  useEffect(() => {
    if (!canApprove) return;
    api
      .get('/api/approvals')
      .then((a) => setPending(a.ogs.length + a.journals.length + a.reversals.length + a.adjustments.length))
      .catch(() => undefined);
  }, [canApprove, loc.pathname]);
  const groups: { group: string; items: NavItem[] }[] = [
    { group: 'Overview', items: [
      { to: '/dashboard', label: 'Dashboard', perms: ['dashboard.read'] },
      { to: '/approvals', label: 'Approvals', perms: ['og.approve', 'journal.approve', 'reversal.approve', 'stock.adjust.approve'], badge: pending }
    ] },
    { group: 'Sales', items: [
      { to: '/ogs', label: can('og.read') ? 'OGs' : 'My OGs', perms: ['og.read', 'og.read.own'] },
      { to: '/ogs/new', label: 'New OG', perms: ['og.create'] },
      { to: '/customers', label: can('og.read') ? 'Customers' : 'My customers', perms: ['money.read'] }
    ] },
    { group: 'Distribution', items: [
      { to: '/dispatch', label: 'Dispatch queue', perms: ['dispatch.create'] },
      { to: '/stock', label: 'Branch stock', perms: ['stock.read'] },
      { to: '/stock/receipts', label: 'Goods receipts', perms: ['stock.receive'] },
      { to: '/stock/transfers', label: 'Transfers', perms: ['stock.transfer'] }
    ] },
    { group: 'Accounts', items: [
      { to: '/receipts', label: 'Receipts', perms: ['receipt.read'] },
      { to: '/receipts/new', label: 'New receipt', perms: ['receipt.create'] },
      { to: '/days', label: 'Day close', perms: ['day.close'] }
    ] },
    { group: 'Ledger', items: [
      { to: '/ledger/journals', label: 'Journals', perms: ['ledger.read'] },
      { to: '/ledger/trial-balance', label: 'Trial balance', perms: ['ledger.read'] },
      { to: '/ledger/journals/new', label: 'New journal', perms: ['journal.create'] }
    ] },
    { group: 'Finance', items: [{ to: '/finance', label: 'Guarantees & banks', perms: ['dashboard.read'] }] },
    { group: 'Administration', items: [
      { to: '/admin/users', label: 'Users', perms: ['users.manage'] },
      { to: '/admin/masters', label: 'Products & parties', perms: ['masters.write'] },
      { to: '/admin/audit', label: 'Audit log', perms: ['audit.read'] }
    ] }
  ];
  return groups.map((g) => ({ ...g, items: g.items.filter((i) => can(...i.perms)) })).filter((g) => g.items.length);
}

function home(can: (...p: string[]) => boolean): string {
  if (can('dashboard.read')) return '/dashboard';
  if (can('og.create')) return '/ogs';
  if (can('dispatch.create')) return '/dispatch';
  if (can('receipt.create')) return '/receipts/new';
  if (can('users.manage')) return '/admin/users';
  if (can('stock.read')) return '/stock';
  return '/ogs';
}

const ROLE_LABEL: Record<string, string> = {
  owner: 'Owner / Director', finance: 'Finance', procurement: 'Procurement', sales: 'Sales rep',
  distribution: 'Distribution', accounts: 'Accounts', auditor: 'Auditor · read-only', admin: 'Admin'
};

/** Phone tab bar: the first four screens this person can use, in order of everyday use. */
const TAB_PRIORITY: { to: string; label: string; icon: string }[] = [
  { to: '/dashboard', label: 'Home', icon: 'home' },
  { to: '/dispatch', label: 'Dispatch', icon: 'truck' },
  { to: '/ogs', label: 'OGs', icon: 'list' },
  { to: '/ogs/new', label: 'New OG', icon: 'plus' },
  { to: '/receipts/new', label: 'Receive', icon: 'cash' },
  { to: '/approvals', label: 'Approve', icon: 'check' },
  { to: '/stock', label: 'Stock', icon: 'box' },
  { to: '/customers', label: 'Customers', icon: 'people' },
  { to: '/days', label: 'Day close', icon: 'lock' },
  { to: '/ledger/journals', label: 'Ledger', icon: 'book' },
  { to: '/admin/users', label: 'Users', icon: 'user' },
  { to: '/admin/audit', label: 'Audit', icon: 'shield' }
];

/**
 * On phones, tables are shown as cards. Each cell needs its column heading as a label;
 * this copies the heading text onto every cell whenever a table renders or changes.
 */
function useCardLabels() {
  useEffect(() => {
    const label = (root: ParentNode) => {
      root.querySelectorAll<HTMLTableElement>('table.t').forEach((t) => {
        const heads = [...t.querySelectorAll('thead th')].map((th) => th.textContent?.trim() ?? '');
        if (!heads.length) return;
        t.querySelectorAll('tbody tr, tfoot tr').forEach((tr) => {
          let col = 0;
          for (const td of [...tr.children] as HTMLTableCellElement[]) {
            const want = heads[col] ?? '';
            if (td.colSpan > 1) td.removeAttribute('data-label');
            else if (td.getAttribute('data-label') !== want) td.setAttribute('data-label', want);
            col += td.colSpan || 1;
          }
        });
      });
    };
    label(document);
    let queued = false;
    const obs = new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; label(document); });
    });
    obs.observe(document.body, { childList: true, subtree: true });
    return () => obs.disconnect();
  }, []);
}

function Shell({ children }: { children: ReactNode }) {
  const { me, signOut } = useSession();
  const nav = useNav();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  useCardLabels();
  useEffect(() => { setOpen(false); window.scrollTo(0, 0); }, [loc.pathname]);
  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [open]);
  const [theme, setTheme] = useState<string>(() => {
    try { return localStorage.getItem('akb.theme') ?? 'auto'; } catch { return 'auto'; }
  });
  useEffect(() => {
    if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
    try { localStorage.setItem('akb.theme', theme); } catch { /* ignore */ }
  }, [theme]);
  if (!me) return null;
  const allowed = nav.flatMap((g) => g.items);
  const badgeFor = (to: string) => allowed.find((i) => i.to === to)?.badge;
  const tabs = TAB_PRIORITY.filter((t) => allowed.some((i) => i.to === t.to)).slice(0, 4);
  const themeSelect = (cls: string) => (
    <select className={`input ${cls}`} style={{ width: 'auto', minHeight: 30 }} value={theme} onChange={(e) => setTheme(e.target.value)} aria-label="Theme">
      <option value="auto">Theme: system</option>
      <option value="light">Theme: light</option>
      <option value="dark">Theme: dark</option>
    </select>
  );
  return (
    <div className="shell">
      <div className={`drawer-backdrop${open ? ' open' : ''}`} onClick={() => setOpen(false)} />
      <aside className={`sidebar${open ? ' open' : ''}`} aria-label="Main menu">
        <div className="brand">
          <div className="brand-mark">A</div>
          <div>
            <div className="brand-name">AKB GROUP</div>
            <div className="brand-sub">Operations ERP</div>
          </div>
        </div>
        {nav.map((g) => (
          <div className="nav-group" key={g.group}>
            <div className="nav-group-title">{g.group}</div>
            {g.items.map((i) => (
              <NavLink key={i.to} to={i.to} end onClick={() => setOpen(false)} className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
                {i.label}
                {!!i.badge && <span className="nav-badge">{i.badge}</span>}
              </NavLink>
            ))}
          </div>
        ))}
        <div className="sidebar-foot">
          Business date
          <strong>{d(me.businessDate).toUpperCase()}</strong>
        </div>
        <div className="drawer-foot">
          <div><strong>{me.fullName}</strong><div className="small" style={{ color: '#94bce3' }}>{ROLE_LABEL[me.role] ?? me.role}</div></div>
          {themeSelect('')}
          <button className="btn" onClick={signOut}>Sign out</button>
        </div>
      </aside>
      <div className="main">
        <header className="topbar no-print">
          <button className="menu-btn" onClick={() => setOpen(!open)} aria-label="Open menu" aria-expanded={open}><Icon name="menu" /></button>
          <span className="topbar-brand menu-only">AKB</span>
          <span className="day-pill"><span className="dot" style={{ background: 'var(--green)' }} />{d(me.businessDate)}</span>
          <div className="spacer" />
          {themeSelect('hide-sm')}
          <div className="user-chip">
            <div className="avatar" title={me.fullName}>{initials(me.fullName)}</div>
            <div className="hide-sm">
              <div style={{ fontWeight: 600 }}>{me.fullName}</div>
              <div className="small muted">{ROLE_LABEL[me.role] ?? me.role}</div>
            </div>
          </div>
          <button className="btn btn-sm hide-sm" onClick={signOut}>Sign out</button>
        </header>
        {DEMO && <div className="demo-band no-print">Demo copy · made-up data · nothing is saved</div>}
        <main className="content">{children}</main>
        <nav className="tabbar no-print" aria-label="Quick links">
          {tabs.map((t) => (
            <NavLink key={t.to} to={t.to} end className={({ isActive }) => (isActive ? 'active' : '')}>
              <Icon name={t.icon} />
              {t.label}
              {!!badgeFor(t.to) && <span className="tab-badge">{badgeFor(t.to)}</span>}
            </NavLink>
          ))}
          <button onClick={() => setOpen(true)}><Icon name="more" />More</button>
        </nav>
      </div>
    </div>
  );
}

function Guard({ perms, children }: { perms: string[]; children: ReactNode }) {
  const { can } = useSession();
  if (!can(...perms)) return <div className="note note-amber">You do not have access to this screen.</div>;
  return <>{children}</>;
}

export function App() {
  const { me, ready, can } = useSession();
  if (!ready) return <div className="login"><div className="muted">Loading…</div></div>;
  if (!me) return <Login />;
  if (me.scope !== 'full') return <AccountSetup />;
  return (
    <Router>
      <Shell>
        <Routes>
          <Route path="/" element={<Navigate to={home(can)} replace />} />
          <Route path="/dashboard" element={<Guard perms={['dashboard.read']}><Dashboard /></Guard>} />
          <Route path="/approvals" element={<Approvals />} />
          <Route path="/ogs" element={<Guard perms={['og.read', 'og.read.own']}><OgList /></Guard>} />
          <Route path="/ogs/new" element={<Guard perms={['og.create']}><NewOg /></Guard>} />
          <Route path="/ogs/:id" element={<Guard perms={['og.read', 'og.read.own']}><OgDetail /></Guard>} />
          <Route path="/dispatch" element={<Guard perms={['dispatch.create']}><DispatchQueue /></Guard>} />
          <Route path="/dispatch/:id/gate-pass" element={<GatePass />} />
          <Route path="/stock" element={<Guard perms={['stock.read']}><Stock /></Guard>} />
          <Route path="/stock/receipts" element={<Guard perms={['stock.read']}><GoodsReceipts /></Guard>} />
          <Route path="/stock/transfers" element={<Guard perms={['stock.read']}><Transfers /></Guard>} />
          <Route path="/receipts" element={<Guard perms={['receipt.read']}><Receipts /></Guard>} />
          <Route path="/receipts/new" element={<Guard perms={['receipt.create']}><NewReceipt /></Guard>} />
          <Route path="/customers" element={<Guard perms={['money.read']}><Customers /></Guard>} />
          <Route path="/customers/:id" element={<Guard perms={['money.read']}><CustomerDetail /></Guard>} />
          <Route path="/ledger/journals" element={<Guard perms={['ledger.read']}><Journals /></Guard>} />
          <Route path="/ledger/journals/new" element={<Guard perms={['journal.create']}><NewJournal /></Guard>} />
          <Route path="/ledger/journals/:id" element={<Guard perms={['ledger.read']}><JournalDetail /></Guard>} />
          <Route path="/ledger/trial-balance" element={<Guard perms={['ledger.read']}><TrialBalance /></Guard>} />
          <Route path="/ledger/accounts/:id" element={<Guard perms={['ledger.read']}><AccountLedger /></Guard>} />
          <Route path="/days" element={<Guard perms={['day.close', 'ledger.read']}><DayClose /></Guard>} />
          <Route path="/finance" element={<Finance />} />
          <Route path="/admin/users" element={<Guard perms={['users.manage']}><Users /></Guard>} />
          <Route path="/admin/masters" element={<Guard perms={['masters.write']}><Masters /></Guard>} />
          <Route path="/admin/audit" element={<Guard perms={['audit.read']}><AuditLog /></Guard>} />
          <Route path="*" element={<div className="note">Page not found.</div>} />
        </Routes>
      </Shell>
    </Router>
  );
}
