import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { bags, d, rs, rsShort, tons } from '../lib/format';
import { useSession } from '../lib/session';
import { ErrorBox, Loading, PageHead, Panel, useApi } from '../components/ui';

export function Dashboard() {
  const { me } = useSession();
  const { data, error, loading, reload } = useApi(() => api.get('/api/dashboard'), []);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  const x = data!;
  const pend = x.pendingApprovals;
  const pendingTotal = pend.ogs + pend.journals + pend.adjustments + pend.reversals;
  const maxDay = Math.max(1, ...x.daily.map((p: { bags: number }) => p.bags));
  const ageTotal = x.ageing.reduce((s: number, a: { amount: string }) => s + Number(a.amount), 0);
  const ageColors: Record<string, string> = { '0-15': 'var(--a300)', '16-30': 'var(--a500)', '31-60': 'var(--a800)', '60+': 'var(--red)' };
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Karachi', hour: 'numeric', hour12: false }).format(new Date()));
  const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';

  return (
    <>
      <PageHead kicker="Overview · all branches" title={`${greet}, ${me!.fullName.split(' ')[0]}`} sub={`Business date ${d(x.asOf)} · figures are live from the ledger`}>
        {pendingTotal > 0 && <Link className="btn btn-primary" to="/approvals">Review approvals · {pendingTotal}</Link>}
      </PageHead>

      <div className="grid4" style={{ marginBottom: 20 }}>
        <Kpi label="Cash & bank" value={rsShort(Number(x.cash) + Number(x.bank))} sub={`Cash ${rs(x.cash)} · banks ${rsShort(x.bank)}`} />
        <Kpi label="Receivables" value={rsShort(x.receivable)} sub={`${x.customersOwing} customers owe · advances held ${rsShort(x.advances)}`} to="/customers" />
        <Kpi label="Overdue" value={rsShort(x.overdue.amount)} sub={`${x.overdue.count} OGs past due date`} warn={x.overdue.count > 0} to="/ogs?view=unpaid" />
        <Kpi label="Stock on hand" value={`${bags(x.stockBags)} bags`} sub={tons(x.stockBags)} to="/stock" />
        <Kpi label="Unpurchased exposure" value={`${bags(x.unpurchased.bags)} bags`} sub={`sold ahead of stock · ${x.unpurchased.ogs} OGs`} warn={x.unpurchased.bags > 0} to="/ogs?view=unpurchased" />
        <Kpi label="Sales this month" value={`${bags(x.salesMtd.bags)} bags`} sub={`${rsShort(x.salesMtd.value)} dispatched`} />
        <Kpi label="Waiting for approval" value={String(pendingTotal)} sub={`${pend.ogs} OGs · ${pend.journals} journals · ${pend.reversals} reversals · ${pend.adjustments} stock`} to="/approvals" />
        <div className="kpi" style={{ border: '1px dashed var(--divider)' }}>
          <div className="label">Gross margin</div>
          <div className="value" style={{ fontSize: 20, whiteSpace: 'normal' }}>Available once purchase costs are captured</div>
          <div className="sub">No estimate is shown. Comes with the finance and procurement modules.</div>
        </div>
      </div>

      <div className="grid2" style={{ marginBottom: 20 }}>
        <Panel title="Bags dispatched · last 30 days">
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 150 }}>
            {x.daily.map((p: { date: string; bags: number }) => (
              <div key={p.date} title={`${d(p.date)}: ${bags(p.bags)} bags`} style={{ flex: 1, height: `${(p.bags / maxDay) * 100}%`, minHeight: 2, background: p.date === x.asOf ? 'var(--accent)' : 'var(--a800)' }} />
            ))}
          </div>
          <div className="row small muted" style={{ marginTop: 6 }}><span>{d(x.daily[0]?.date)}</span><span className="spacer" /><span>{d(x.asOf)}</span></div>
        </Panel>
        <Panel title="Receivables ageing" actions={<span className="muted small">by OG date, dispatched OGs</span>}>
          {x.ageing.length === 0 ? (
            <div className="muted">Nothing outstanding on dispatched OGs.</div>
          ) : (
            <>
              <div style={{ display: 'flex', height: 18, marginBottom: 12 }}>
                {x.ageing.map((a: { bucket: string; amount: string }) => (
                  <div key={a.bucket} style={{ flex: `${Number(a.amount)} 1 0`, background: ageColors[a.bucket] }} title={`${a.bucket} days: ${rs(a.amount)}`} />
                ))}
              </div>
              <table className="t">
                <tbody>
                  {x.ageing.map((a: { bucket: string; amount: string; count: string }) => (
                    <tr key={a.bucket}>
                      <td><span className="dot" style={{ background: ageColors[a.bucket], borderRadius: 0, marginRight: 8 }} />{a.bucket} days</td>
                      <td className="num">{rs(a.amount)}</td>
                      <td className="num muted">{Math.round((Number(a.amount) / ageTotal) * 100)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </Panel>
      </div>

      <Panel title="Alerts">
        <div className="stack">
          {x.alerts.returnedCheques.map((c: any) => (
            <div key={c.return_no} className="note note-red row">
              <strong>Cheque {c.instrument_no} returned</strong>
              <span>{c.party_name} · {rs(c.amount)} · {d(c.business_date)} · {c.reason}</span>
              <span className="spacer" />
              <Link to={`/customers/${c.party_id}`}>Open customer</Link>
            </div>
          ))}
          {x.alerts.unlockedDays.length > 0 && (
            <div className="note note-amber row">
              <strong>Days not yet closed:</strong> {x.alerts.unlockedDays.map(d).join(', ')}
              <span className="spacer" /><Link to="/days">Go to day close</Link>
            </div>
          )}
          {x.alerts.inactiveCustomers.length > 0 && (
            <div className="note row">
              <strong>{x.alerts.inactiveCustomers.length} customers inactive 45+ days:</strong>
              {x.alerts.inactiveCustomers.slice(0, 5).map((c: any) => `${c.name_en} (${c.days} days)`).join(', ')}
            </div>
          )}
          {x.alerts.returnedCheques.length === 0 && x.alerts.unlockedDays.length === 0 && x.alerts.inactiveCustomers.length === 0 && (
            <div className="muted">No alerts.</div>
          )}
          <div className="note">Bank guarantee, facility and company due-date alerts will appear here once the finance module is built from the team's answers.</div>
        </div>
      </Panel>
    </>
  );
}

function Kpi({ label, value, sub, warn, to }: { label: string; value: string; sub?: string; warn?: boolean; to?: string }) {
  const body = (
    <>
      <div className="label">{label}</div>
      <div className="value" style={warn ? { color: 'var(--amber-tx)' } : undefined}>{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </>
  );
  return to ? <Link to={to} className="kpi" style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}>{body}</Link> : <div className="kpi">{body}</div>;
}
