import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { bags, d, dt, rs } from '../lib/format';
import { useSession } from '../lib/session';
import { Confirm, Empty, ErrorBox, Loading, PageHead, Panel, useApi, useToast } from '../components/ui';

type Decide = { title: string; body: string; url: string; approve: boolean; commentKey: 'comment' | 'note' };

export function Approvals() {
  const { me } = useSession();
  const toast = useToast();
  const { data, error, loading, reload } = useApi(() => api.get('/api/approvals'), []);
  const [decide, setDecide] = useState<Decide | null>(null);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  const a = data!;
  const total = a.ogs.length + a.journals.length + a.reversals.length + a.adjustments.length;

  const actions = (url: string, what: string, own: boolean, commentKey: 'comment' | 'note' = 'comment') =>
    own ? (
      <span className="small muted">You raised this; someone else must decide</span>
    ) : (
      <div className="row">
        <button className="btn btn-sm" onClick={() => setDecide({ title: `Reject ${what}?`, body: 'It goes back to the person who raised it with your comment. Nothing is posted.', url, approve: false, commentKey })}>Reject</button>
        <button className="btn btn-sm btn-primary" onClick={() => setDecide({ title: `Approve ${what}?`, body: 'This is recorded against your name with your comment.', url, approve: true, commentKey })}>Approve</button>
      </div>
    );

  return (
    <>
      <PageHead kicker="Overview" title="Approvals" sub={total ? `${total} waiting for a decision` : 'Nothing waiting'} />
      <div className="stack">
        {a.ogs.length > 0 && (
          <Panel title={`OGs (${a.ogs.length})`} pad={false}>
            <table className="t">
              <thead><tr><th>OG</th><th>Customer</th><th>Why it needs approval</th><th className="num">Bags</th><th className="num">Value</th><th>Raised by</th><th /></tr></thead>
              <tbody>
                {a.ogs.map((o: any) => (
                  <tr key={o.id}>
                    <td><Link to={`/ogs/${o.id}`}>{o.og_no}</Link><div className="small muted">{d(o.business_date)}</div></td>
                    <td>{o.customer_name}<div className="small muted">{o.city}</div></td>
                    <td>{o.approval_reasons.map((r: string, i: number) => <div key={i} className="small">{r}</div>)}</td>
                    <td className="num">{bags(o.bags)}</td>
                    <td className="num">{rs(o.total_value)}</td>
                    <td>{o.requested_by}<div className="small muted">{dt(o.submitted_at)}</div></td>
                    <td>{actions(`/api/ogs/${o.id}/decide`, o.og_no, o.created_by === me!.id)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        )}
        {a.journals.length > 0 && (
          <Panel title={`Manual journals (${a.journals.length})`} pad={false}>
            <table className="t">
              <thead><tr><th>Date</th><th>Narration</th><th className="num">Amount</th><th>Raised by</th><th /></tr></thead>
              <tbody>
                {a.journals.map((j: any) => (
                  <tr key={j.id}>
                    <td>{d(j.business_date)}</td>
                    <td><Link to={`/ledger/journals/${j.id}`}>{j.narration}</Link></td>
                    <td className="num">{rs(j.amount)}</td>
                    <td>{j.requested_by}<div className="small muted">{dt(j.created_at)}</div></td>
                    <td>{actions(`/api/ledger/journals/${j.id}/__decide`, 'this journal', j.created_by === me!.id)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        )}
        {a.reversals.length > 0 && (
          <Panel title={`Reversal requests (${a.reversals.length})`} pad={false}>
            <table className="t">
              <thead><tr><th>Entry</th><th>Reason</th><th className="num">Amount</th><th>Requested by</th><th /></tr></thead>
              <tbody>
                {a.reversals.map((r: any) => (
                  <tr key={r.id}>
                    <td><Link to={`/ledger/journals/${r.entry_id}`}>{r.entry_no}</Link><div className="small muted">{r.narration}</div></td>
                    <td>{r.reason}</td>
                    <td className="num">{rs(r.amount)}</td>
                    <td>{r.requested_by}<div className="small muted">{dt(r.requested_at)}</div></td>
                    <td>{actions(`/api/approvals/reversals/${r.id}/decide`, `reversal of ${r.entry_no}`, r.requested_by_id === me!.id, 'note')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        )}
        {a.adjustments.length > 0 && (
          <Panel title={`Stock adjustments (${a.adjustments.length})`} pad={false}>
            <table className="t">
              <thead><tr><th>Ref</th><th>Branch</th><th>Product</th><th className="num">Bags</th><th>Reason</th><th>Requested by</th><th /></tr></thead>
              <tbody>
                {a.adjustments.map((x: any) => (
                  <tr key={x.id}>
                    <td>{x.adj_no}</td><td>{x.branch_code}</td><td>{x.product_name}</td>
                    <td className="num">{x.bags > 0 ? '+' : ''}{bags(x.bags)}</td><td>{x.reason}</td>
                    <td>{x.requested_by}<div className="small muted">{dt(x.requested_at)}</div></td>
                    <td>{actions(`/api/stock/adjustments/${x.id}/decide`, x.adj_no, x.requested_by_id === me!.id, 'note')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        )}
        {total === 0 && <Panel><Empty>Nothing is waiting for your decision.</Empty></Panel>}
      </div>
      {decide && (
        <Confirm
          title={decide.title}
          body={decide.body}
          confirmLabel={decide.approve ? 'Approve' : 'Reject'}
          danger={!decide.approve}
          needComment
          onClose={() => setDecide(null)}
          onConfirm={async (comment) => {
            if (decide.url.endsWith('/__decide')) {
              const base = decide.url.replace('/__decide', '');
              await api.post(`${base}/${decide.approve ? 'approve' : 'reject'}`, { comment });
            } else {
              await api.post(decide.url, { approve: decide.approve, [decide.commentKey]: comment });
            }
            toast(decide.approve ? 'Approved' : 'Rejected');
            await reload();
          }}
        />
      )}
    </>
  );
}
