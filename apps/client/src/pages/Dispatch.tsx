import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { bags, d, dt, tons } from '../lib/format';
import { Dialog, Empty, ErrorBox, Field, FormError, Loading, PageHead, Panel, PaymentPill, useApi, useSubmitKey, useToast } from '../components/ui';

export function DispatchQueue() {
  const { data, error, loading, reload } = useApi(() => api.get('/api/dispatch-queue'), []);
  const [og, setOg] = useState<any>(null);
  const open = async (id: string) => setOg(await api.get(`/api/ogs/${id}`));
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  const byBranch = new Map<string, any[]>();
  for (const o of data) byBranch.set(o.branch_code, [...(byBranch.get(o.branch_code) ?? []), o]);
  return (
    <>
      <PageHead kicker="Distribution" title="Dispatch queue" sub={`${data.length} approved OGs waiting`} />
      {data.length === 0 && <Panel><Empty>Nothing waiting to be dispatched.</Empty></Panel>}
      <div className="stack">
        {[...byBranch.entries()].map(([branch, ogs]) => (
          <Panel key={branch} title={`${branch} · ${ogs.length} OGs · ${bags(ogs.reduce((s, o) => s + Number(o.bags) - Number(o.dispatched_bags), 0))} bags pending`} pad={false}>
            <table className="t">
              <thead><tr><th>OG</th><th>Customer</th><th>Products</th><th className="num">Pending bags</th><th>Payment</th><th /></tr></thead>
              <tbody>
                {ogs.map((o) => (
                  <tr key={o.id}>
                    <td><Link to={`/ogs/${o.id}`}>{o.og_no}</Link><div className="small muted">{d(o.business_date)}</div></td>
                    <td>{o.customer_name}<div className="small muted">{o.customer_city}</div></td>
                    <td className="small">{o.products}</td>
                    <td className="num">{bags(Number(o.bags) - Number(o.dispatched_bags))}<div className="small muted">{tons(Number(o.bags) - Number(o.dispatched_bags))}</div></td>
                    <td><PaymentPill s={o.payment} />{o.held && <div className="small" style={{ color: 'var(--amber-tx)' }}>Held: cash before delivery</div>}</td>
                    <td><button className="btn btn-sm btn-primary" disabled={o.held} onClick={() => open(o.id)}>Dispatch</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        ))}
      </div>
      {og && <DispatchForm og={og} onClose={() => setOg(null)} onDone={reload} />}
    </>
  );
}

export function DispatchForm({ og, onClose, onDone }: { og: any; onClose: () => void; onDone: () => void | Promise<void> }) {
  const toast = useToast();
  const key = useSubmitKey();
  const transporters = useApi(() => api.get('/api/parties?kind=transporter&active=true'), []);
  const pendingLines = og.lines.filter((l: any) => Number(l.bags) > Number(l.dispatched));
  const [qty, setQty] = useState<Record<string, string>>(() => Object.fromEntries(pendingLines.map((l: any) => [l.id, String(Number(l.bags) - Number(l.dispatched))])));
  const [truckNo, setTruck] = useState('');
  const [driverName, setDriver] = useState('');
  const [biltyNo, setBilty] = useState('');
  const [gatePassNo, setGp] = useState('');
  const [transporterId, setTransporter] = useState<number | ''>('');
  const [freightPerBag, setFpb] = useState('0');
  const [loadingCharges, setLoading] = useState('0');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<any>(null);
  const total = Object.values(qty).reduce((s, v) => s + (Number(v) || 0), 0);

  if (done) {
    return (
      <Dialog title={`Dispatched · ${done.dispatchNo}`} onClose={onClose}>
        <div className="note note-green">{bags(total)} bags on truck {truckNo}. Gate pass {done.gatePassNo}.{done.entryNo && ` Ledger entry ${done.entryNo}.`}</div>
        <div className="dialog-actions">
          <button className="btn" onClick={onClose}>Close</button>
          <Link className="btn btn-primary" to={`/dispatch/${done.id}/gate-pass`}>Print gate pass</Link>
        </div>
      </Dialog>
    );
  }
  return (
    <Dialog title={`Dispatch ${og.og_no}`} onClose={onClose} wide>
      <div className="small muted">{og.customer_name} · from {og.branch_code}</div>
      <table className="t">
        <thead><tr><th>Product</th><th className="num">Ordered</th><th className="num">Sent</th><th className="num">This truck</th></tr></thead>
        <tbody>
          {pendingLines.map((l: any) => (
            <tr key={l.id}>
              <td>{l.name_en}</td><td className="num">{bags(l.bags)}</td><td className="num">{bags(l.dispatched)}</td>
              <td className="num"><input className="input num" style={{ width: 110 }} inputMode="numeric" value={qty[l.id] ?? ''} onChange={(e) => setQty({ ...qty, [l.id]: e.target.value.replace(/\D/g, '') })} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="form-grid">
        <Field label="Truck number"><input className="input" value={truckNo} onChange={(e) => setTruck(e.target.value.toUpperCase())} placeholder="LES-4471" /></Field>
        <Field label="Driver"><input className="input" value={driverName} onChange={(e) => setDriver(e.target.value)} /></Field>
        <Field label="Bilty number"><input className="input" value={biltyNo} onChange={(e) => setBilty(e.target.value)} /></Field>
        <Field label="Gate pass number" hint="Leave blank to number it automatically"><input className="input" value={gatePassNo} onChange={(e) => setGp(e.target.value)} /></Field>
        <Field label="Transporter">
          <select className="input" value={transporterId} onChange={(e) => setTransporter(e.target.value ? Number(e.target.value) : '')}>
            <option value="">—</option>
            {(transporters.data ?? []).map((t: any) => <option key={t.id} value={t.id}>{t.name_en}</option>)}
          </select>
        </Field>
        <Field label="Freight to transporter (Rs per bag)"><input className="input num" value={freightPerBag} onChange={(e) => setFpb(e.target.value.replace(/[^\d.]/g, ''))} /></Field>
        <Field label="Loading charges (Rs)"><input className="input num" value={loadingCharges} onChange={(e) => setLoading(e.target.value.replace(/[^\d.]/g, ''))} /></Field>
      </div>
      <FormError error={error} />
      <div className="dialog-actions">
        <span className="small muted" style={{ marginRight: 'auto' }}>{bags(total)} bags · {tons(total)}</span>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button
          className="btn btn-primary"
          disabled={busy || total === 0 || truckNo.length < 3}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              const r = await api.post(`/api/ogs/${og.id}/dispatches`, {
                truckNo, driverName: driverName || null, biltyNo: biltyNo || null, gatePassNo: gatePassNo || undefined,
                transporterId: transporterId || null, freightPerBag, loadingCharges,
                lines: Object.entries(qty).filter(([, v]) => Number(v) > 0).map(([id, v]) => ({ ogLineId: Number(id), bags: Number(v) }))
              }, key.key());
              key.renew();
              setDone(r);
              toast(`${r.dispatchNo} recorded`);
              await onDone();
            } catch (e) {
              setError(e);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Saving…' : 'Confirm dispatch'}
        </button>
      </div>
    </Dialog>
  );
}

export function GatePass() {
  const { id } = useParams();
  const { data: x, error, loading } = useApi(() => api.get(`/api/dispatches/${id}`), [id]);
  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  const total = x.lines.reduce((s: number, l: any) => s + Number(l.bags), 0);
  return (
    <div style={{ maxWidth: 720 }}>
      <div className="row no-print" style={{ marginBottom: 12 }}>
        <Link to={`/ogs/${x.og_id}`}>Back to {x.og_no}</Link>
        <span className="spacer" />
        <button className="btn btn-primary" onClick={() => window.print()}>Print</button>
      </div>
      <div className="panel" style={{ padding: 24 }}>
        <div className="row">
          <div><h2>GATE PASS</h2><div className="muted">AKB Group · {x.branch_name} ({x.branch_code})</div></div>
          <span className="spacer" />
          <div style={{ textAlign: 'right' }}><div style={{ fontFamily: 'var(--font-heading)', fontSize: 22, fontWeight: 600 }}>{x.gate_pass_no}</div><div className="small muted">{x.dispatch_no} · {d(x.business_date)}</div></div>
        </div>
        <hr style={{ border: 0, borderTop: '1px solid var(--divider)', margin: '14px 0' }} />
        <table className="t">
          <tbody>
            <tr><td className="muted">Customer</td><td><strong>{x.customer_name}</strong>, {x.customer_city} {x.customer_name_ur && <span className="urdu" style={{ marginLeft: 8 }}>{x.customer_name_ur}</span>}</td></tr>
            <tr><td className="muted">Against OG</td><td>{x.og_no}</td></tr>
            <tr><td className="muted">Truck</td><td>{x.truck_no}{x.driver_name ? ` · driver ${x.driver_name}` : ''}</td></tr>
            <tr><td className="muted">Bilty</td><td>{x.bilty_no ?? '—'}{x.transporter_name ? ` · ${x.transporter_name}` : ''}</td></tr>
          </tbody>
        </table>
        <table className="t" style={{ marginTop: 14 }}>
          <thead><tr><th>Product</th><th className="num">Bags</th><th className="num">Weight</th></tr></thead>
          <tbody>{x.lines.map((l: any, i: number) => <tr key={i}><td>{l.name_en} {l.name_ur && <span className="urdu">{l.name_ur}</span>}</td><td className="num">{bags(l.bags)}</td><td className="num">{tons(l.bags, Number(l.bag_kg))}</td></tr>)}</tbody>
          <tfoot><tr><td>Total</td><td className="num">{bags(total)}</td><td className="num">{tons(total)}</td></tr></tfoot>
        </table>
        <div className="row" style={{ marginTop: 48, justifyContent: 'space-between' }}>
          {['Issued by', 'Godown in-charge', 'Driver', 'Security'].map((s) => <div key={s} style={{ borderTop: '1px solid var(--text)', paddingTop: 4, width: 140, textAlign: 'center' }} className="small">{s}</div>)}
        </div>
        <div className="small muted" style={{ marginTop: 18 }}>Recorded by {x.created_by_name} at {dt(x.created_at)}</div>
      </div>
    </div>
  );
}

