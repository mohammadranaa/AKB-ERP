import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, qs } from '../lib/api';
import { bags, d, dt, rs, tons } from '../lib/format';
import { useSession } from '../lib/session';
import { Confirm, Empty, ErrorBox, FulfilmentPill, Loading, PageHead, Panel, PaymentPill, Seg, useApi, useToast } from '../components/ui';
import { DispatchForm } from './Dispatch';

const VIEWS: [string, string][] = [
  ['all', 'All'],
  ['awaiting', 'Awaiting approval'],
  ['unpaid', 'Unpaid & overdue'],
  ['unpurchased', 'Unpurchased'],
  ['held', 'Held · CBD']
];

export function OgList() {
  const { can } = useSession();
  const [sp, setSp] = useSearchParams();
  const view = sp.get('view') ?? 'all';
  const nav = useNavigate();
  const money = can('money.read');
  const { data, error, loading, reload } = useApi(() => api.get(`/api/ogs${qs({ view })}`), [view]);
  return (
    <>
      <PageHead kicker="Sales" title={can('og.read') ? 'Orders generated (OGs)' : 'My OGs'}>
        {can('og.create') && <Link className="btn btn-primary" to="/ogs/new">New OG</Link>}
      </PageHead>
      <div style={{ marginBottom: 12 }}>
        <Seg value={view} options={VIEWS} onChange={(v) => setSp(v === 'all' ? {} : { view: v })} />
      </div>
      <Panel pad={false}>
        {error ? <ErrorBox error={error} onRetry={reload} /> : loading && !data ? <Loading /> : !data.length ? <Empty>No OGs in this view.</Empty> : (
          <div className="table-wrap">
            <table className="t">
              <thead>
                <tr>
                  <th>OG</th><th>Customer</th><th>Branch</th><th>Products</th><th className="num">Bags</th>
                  {money && <th className="num">Value</th>}
                  <th className="num">Dispatched</th>{money && <th className="num">Paid</th>}<th>Due</th><th>Status</th><th>Flags</th>
                </tr>
              </thead>
              <tbody>
                {data.map((o: any) => (
                  <tr key={o.id} className="click" onClick={() => nav(`/ogs/${o.id}`)}>
                    <td><strong>{o.og_no ?? 'Draft'}</strong><div className="small muted">{d(o.business_date)}</div></td>
                    <td>{o.customer_name}<div className="small muted">{o.customer_city}</div></td>
                    <td>{o.branch_code}</td>
                    <td className="small">{o.products}</td>
                    <td className="num">{bags(o.bags)}<div className="small muted">{tons(o.bags)}</div></td>
                    {money && <td className="num">{rs(o.total_value)}</td>}
                    <td className="num">{bags(o.dispatched_bags)}</td>
                    {money && <td className="num">{Number(o.paid) ? rs(o.paid) : '—'}</td>}
                    <td style={o.payment === 'Overdue' ? { color: 'var(--red-tx)', fontWeight: 600 } : undefined}>{o.terms === 'cbd' ? 'Before dispatch' : d(o.due_date)}</td>
                    <td><div className="row" style={{ gap: 4 }}><FulfilmentPill s={o.fulfilment} /><PaymentPill s={o.payment} /></div></td>
                    <td>
                      <div className="row" style={{ gap: 4 }}>
                        {o.status === 'submitted' && <span className="chip">Awaiting approval</span>}
                        {o.unpurchased_bags > 0 && o.fulfilment !== 'Dispatched' && <span className="chip chip-amber">Unpurchased {bags(o.unpurchased_bags)}</span>}
                        {o.terms === 'cbd' && o.payment !== 'Paid' && o.status === 'approved' && <span className="chip chip-amber">Held · CBD unpaid</span>}
                        {o.has_returned_cheque && <span className="chip chip-red">Cheque returned</span>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}

export function OgDetail() {
  const { id } = useParams();
  const { can, me } = useSession();
  const toast = useToast();
  const nav = useNavigate();
  const money = can('money.read');
  const { data: o, error, loading, reload } = useApi(() => api.get(`/api/ogs/${id}`), [id]);
  const [tab, setTab] = useState<'overview' | 'activity'>('overview');
  const [dialog, setDialog] = useState<null | 'approve' | 'reject' | 'cancel' | 'dispatch'>(null);
  if (loading && !o) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;

  const paidPct = money && Number(o.total_value) ? Math.min(100, Math.round((Number(o.paid) / Number(o.total_value)) * 100)) : 0;
  const dispPct = Number(o.bags) ? Math.round((Number(o.dispatched_bags) / Number(o.bags)) * 100) : 0;
  const pre = ['Draft', 'Submitted'].includes(o.fulfilment);
  const steps: { t: string; ref: string; who: string; st: string }[] = [
    { t: 'OG', ref: o.og_no ?? 'Draft', who: `${o.created_by_name} · ${dt(o.created_at)}`, st: o.status === 'draft' ? 'cur' : 'done' },
    { t: 'Approval', ref: o.status === 'submitted' ? 'Waiting' : o.status === 'rejected' ? 'Rejected' : o.status === 'draft' ? 'Not submitted' : 'Approved', who: o.decided_by_name ? `${o.decided_by_name} · ${dt(o.decided_at)}` : o.status === 'approved' ? 'Automatic (within limits)' : '', st: o.status === 'submitted' ? 'cur' : o.status === 'rejected' ? 'bad' : pre ? '' : 'done' },
    { t: 'Stock', ref: o.unpurchased_bags > 0 ? `${bags(o.unpurchased_bags)} bags unpurchased` : 'In stock', who: o.branch_code, st: o.unpurchased_bags > 0 && o.fulfilment !== 'Dispatched' ? 'warn' : pre ? '' : 'done' },
    { t: 'Dispatch', ref: `${bags(o.dispatched_bags)} / ${bags(o.bags)} bags`, who: o.dispatches.length ? `${o.dispatches.length} truck${o.dispatches.length > 1 ? 's' : ''}` : o.terms === 'cbd' && o.payment !== 'Paid' && !pre ? 'Held until paid (CBD)' : '', st: o.fulfilment === 'Dispatched' ? 'done' : o.fulfilment === 'Partly dispatched' ? 'cur' : o.terms === 'cbd' && !pre && o.payment !== 'Paid' ? 'warn' : '' },
    { t: 'Payment', ref: money ? `${rs(o.paid)} of ${rs(o.total_value)}` : o.payment, who: o.terms === 'cbd' ? 'Cash before delivery' : `Due ${d(o.due_date)}`, st: o.payment === 'Paid' ? 'done' : o.payment === 'Overdue' ? 'bad' : o.payment === 'Partly paid' ? 'cur' : '' },
    { t: 'Closed', ref: o.payment === 'Paid' && o.fulfilment === 'Dispatched' ? 'Complete' : 'Open', who: '', st: o.payment === 'Paid' && o.fulfilment === 'Dispatched' ? 'done' : '' }
  ];

  return (
    <>
      <PageHead
        kicker={`OG · ${o.branch_code}`}
        title={o.og_no ?? 'Draft OG'}
        sub={<>{o.customer_name} · {o.customer_city} {o.customer_name_ur && <span className="urdu" style={{ marginLeft: 8 }}>{o.customer_name_ur}</span>}</>}
      >
        <FulfilmentPill s={o.fulfilment} /> <PaymentPill s={o.payment} />
        {o.status === 'submitted' && can('og.approve') && o.created_by !== me!.id && (
          <>
            <button className="btn" onClick={() => setDialog('reject')}>Reject</button>
            <button className="btn btn-primary" onClick={() => setDialog('approve')}>Approve</button>
          </>
        )}
        {o.status === 'approved' && o.fulfilment !== 'Dispatched' && can('dispatch.create') && (
          <button className="btn btn-primary" onClick={() => setDialog('dispatch')}>Dispatch</button>
        )}
        {o.status === 'approved' && o.payment !== 'Paid' && can('receipt.create') && (
          <button className="btn" onClick={() => nav(`/receipts/new?party=${o.customer_id}`)}>Record receipt</button>
        )}
        {['draft', 'submitted', 'approved'].includes(o.status) && Number(o.dispatched_bags) === 0 && can('og.cancel') && (
          <button className="btn" onClick={() => setDialog('cancel')}>Cancel OG</button>
        )}
        <button className="btn" onClick={() => window.print()}>Print</button>
      </PageHead>

      {o.status === 'submitted' && o.approval_reasons?.length > 0 && (
        <div className="note note-amber" style={{ marginBottom: 14 }}><strong>Needs approval:</strong> {o.approval_reasons.join(' · ')}</div>
      )}
      {o.unpurchased_bags > 0 && o.fulfilment !== 'Dispatched' && (
        <div className="note note-amber" style={{ marginBottom: 14 }}>{bags(o.unpurchased_bags)} bags were not in stock at {o.branch_code} when this OG was raised (sold ahead of purchase).</div>
      )}
      {o.allocations?.some((a: any) => a.reversed_at) && (
        <div className="note note-red" style={{ marginBottom: 14 }}>A cheque allocated to this OG was returned; that amount is unpaid again.</div>
      )}

      <Panel>
        <div className="timeline">
          {steps.map((s, i) => (
            <div key={s.t} className={`step ${s.st}`}>
              <div className="marker">{s.st === 'done' ? '✓' : i + 1}</div>
              <div className="t">{s.t}</div>
              <div>{s.ref}</div>
              <div className="muted">{s.who}</div>
            </div>
          ))}
        </div>
      </Panel>

      <div className="row" style={{ margin: '16px 0 10px' }}>
        <Seg value={tab} options={[['overview', 'Overview'], ['activity', `Activity (${o.activity.length})`]]} onChange={setTab} />
      </div>

      {tab === 'overview' ? (
        <div className="stack">
          <div className="grid2">
            <Panel title="Order">
              <table className="t keep kv">
                <tbody>
                  <tr><td className="muted">Terms</td><td>{o.terms === 'cbd' ? 'Cash before delivery' : `${o.terms === 'loan' ? 'Loan' : 'Credit'} · ${o.advance_pct}% advance · ${o.credit_days} days`}</td></tr>
                  <tr><td className="muted">Due</td><td>{o.terms === 'cbd' ? 'Before dispatch' : d(o.due_date)}</td></tr>
                  <tr><td className="muted">Created</td><td>{o.created_by_name} · {dt(o.created_at)}</td></tr>
                  <tr><td className="muted">Decision</td><td>{o.decided_by_name ? `${o.decided_by_name} · ${dt(o.decided_at)}` : '—'}{o.decision_comment && <div className="small muted">“{o.decision_comment}”</div>}</td></tr>
                  {o.rep_name && <tr><td className="muted">Sales rep</td><td>{o.rep_name}</td></tr>}
                </tbody>
              </table>
            </Panel>
            <Panel title="Progress">
              <div className="small muted">Dispatched {bags(o.dispatched_bags)} of {bags(o.bags)} bags</div>
              <div className="bar" style={{ margin: '4px 0 12px' }}><div style={{ width: `${dispPct}%` }} /></div>
              {money && (
                <>
                  <div className="small muted">Paid {rs(o.paid)} of {rs(o.total_value)} · outstanding {rs(o.outstanding)}</div>
                  <div className="bar" style={{ marginTop: 4 }}><div style={{ width: `${paidPct}%`, background: o.payment === 'Paid' ? 'var(--green)' : o.payment === 'Overdue' ? 'var(--red)' : 'var(--amber)' }} /></div>
                </>
              )}
            </Panel>
          </div>
          <Panel title="Products" pad={false}>
            <table className="t">
              <thead><tr><th>Product</th><th className="num">Bags</th><th className="num">Dispatched</th>{money && <><th className="num">Rate</th><th className="num">Amount</th></>}</tr></thead>
              <tbody>
                {o.lines.map((l: any) => (
                  <tr key={l.id}>
                    <td>{l.name_en} <span className="muted small">· {l.manufacturer}</span>{l.name_ur && <div className="urdu">{l.name_ur}</div>}</td>
                    <td className="num">{bags(l.bags)}<div className="small muted">{tons(l.bags)}</div></td>
                    <td className="num">{bags(l.dispatched)}</td>
                    {money && <><td className="num">{rs(l.rate)}</td><td className="num">{rs(l.amount)}</td></>}
                  </tr>
                ))}
              </tbody>
              {money && (
                <tfoot>
                  {Number(o.freight_per_bag) > 0 && o.freight_by === 'customer' && <tr><td colSpan={4}>Freight charged to customer ({rs(o.freight_per_bag)}/bag)</td><td className="num">{rs(Number(o.freight_per_bag) * Number(o.bags))}</td></tr>}
                  {Number(o.discount) > 0 && <tr><td colSpan={4}>Discount</td><td className="num">−{rs(o.discount)}</td></tr>}
                  <tr><td colSpan={4}>Total</td><td className="num">{rs(o.total_value)}</td></tr>
                </tfoot>
              )}
            </table>
          </Panel>
          <Panel title={`Dispatches (${o.dispatches.length})`} pad={false}>
            {o.dispatches.length === 0 ? <Empty>Nothing dispatched yet.</Empty> : (
              <table className="t">
                <thead><tr><th>Dispatch</th><th>Date</th><th>Truck</th><th>Bilty</th><th>Gate pass</th><th>Transporter</th><th className="num">Bags</th>{money && <th className="num">Amount</th>}<th /></tr></thead>
                <tbody>
                  {o.dispatches.map((x: any) => (
                    <tr key={x.id}>
                      <td>{x.dispatch_no}<div className="small muted">{x.created_by_name}</div></td><td>{d(x.business_date)}</td><td>{x.truck_no}</td><td>{x.bilty_no ?? '—'}</td><td>{x.gate_pass_no}</td>
                      <td>{x.transporter_name ?? '—'}</td><td className="num">{bags(x.bags)}</td>{money && <td className="num">{rs(x.amount)}</td>}
                      <td><Link to={`/dispatch/${x.id}/gate-pass`}>Gate pass</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
          {money && (
            <Panel title={`Payments allocated (${o.allocations.length})`} pad={false}>
              {o.allocations.length === 0 ? <Empty>No receipts allocated yet.</Empty> : (
                <table className="t">
                  <thead><tr><th>Receipt</th><th>Date</th><th>Mode</th><th>Into</th><th>By</th><th className="num">Amount</th></tr></thead>
                  <tbody>
                    {o.allocations.map((a: any) => (
                      <tr key={a.id} style={a.reversed_at ? { background: 'var(--red-bg)' } : undefined}>
                        <td>{a.receipt_no}{a.reversed_at && <div className="small" style={{ color: 'var(--red-tx)' }}>Reversed by {a.return_no}: {a.return_reason}</div>}</td>
                        <td>{d(a.business_date)}</td><td>{a.mode.replace('_', ' ')} {a.instrument_no ?? ''}</td><td>{a.account_name}</td><td>{a.created_by_name}</td>
                        <td className="num" style={a.reversed_at ? { textDecoration: 'line-through' } : undefined}>{rs(a.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Panel>
          )}
        </div>
      ) : (
        <Panel pad={false}>
          <table className="t">
            <thead><tr><th>When</th><th>Who</th><th>What</th><th>Detail</th></tr></thead>
            <tbody>
              {o.activity.map((a: any, i: number) => (
                <tr key={i}>
                  <td className="small">{dt(a.at)}</td><td>{a.user_name ?? 'System'}</td><td>{a.action.replace(/_/g, ' ')}</td>
                  <td className="small muted" style={{ maxWidth: 520, overflowWrap: 'anywhere' }}>{a.detail ? summarise(a.detail) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}

      {(dialog === 'approve' || dialog === 'reject') && (
        <Confirm
          title={`${dialog === 'approve' ? 'Approve' : 'Reject'} ${o.og_no}?`}
          body={dialog === 'approve' ? 'The OG moves to Approved and joins the dispatch queue.' : `It goes back to ${o.created_by_name} with your comment.`}
          list={o.approval_reasons}
          confirmLabel={dialog === 'approve' ? 'Approve' : 'Reject'}
          danger={dialog === 'reject'}
          needComment
          onClose={() => setDialog(null)}
          onConfirm={async (comment) => {
            await api.post(`/api/ogs/${o.id}/decide`, { approve: dialog === 'approve', comment });
            toast(`${o.og_no} ${dialog === 'approve' ? 'approved' : 'rejected'}`);
            await reload();
          }}
        />
      )}
      {dialog === 'cancel' && (
        <Confirm
          title={`Cancel ${o.og_no ?? 'this draft'}?`}
          body="Committed stock is released. The OG stays on record, marked Cancelled."
          confirmLabel="Cancel OG"
          danger
          needComment="Reason (required)"
          onClose={() => setDialog(null)}
          onConfirm={async (reason) => {
            await api.post(`/api/ogs/${o.id}/cancel`, { reason });
            toast('OG cancelled');
            await reload();
          }}
        />
      )}
      {dialog === 'dispatch' && <DispatchForm og={o} onClose={() => setDialog(null)} onDone={reload} />}
    </>
  );
}

function summarise(detail: Record<string, unknown>): string {
  return Object.entries(detail)
    .filter(([, v]) => v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0))
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join(' · ');
}
