import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, qs } from '../lib/api';
import { d, rs } from '../lib/format';
import { useSession } from '../lib/session';
import { Empty, ErrorBox, Field, Loading, PageHead, Panel, useApi } from '../components/ui';

export function Customers() {
  const { can } = useSession();
  const [q, setQ] = useState('');
  const list = useApi(() => api.get(`/api/parties${qs({ kind: 'customer', q })}`), [q]);
  const rows = list.data ?? [];
  const totalOwed = rows.reduce((s: number, r: any) => s + Math.max(0, Number(r.balance ?? 0)), 0);
  const over = rows.filter((r: any) => Number(r.credit_limit) > 0 && Number(r.balance) > Number(r.credit_limit)).length;
  return (
    <>
      <PageHead kicker="Sales" title={can('og.read') ? 'Customers' : 'My customers'} sub={`${rows.length} customers · ${rs(totalOwed, { keepZero: true })} owed${over ? ` · ${over} over their credit limit` : ''}`}>
        {can('og.create') && <Link className="btn btn-primary" to="/ogs/new">New OG</Link>}
      </PageHead>
      <div style={{ maxWidth: 360, marginBottom: 12 }}>
        <input className="input" placeholder="Search by name, code or Urdu name" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <Panel pad={false}>
        {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : !rows.length ? <Empty>No customers found.</Empty> : (
          <div className="table-wrap">
            <table className="t">
              <thead><tr><th>Customer</th><th>City</th><th>Rep</th><th className="num">Owes</th><th className="num">Credit limit</th><th>Terms</th><th>Last order</th></tr></thead>
              <tbody>
                {rows.map((c: any) => {
                  const overLimit = Number(c.credit_limit) > 0 && Number(c.balance) > Number(c.credit_limit);
                  return (
                    <tr key={c.id} className={c.active ? '' : 'muted'}>
                      <td><Link to={`/customers/${c.id}`}>{c.name_en}</Link> <span className="small muted">{c.code}</span>{c.name_ur && <div className="urdu">{c.name_ur}</div>}</td>
                      <td>{c.city ?? '—'}</td>
                      <td className="small">{c.rep_name ?? '—'}</td>
                      <td className="num" style={overLimit ? { color: 'var(--red-tx)' } : undefined}>{rs(c.balance, { keepZero: true })}</td>
                      <td className="num">{Number(c.credit_limit) > 0 ? rs(c.credit_limit) : <span className="chip">Cash before delivery</span>}</td>
                      <td className="small">{c.credit_days} days</td>
                      <td className="small">{c.last_order_date ? d(c.last_order_date) : '—'}</td>
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

export function CustomerDetail() {
  const { id } = useParams();
  const { can } = useSession();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const p = useApi(() => api.get(`/api/parties/${id}`), [id]);
  const st = useApi(() => api.get(`/api/parties/${id}/statement${qs({ from, to })}`), [id, from, to]);
  const seeOgs = can('og.read', 'og.read.own');
  const ogs = useApi(() => (seeOgs ? api.get(`/api/ogs${qs({ customerId: id })}`) : Promise.resolve([])), [id, seeOgs]);
  if (p.loading && !p.data) return <Loading />;
  if (p.error) return <ErrorBox error={p.error} />;
  const c = p.data;
  const x = c.exposure;
  const pct = x && Number(x.credit_limit) > 0 ? Math.min(100, (Number(x.exposure) / Number(x.credit_limit)) * 100) : 0;
  return (
    <>
      <PageHead kicker="Customer" title={c.name_en} sub={<>{c.code} · {c.city ?? '—'} · rep {c.rep_name ?? '—'} {c.name_ur && <span className="urdu" style={{ marginLeft: 8 }}>{c.name_ur}</span>}</>}>
        {can('receipt.create') && <Link className="btn" to={`/receipts/new?party=${c.id}`}>Record receipt</Link>}
        {can('og.create') && <Link className="btn btn-primary" to="/ogs/new">New OG</Link>}
      </PageHead>
      {x && (
        <div className="grid4" style={{ marginBottom: 16 }}>
          <div className="kpi"><div className="label">Owes now</div><div className="value">{rs(x.balance, { keepZero: true })}</div><div className="sub">ledger balance</div></div>
          <div className="kpi"><div className="label">Approved, not dispatched</div><div className="value">{rs(x.undispatched, { keepZero: true })}</div><div className="sub">will be billed on dispatch</div></div>
          <div className="kpi"><div className="label">Exposure</div><div className="value">{rs(x.exposure, { keepZero: true })}</div>
            {Number(x.credit_limit) > 0 && <div className="bar" style={{ marginTop: 6 }}><span style={{ width: `${pct}%`, background: pct >= 100 ? 'var(--red)' : pct >= 80 ? 'var(--amber)' : 'var(--green)' }} /></div>}
          </div>
          <div className="kpi"><div className="label">Credit available</div><div className="value" style={Number(x.available) < 0 ? { color: 'var(--red-tx)' } : undefined}>{Number(x.credit_limit) > 0 ? rs(x.available, { keepZero: true }) : 'Cash first'}</div><div className="sub">limit {Number(x.credit_limit) > 0 ? rs(x.credit_limit) : 'none'} · {c.credit_days} days</div></div>
        </div>
      )}
      <div className="stack">
        <Panel title="Statement" actions={
          <div className="row">
            <Field label="From"><input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
            <Field label="To"><input type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
            <button className="btn btn-sm no-print" onClick={() => window.print()}>Print</button>
          </div>
        } pad={false}>
          {st.loading && !st.data ? <Loading /> : st.error ? <ErrorBox error={st.error} /> : (
            <div className="table-wrap">
              <table className="t">
                <thead><tr><th>Date</th><th>Entry</th><th>Details</th><th className="num">Debit</th><th className="num">Credit</th><th className="num">Balance</th></tr></thead>
                <tbody>
                  <tr><td colSpan={5} className="muted">Opening balance</td><td className="num">{rs(st.data.opening, { keepZero: true })}</td></tr>
                  {st.data.lines.map((l: any, i: number) => (
                    <tr key={i}>
                      <td>{d(l.business_date)}</td>
                      <td className="small">{l.entry_no}</td>
                      <td>{l.narration}{l.memo && l.memo !== l.source_id && <div className="small muted">{l.memo}</div>}</td>
                      <td className="num">{Number(l.debit) ? rs(l.debit) : ''}</td>
                      <td className="num">{Number(l.credit) ? rs(l.credit) : ''}</td>
                      <td className="num"><strong>{rs(l.running, { keepZero: true })}</strong></td>
                    </tr>
                  ))}
                  {!st.data.lines.length && <tr><td colSpan={6} className="muted">No movements in this period.</td></tr>}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
        {seeOgs && <Panel title="OGs" pad={false}>
          {ogs.loading && !ogs.data ? <Loading /> : !ogs.data?.length ? <Empty>No OGs yet.</Empty> : (
            <table className="t">
              <thead><tr><th>OG</th><th>Date</th><th>Products</th><th className="num">Value</th><th className="num">Outstanding</th><th>Status</th></tr></thead>
              <tbody>
                {ogs.data.map((o: any) => (
                  <tr key={o.id}>
                    <td><Link to={`/ogs/${o.id}`}>{o.og_no}</Link></td>
                    <td>{d(o.business_date)}</td>
                    <td className="small">{o.products}</td>
                    <td className="num">{rs(o.total_value)}</td>
                    <td className="num">{rs(o.outstanding, { keepZero: true })}</td>
                    <td className="small">{o.fulfilment} · {o.payment}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>}
      </div>
    </>
  );
}
