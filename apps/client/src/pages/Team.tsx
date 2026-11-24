// Salesman performance (sales, collections, targets) and what each employee has done in the system.
import { useEffect, useState } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, qs } from '../lib/api';
import { bags, d, dt, rs, rsShort } from '../lib/format';
import { amountInput, fromP, toP } from '../lib/money';
import { useSession } from '../lib/session';
import { Dialog, Empty, ErrorBox, Field, FormError, Kpi, Loading, PageHead, Panel, PaymentPill, FulfilmentPill, useApi, useSubmitKey, useToast } from '../components/ui';

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (m: string) => `${MON[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;

/** Whole-number percentage of a target, from strings or numbers, without floating-point money. */
function pct(actual: string | number | null | undefined, target: string | number | null | undefined): number | null {
  const t = toP(String(target ?? '0'));
  if (t <= 0n) return null;
  return Number((toP(String(actual ?? '0')) * 100n) / t);
}

function Progress({ actual, target, money }: { actual: string | number; target: string | number | null | undefined; money?: boolean }) {
  const p = pct(actual, target);
  if (p === null) return null;
  const color = p >= 100 ? 'var(--green)' : p >= 70 ? 'var(--a500)' : 'var(--amber-tx)';
  return (
    <div title={`Target ${money ? rs(String(target)) : bags(target as number)}`} style={{ marginTop: 4 }}>
      <div style={{ height: 5, background: 'var(--divider)', width: '100%', minWidth: 70 }}>
        <div style={{ height: 5, width: `${Math.min(p, 100)}%`, background: color }} />
      </div>
      <div className="small muted">{p}% of {money ? rsShort(String(target)) : `${bags(target as number)} bags`}</div>
    </div>
  );
}

function useMonth(): [string, (m: string) => void] {
  const { me } = useSession();
  const [params, setParams] = useSearchParams();
  const month = params.get('month') ?? me!.businessDate.slice(0, 7);
  return [month, (m) => setParams(m ? { month: m } : {}, { replace: true })];
}

export function SalesTeam() {
  const { can, me } = useSession();
  const nav = useNavigate();
  const [month, setMonth] = useMonth();
  const team = useApi(() => api.get(`/api/performance/team${qs({ month })}`), [month]);
  const [targets, setTargets] = useState(false);
  if (!can('team.read')) return <Navigate to={`/team/reps/${me!.id}?month=${month}`} replace />;
  const rows: any[] = team.data?.rows ?? [];
  const sum = (k: string) => fromP(rows.reduce((s, r) => s + toP(String(r[k] ?? '0')), 0n));
  const sumN = (k: string) => rows.reduce((s, r) => s + Number(r[k] ?? 0), 0);
  const maxValue = rows.reduce((m, r) => (toP(r.sales_value) > m ? toP(r.sales_value) : m), 0n);
  return (
    <>
      <PageHead kicker="Team" title="Sales team" sub="Sales are credited to the customer's sales rep on each OG; collections to the rep on each receipt. Figures come straight from the books.">
        <input type="month" className="input" style={{ width: 'auto' }} value={month} max={me!.businessDate.slice(0, 7)} onChange={(e) => setMonth(e.target.value)} aria-label="Month" />
        {can('targets.manage') && <button className="btn btn-primary" onClick={() => setTargets(true)}>Set targets</button>}
      </PageHead>
      {team.loading && !team.data ? <Loading /> : team.error ? <ErrorBox error={team.error} onRetry={team.reload} /> : (
        <>
          <div className="small muted" style={{ marginBottom: 10 }}>{d(team.data.from)} to {d(team.data.to)}{team.data.to < team.data.monthEnd ? ' (month to date)' : ''}</div>
          <div className="grid4" style={{ marginBottom: 16 }}>
            <Kpi label="Bags sold (dispatched)" value={bags(sumN('bags_sold'))} sub={`${bags(sumN('bags_booked'))} bags booked on ${sumN('ogs_booked')} OGs`} />
            <Kpi label="Sales value" value={rsShort(sum('sales_value'))} sub="goods and freight charged, less discounts" />
            <Kpi label="Collected" value={rsShort(sum('collected'))} sub={`${sumN('receipts')} receipts`} />
            <Kpi label="Customers owe" value={rsShort(sum('receivable'))} sub={`overdue ${rsShort(sum('overdue'))} on ${sumN('overdue_ogs')} OGs`} warn={toP(sum('overdue')) > 0n} />
          </div>
          <Panel pad={false}>
            <div className="table-wrap">
              <table className="t">
                <thead><tr><th>Sales rep</th><th className="num">OGs booked</th><th>Bags sold</th><th>Sales value</th><th>Collected</th><th className="num">Customers owe</th><th className="num">Overdue</th><th className="num">Customers</th></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.rep_user_id ?? 'none'} className={r.active ? '' : 'muted'} style={{ cursor: 'pointer' }} onClick={() => nav(`/team/reps/${r.rep_user_id ?? 'none'}?month=${month}`)}>
                      <td>
                        <Link to={`/team/reps/${r.rep_user_id ?? 'none'}?month=${month}`} onClick={(e) => e.stopPropagation()}>{r.full_name}</Link>
                        {r.ogs_waiting > 0 && <div className="small muted">{r.ogs_waiting} OG{r.ogs_waiting > 1 ? 's' : ''} waiting for approval</div>}
                        {maxValue > 0n && <div style={{ height: 4, marginTop: 4, background: 'var(--a800)', width: `${Number((toP(r.sales_value) * 100n) / maxValue)}%` }} />}
                      </td>
                      <td className="num">{r.ogs_booked}<div className="small muted">{bags(r.bags_booked)} bags</div></td>
                      <td>{bags(r.bags_sold)}<Progress actual={r.bags_sold} target={r.target_bags} /></td>
                      <td>{rs(r.sales_value, { keepZero: true })}<Progress actual={r.sales_value} target={r.target_sales} money /></td>
                      <td>{rs(r.collected, { keepZero: true })}<Progress actual={r.collected} target={r.target_collection} money /></td>
                      <td className="num">{rs(r.receivable, { keepZero: true })}</td>
                      <td className="num" style={toP(r.overdue) > 0n ? { color: 'var(--red-tx)' } : undefined}>{toP(r.overdue) > 0n ? <>{rs(r.overdue)}<div className="small">{r.overdue_ogs} OGs</div></> : '—'}</td>
                      <td className="num">{r.rep_user_id ? r.customers : '—'}{r.new_customers > 0 && <div className="small muted">+{r.new_customers} new</div>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </>
      )}
      {targets && <TargetsDialog month={month} onClose={() => setTargets(false)} onSaved={team.reload} />}
    </>
  );
}

function TargetsDialog({ month, onClose, onSaved }: { month: string; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const key = useSubmitKey();
  const list = useApi(() => api.get(`/api/performance/targets${qs({ month })}`), [month]);
  const [f, setF] = useState<Record<number, { bags: string; sales: string; collection: string }>>({});
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const next: typeof f = {};
    for (const r of list.data ?? []) {
      next[r.rep_user_id] = {
        bags: r.target_bags ? String(r.target_bags) : '',
        sales: r.target_sales && toP(r.target_sales) ? fromP(toP(r.target_sales)).replace(/\.00$/, '') : '',
        collection: r.target_collection && toP(r.target_collection) ? fromP(toP(r.target_collection)).replace(/\.00$/, '') : ''
      };
    }
    setF(next);
  }, [list.data]);
  const set = (id: number, k: 'bags' | 'sales' | 'collection', v: string) => setF({ ...f, [id]: { ...f[id]!, [k]: v } });
  return (
    <Dialog title={`Targets for ${monthLabel(month)}`} onClose={onClose} wide>
      {list.loading && !list.data ? <Loading /> : (
        <table className="t">
          <thead><tr><th>Sales rep</th><th className="num">Bags</th><th className="num">Sales value (Rs)</th><th className="num">Collections (Rs)</th></tr></thead>
          <tbody>
            {(list.data ?? []).map((r: any) => (
              <tr key={r.rep_user_id}>
                <td>{r.full_name}{r.set_by_name && <div className="small muted">set by {r.set_by_name}</div>}</td>
                <td><input className="input num" style={{ width: 100 }} value={f[r.rep_user_id]?.bags ?? ''} onChange={(e) => set(r.rep_user_id, 'bags', e.target.value.replace(/\D/g, ''))} /></td>
                <td><input className="input num" style={{ width: 150 }} value={f[r.rep_user_id]?.sales ?? ''} onChange={(e) => set(r.rep_user_id, 'sales', amountInput(e.target.value))} /></td>
                <td><input className="input num" style={{ width: 150 }} value={f[r.rep_user_id]?.collection ?? ''} onChange={(e) => set(r.rep_user_id, 'collection', amountInput(e.target.value))} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="small muted">Leave a box empty for no target. Targets can be changed during the month; every change is kept in the audit log.</div>
      <FormError error={err} />
      <div className="dialog-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !list.data} onClick={async () => {
          setBusy(true);
          setErr(null);
          try {
            for (const r of list.data ?? []) {
              const v = f[r.rep_user_id];
              if (!v) continue;
              const changed = (Number(v.bags || 0) !== Number(r.target_bags ?? 0)) || toP(v.sales) !== toP(r.target_sales ?? '0') || toP(v.collection) !== toP(r.target_collection ?? '0');
              if (!changed) continue;
              await api.put('/api/performance/targets', {
                repUserId: r.rep_user_id, month, targetBags: Number(v.bags || 0), targetSales: fromP(toP(v.sales)), targetCollection: fromP(toP(v.collection))
              }, `${key.key()}-${r.rep_user_id}`);
            }
            key.renew();
            toast('Targets saved');
            onSaved();
            onClose();
          } catch (e) { setErr(e); } finally { setBusy(false); }
        }}>Save targets</button>
      </div>
    </Dialog>
  );
}

export function RepPerformance() {
  const { id } = useParams();
  const { can } = useSession();
  const [month, setMonth] = useMonth();
  const { me } = useSession();
  const r = useApi(() => api.get(`/api/performance/reps/${id}${qs({ month })}`), [id, month]);
  if (r.loading && !r.data) return <Loading />;
  if (r.error) return <ErrorBox error={r.error} onRetry={r.reload} />;
  const x = r.data;
  const s = x.summary ?? {};
  const maxTrend = x.trend.reduce((m: bigint, t: any) => (toP(t.sales_value) > m ? toP(t.sales_value) : m), 1n);
  const own = me!.id === x.rep.id;
  return (
    <>
      <PageHead kicker={can('team.read') ? 'Sales team' : 'My performance'} title={own && !can('team.read') ? 'My performance' : x.rep.full_name}
        sub={<>{d(x.from)} to {d(x.to)}{x.to < x.monthEnd ? ' (month to date)' : ''}{can('team.read') && <> · <Link to={`/team?month=${month}`}>All reps</Link></>}</>}>
        <input type="month" className="input" style={{ width: 'auto' }} value={month} max={me!.businessDate.slice(0, 7)} onChange={(e) => setMonth(e.target.value)} aria-label="Month" />
      </PageHead>
      <div className="grid4" style={{ marginBottom: 16 }}>
        <div className="kpi"><div className="label">Bags sold</div><div className="value">{bags(s.bags_sold ?? 0)}</div><Progress actual={s.bags_sold ?? 0} target={s.target_bags} /><div className="sub">{s.ogs_booked ?? 0} OGs booked · {bags(s.bags_booked ?? 0)} bags</div></div>
        <div className="kpi"><div className="label">Sales value</div><div className="value">{rsShort(s.sales_value ?? '0')}</div><Progress actual={s.sales_value ?? '0'} target={s.target_sales} money /><div className="sub">{s.buying_customers ?? 0} customers bought</div></div>
        <div className="kpi"><div className="label">Collected</div><div className="value">{rsShort(s.collected ?? '0')}</div><Progress actual={s.collected ?? '0'} target={s.target_collection} money /><div className="sub">{s.receipts ?? 0} receipts</div></div>
        <Kpi label="Customers owe" value={rsShort(s.receivable ?? '0')} sub={`overdue ${rsShort(s.overdue ?? '0')} · ${s.customers ?? 0} customers${s.new_customers ? ` · ${s.new_customers} new` : ''}`} warn={toP(s.overdue ?? '0') > 0n} />
      </div>

      <div className="grid2" style={{ marginBottom: 16 }}>
        <Panel title="Last six months">
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, height: 150 }}>
            {x.trend.map((t: any) => {
              const h = Number((toP(t.sales_value) * 100n) / maxTrend);
              const p = pct(t.sales_value, t.target_sales);
              return (
                <div key={t.month} style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', height: '100%' }}
                  title={`${monthLabel(t.month)}: ${bags(t.bags)} bags · ${rs(t.sales_value)} sold · ${rs(t.collected)} collected${p !== null ? ` · ${p}% of target` : ''}`}>
                  <div style={{ height: `${h}%`, minHeight: 2, background: t.month === month ? 'var(--accent)' : 'var(--a800)' }} />
                </div>
              );
            })}
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 6 }}>
            {x.trend.map((t: any) => <div key={t.month} className="small muted" style={{ flex: 1, textAlign: 'center' }}>{MON[Number(t.month.slice(5, 7)) - 1]}<div>{bags(t.bags)}</div></div>)}
          </div>
        </Panel>
        <Panel title="By product" pad={false}>
          {!x.byProduct.length ? <Empty>Nothing dispatched this month.</Empty> : (
            <table className="t">
              <thead><tr><th>Product</th><th className="num">Bags</th><th className="num">Goods value</th></tr></thead>
              <tbody>{x.byProduct.map((p: any) => <tr key={p.id}><td>{p.name_en}</td><td className="num">{bags(p.bags)}</td><td className="num">{rs(p.goods_value)}</td></tr>)}</tbody>
            </table>
          )}
        </Panel>
      </div>

      <div className="stack">
        <Panel title="Customers" pad={false}>
          {!x.byCustomer.length ? <Empty>No customers.</Empty> : (
            <div className="table-wrap">
              <table className="t">
                <thead><tr><th>Customer</th><th>Sale point</th><th className="num">Bags this month</th><th className="num">Sales value</th><th className="num">Collected</th><th className="num">Owes now</th><th className="num">Overdue</th><th>Last order</th></tr></thead>
                <tbody>
                  {x.byCustomer.map((c: any) => (
                    <tr key={c.id} className={c.active ? '' : 'muted'}>
                      <td><Link to={`/customers/${c.id}`}>{c.name_en}</Link> <span className="small muted">{c.code}{c.city ? ` · ${c.city}` : ''}</span>{c.is_new && <span className="chip chip-green" style={{ marginLeft: 6 }}>New</span>}</td>
                      <td className="small">{c.sale_point ?? '—'}</td>
                      <td className="num">{c.bags ? bags(c.bags) : '—'}</td>
                      <td className="num">{toP(c.sales_value) ? rs(c.sales_value) : '—'}</td>
                      <td className="num">{toP(c.collected) ? rs(c.collected) : '—'}</td>
                      <td className="num">{toP(c.balance) > 0n ? rs(c.balance) : toP(c.balance) < 0n ? <span className="muted">advance {rs(fromP(-toP(c.balance)))}</span> : '—'}</td>
                      <td className="num" style={toP(c.overdue) > 0n ? { color: 'var(--red-tx)' } : undefined}>{toP(c.overdue) > 0n ? rs(c.overdue) : '—'}</td>
                      <td className="small">{c.last_order ? d(c.last_order) : 'Never'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
        <Panel title="OGs booked this month" pad={false}>
          {!x.ogs.length ? <Empty>No OGs this month.</Empty> : (
            <div className="table-wrap">
              <table className="t">
                <thead><tr><th>OG</th><th>Date</th><th>Customer</th><th className="num">Bags</th><th className="num">Value</th><th>Status</th><th className="num">Outstanding</th></tr></thead>
                <tbody>
                  {x.ogs.map((o: any) => (
                    <tr key={o.id}>
                      <td><Link to={`/ogs/${o.id}`}>{o.og_no}</Link></td><td>{d(o.business_date)}</td><td>{o.customer_name}</td>
                      <td className="num">{bags(o.bags)}</td><td className="num">{rs(o.total_value)}</td>
                      <td><FulfilmentPill s={o.fulfilment} /> {o.status === 'approved' && <PaymentPill s={o.payment} />}</td>
                      <td className="num">{o.status === 'approved' && toP(o.outstanding) > 0n ? rs(o.outstanding) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}

// ---------------- Employee activity ----------------
const ACTION_LABEL: Record<string, string> = {
  'og.create': 'OGs entered', 'og.submit': 'OGs sent for approval', 'og.update': 'OGs edited', 'og.cancel': 'OGs cancelled', 'og.dispatch': 'Trucks dispatched',
  'og.allocate': 'Receipts matched to OGs', 'og.auto_approve': 'OGs approved automatically', 'receipt.create': 'Customer receipts', 'receipt.cheque_return': 'Cheques returned',
  'party.create': 'Customers / parties added', 'party.update': 'Customers / parties edited', 'goods_receipt.create': 'Goods received', 'transfer.send': 'Transfers sent',
  'transfer.receive': 'Transfers received', 'stock_adjustment.request': 'Stock adjustments requested', 'payment_voucher.create': 'Payment vouchers',
  'receipt_voucher.create': 'Receipt vouchers', 'voucher.attach': 'Proofs attached', 'payment_voucher.allocate': 'Payments allocated to orders',
  'company_order.create': 'Company orders booked', 'company_order.update': 'Company orders edited', 'company_invoice.create': 'Company invoices',
  'journal.submit': 'Journals entered', 'journal.approve': 'Journals approved', 'journal.reject': 'Journals sent back', 'journal.request_reversal': 'Reversals requested',
  'reversal_request.approve': 'Reversals approved', 'business_day.lock': 'Days closed', 'opening_voucher.submit': 'Opening balances entered',
  'sales_target.create': 'Targets set', 'sales_target.update': 'Targets changed', 'account.create': 'Ledger accounts added', 'account.update': 'Ledger accounts edited',
  'sale_point.create': 'Sale points added', 'dealer_code.create': 'Dealer codes added', 'company_order.close': 'Company orders closed', 'database.seed': 'Demo data loaded'
};
const actionLabel = (k: string) => ACTION_LABEL[k] ?? k.replace(/[._]/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
const ROLE: Record<string, string> = { owner: 'Owner', finance: 'Finance', procurement: 'Procurement', sales: 'Sales rep', distribution: 'Distribution', accounts: 'Accounts', auditor: 'Auditor', admin: 'Admin' };

function useRange(): [string, string, (f: string, t: string) => void] {
  const { me } = useSession();
  const [params, setParams] = useSearchParams();
  const from = params.get('from') ?? `${me!.businessDate.slice(0, 7)}-01`;
  const to = params.get('to') ?? me!.businessDate;
  return [from, to, (f, t) => setParams({ from: f, to: t }, { replace: true })];
}

export function EmployeeActivity() {
  const [from, to, setRange] = useRange();
  const nav = useNavigate();
  const a = useApi(() => api.get(`/api/performance/activity${qs({ from, to })}`), [from, to]);
  return (
    <>
      <PageHead kicker="Team" title="Employee activity" sub="What each person has entered or approved in the system, from the audit log. It shows work done in the software, not work done outside it." />
      <div className="row" style={{ marginBottom: 12 }}>
        <Field label="From"><input type="date" className="input" value={from} onChange={(e) => setRange(e.target.value, to)} /></Field>
        <Field label="To"><input type="date" className="input" value={to} onChange={(e) => setRange(from, e.target.value)} /></Field>
      </div>
      <Panel pad={false}>
        {a.loading && !a.data ? <Loading /> : a.error ? <ErrorBox error={a.error} onRetry={a.reload} /> : (
          <div className="table-wrap">
            <table className="t">
              <thead><tr><th>Employee</th><th>Last seen</th><th className="num">Days active</th><th className="num">Sign-ins</th><th className="num">Entries</th><th>Main work</th></tr></thead>
              <tbody>
                {a.data.rows.map((u: any) => {
                  const top = Object.entries(u.by_action as Record<string, number>).sort((p, q) => q[1] - p[1]).slice(0, 4);
                  return (
                    <tr key={u.id} className={u.active ? '' : 'muted'} style={{ cursor: 'pointer' }} onClick={() => nav(`/team/activity/${u.id}${qs({ from, to })}`)}>
                      <td><Link to={`/team/activity/${u.id}${qs({ from, to })}`} onClick={(e) => e.stopPropagation()}>{u.full_name}</Link><div className="small muted">{ROLE[u.role_code] ?? u.role_code}</div></td>
                      <td className="small">{u.last_seen ? dt(u.last_seen) : 'Never'}</td>
                      <td className="num">{u.days_worked || '—'}</td>
                      <td className="num">{u.sign_ins || '—'}</td>
                      <td className="num">{u.actions || '—'}</td>
                      <td className="small">{top.length ? top.map(([k, n]) => `${actionLabel(k)} ${n}`).join(' · ') : <span className="muted">Nothing entered</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}

const ENTITY_LINK: Record<string, (id: string) => string | null> = {
  og: (id) => (/^\d+$/.test(id) ? `/ogs/${id}` : null),
  party: (id) => (/^\d+$/.test(id) ? `/customers/${id}` : null),
  journal: (id) => `/ledger/journals/${id}`,
  payment_voucher: (id) => `/vouchers/${id}`,
  receipt_voucher: (id) => `/vouchers/${id}`
};

export function EmployeeActivityDetail() {
  const { id } = useParams();
  const [from, to, setRange] = useRange();
  const a = useApi(() => api.get(`/api/performance/activity/${id}${qs({ from, to })}`), [id, from, to]);
  if (a.loading && !a.data) return <Loading />;
  if (a.error) return <ErrorBox error={a.error} onRetry={a.reload} />;
  const x = a.data;
  return (
    <>
      <PageHead kicker="Employee activity" title={x.user.full_name} sub={<>{ROLE[x.user.role_code] ?? x.user.role_code} · <Link to={`/team/activity${qs({ from, to })}`}>Everyone</Link>{x.user.role_code === 'sales' && <> · <Link to={`/team/reps/${x.user.id}`}>Sales figures</Link></>}</>} />
      <div className="row" style={{ marginBottom: 12 }}>
        <Field label="From"><input type="date" className="input" value={from} onChange={(e) => setRange(e.target.value, to)} /></Field>
        <Field label="To"><input type="date" className="input" value={to} onChange={(e) => setRange(from, e.target.value)} /></Field>
      </div>
      <div className="grid2">
        <Panel title="By day" pad={false}>
          {!x.days.length ? <Empty>Nothing entered in this period.</Empty> : (
            <table className="t">
              <thead><tr><th>Day</th><th className="num">Entries</th><th>First</th><th>Last</th></tr></thead>
              <tbody>{x.days.map((g: any) => <tr key={g.day}><td>{d(g.day)}</td><td className="num">{g.actions}</td><td className="small">{dt(g.first_at).slice(-5)}</td><td className="small">{dt(g.last_at).slice(-5)}</td></tr>)}</tbody>
            </table>
          )}
        </Panel>
        <Panel title="Entries" pad={false}>
          {!x.entries.length ? <Empty>Nothing in this period.</Empty> : (
            <div className="table-wrap" style={{ maxHeight: 520, overflow: 'auto' }}>
              <table className="t">
                <thead><tr><th>When</th><th>What</th><th>Record</th></tr></thead>
                <tbody>
                  {x.entries.map((e: any) => {
                    const link = e.entity_id ? ENTITY_LINK[e.entity]?.(e.entity_id) : null;
                    return (
                      <tr key={e.id}>
                        <td className="small">{dt(e.at)}</td>
                        <td>{actionLabel(`${e.entity}.${e.action}`)}</td>
                        <td className="small">{link ? <Link to={link}>{e.entity_id}</Link> : e.entity_id ?? ''}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
