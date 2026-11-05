import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { bags, d, dt, rs, tons } from '../lib/format';
import { compressPhoto, type PhotoUpload } from '../lib/photo';
import { Dialog, Empty, ErrorBox, Field, FormError, Loading, PageHead, Panel, PaymentPill, useApi, useSubmitKey, useToast } from '../components/ui';

export function DispatchQueue() {
  const { data, error, loading, reload } = useApi(() => api.get('/api/dispatch-queue'), []);
  const [og, setOg] = useState<any>(null);
  const open = async (id: string) => setOg(await api.get(`/api/ogs/${id}`));
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  const byBranch = new Map<string, any[]>();
  for (const o of data) { const k = `${o.branch_code} · ${o.location_name}`; byBranch.set(k, [...(byBranch.get(k) ?? []), o]); }
  return (
    <>
      <PageHead kicker="Distribution" title="Dispatch queue" sub={`${data.length} approved OGs waiting`} />
      {data.length === 0 && <Panel><Empty>Nothing waiting to be dispatched.</Empty></Panel>}
      <div className="stack">
        {[...byBranch.entries()].map(([branch, ogs]) => (
          <Panel key={branch} title={`${branch} · ${ogs.length} OGs · ${bags(ogs.reduce((s, o) => s + Number(o.bags) - Number(o.dispatched_bags), 0))} bags pending`} pad={false}>
            <table className="t">
              <thead><tr><th>OG</th><th>Customer · delivery</th><th>Products</th><th className="num">Pending bags</th><th>Payment</th><th /></tr></thead>
              <tbody>
                {ogs.map((o) => (
                  <tr key={o.id}>
                    <td><Link to={`/ogs/${o.id}`}>{o.og_no}</Link><div className="small muted">{d(o.business_date)}</div></td>
                    <td>{o.customer_name}<div className="small muted">{o.customer_city} · {o.delivery === 'pohnch' ? 'Pohnch' : 'X'}</div></td>
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

const SETTLEMENTS: Record<'pohnch' | 'x', [string, string][]> = {
  pohnch: [
    ['akb_cost', 'AKB pays the freight (AKB cost)'],
    ['customer_paid', 'Customer paid the driver (credited to the customer)'],
    ['charged_to_customer', 'AKB paid, added to the customer\'s account']
  ],
  x: [
    ['none', 'Customer arranged and paid the vehicle'],
    ['charged_to_customer', 'AKB paid, added to the customer\'s account']
  ]
};

export const DELIVERY_LABEL: Record<string, string> = { pohnch: 'Pohnch (AKB delivers)', x: 'X (customer collects)' };
export const SETTLEMENT_LABEL: Record<string, string> = {
  akb_cost: 'Freight: AKB cost',
  customer_paid: 'Freight paid by the customer',
  charged_to_customer: 'Freight added to the customer\'s account',
  none: 'Customer\'s own vehicle'
};

export function DispatchForm({ og, onClose, onDone }: { og: any; onClose: () => void; onDone: () => void | Promise<void> }) {
  const toast = useToast();
  const key = useSubmitKey();
  const transporters = useApi(() => api.get('/api/parties?kind=transporter&active=true'), []);
  const pendingLines = og.lines.filter((l: any) => Number(l.bags) > Number(l.dispatched));
  const delivery: 'pohnch' | 'x' = og.delivery === 'pohnch' ? 'pohnch' : 'x';
  const [qty, setQty] = useState<Record<string, string>>(() => Object.fromEntries(pendingLines.map((l: any) => [l.id, String(Number(l.bags) - Number(l.dispatched))])));
  const [truckNo, setTruck] = useState('');
  const [vehicleDetails, setVehicle] = useState('');
  const [driverName, setDriver] = useState('');
  const [driverPhone, setPhone] = useState('');
  const [driverCnic, setCnic] = useState('');
  const [biltyNo, setBilty] = useState('');
  const [gatePassNo, setGp] = useState('');
  const [settlement, setSettlement] = useState(delivery === 'pohnch' ? 'akb_cost' : 'none');
  const [transporterId, setTransporter] = useState<number | ''>('');
  const [freightPerBag, setFpb] = useState('');
  const [loadingCharges, setLoading] = useState('0');
  const [photos, setPhotos] = useState<PhotoUpload[]>([]);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<any>(null);
  const total = Object.values(qty).reduce((s, v) => s + (Number(v) || 0), 0);
  const hasFreight = settlement !== 'none';
  const needsTransporter = settlement === 'akb_cost' || settlement === 'charged_to_customer';
  const freightTotal = (Number(freightPerBag) || 0) * total;
  const missing = [
    total === 0 && 'bags on this truck',
    truckNo.trim().length < 3 && 'vehicle number',
    vehicleDetails.trim().length < 2 && 'vehicle details',
    driverName.trim().length < 2 && 'driver name',
    !/^[0-9+\- ]{7,20}$/.test(driverPhone.trim()) && 'driver phone',
    photos.length === 0 && 'a loading photo',
    hasFreight && !(Number(freightPerBag) > 0) && 'freight per bag',
    needsTransporter && !transporterId && 'transporter'
  ].filter(Boolean) as string[];

  const addPhotos = async (files: FileList | null) => {
    if (!files?.length) return;
    setPhotoBusy(true);
    setError(null);
    try {
      const room = 3 - photos.length;
      const added: PhotoUpload[] = [];
      for (const f of [...files].slice(0, room)) added.push(await compressPhoto(f));
      setPhotos((p) => [...p, ...added]);
      if (files.length > room) toast('Up to 3 photos per truck');
    } catch (e) {
      setError(e);
    } finally {
      setPhotoBusy(false);
    }
  };

  if (done) {
    return (
      <Dialog title={`Dispatched · ${done.dispatchNo}`} onClose={onClose}>
        <div className="note note-green">{bags(total)} bags on vehicle {truckNo}. Gate pass {done.gatePassNo}.{done.entryNo && ` Ledger entry ${done.entryNo}.`}</div>
        <div className="dialog-actions">
          <button className="btn" onClick={onClose}>Close</button>
          <Link className="btn btn-primary" to={`/dispatch/${done.id}/gate-pass`}>Print gate pass</Link>
        </div>
      </Dialog>
    );
  }
  return (
    <Dialog title={`Dispatch ${og.og_no}`} onClose={onClose} wide>
      <div className="small muted">{og.customer_name} · from {og.branch_code}{og.location_name ? ` ${og.location_name}` : ''} · <strong>{DELIVERY_LABEL[delivery]}</strong></div>
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

      <div className="kicker">Vehicle and driver</div>
      <div className="form-grid">
        <Field label="Vehicle number"><input className="input" value={truckNo} onChange={(e) => setTruck(e.target.value.toUpperCase())} placeholder="LES-4471" /></Field>
        <Field label="Vehicle details" hint="Type, make, capacity"><input className="input" value={vehicleDetails} onChange={(e) => setVehicle(e.target.value)} placeholder="Hino 10-wheeler, 30 t" /></Field>
        <Field label="Driver name"><input className="input" value={driverName} onChange={(e) => setDriver(e.target.value)} /></Field>
        <Field label="Driver phone"><input className="input" inputMode="tel" value={driverPhone} onChange={(e) => setPhone(e.target.value)} placeholder="0300-1234567" /></Field>
        <Field label="Driver CNIC (optional)"><input className="input" inputMode="numeric" value={driverCnic} onChange={(e) => setCnic(e.target.value)} placeholder="35202-1234567-1" /></Field>
        <Field label="Bilty number (optional)"><input className="input" value={biltyNo} onChange={(e) => setBilty(e.target.value)} /></Field>
        <Field label="Gate pass number" hint="Leave blank to number it automatically"><input className="input" value={gatePassNo} onChange={(e) => setGp(e.target.value)} /></Field>
      </div>

      <div className="kicker">Photos of the loading (1 to 3)</div>
      <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
        {photos.map((p, i) => (
          <div key={i} style={{ position: 'relative' }}>
            <img src={p.preview} alt={`Loading photo ${i + 1}`} style={{ width: 96, height: 96, objectFit: 'cover', border: '1px solid var(--divider)' }} />
            <button className="btn btn-sm" style={{ position: 'absolute', top: 2, right: 2, padding: '0 6px' }} aria-label="Remove photo"
              onClick={() => { URL.revokeObjectURL(p.preview); setPhotos((ps) => ps.filter((_, j) => j !== i)); }}>×</button>
          </div>
        ))}
        {photos.length < 3 && (
          <label className="btn" style={{ minHeight: 44, display: 'inline-flex', alignItems: 'center' }}>
            {photoBusy ? 'Preparing…' : photos.length ? 'Add another photo' : 'Take or choose photo'}
            <input type="file" accept="image/*" capture="environment" multiple hidden disabled={photoBusy}
              onChange={(e) => { void addPhotos(e.target.files); e.target.value = ''; }} />
          </label>
        )}
      </div>

      <div className="kicker">Freight</div>
      <Field label={delivery === 'pohnch' ? 'Pohnch: how is the freight settled?' : 'X: who paid for the vehicle?'}>
        <select className="input" value={settlement} onChange={(e) => setSettlement(e.target.value)}>
          {SETTLEMENTS[delivery].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </Field>
      {hasFreight && (
        <div className="form-grid">
          <Field label="Freight (Rs per bag)" hint={freightTotal ? `Total ${rs(freightTotal)}` : undefined}>
            <input className="input num" inputMode="decimal" value={freightPerBag} onChange={(e) => setFpb(e.target.value.replace(/[^\d.]/g, ''))} />
          </Field>
          <Field label={needsTransporter ? 'Transporter' : 'Transporter (optional)'}>
            <select className="input" value={transporterId} onChange={(e) => setTransporter(e.target.value ? Number(e.target.value) : '')}>
              <option value="">—</option>
              {(transporters.data ?? []).map((t: any) => <option key={t.id} value={t.id}>{t.name_en}</option>)}
            </select>
          </Field>
          {delivery === 'pohnch' && (
            <Field label="Loading charges (Rs, optional)"><input className="input num" inputMode="decimal" value={loadingCharges} onChange={(e) => setLoading(e.target.value.replace(/[^\d.]/g, ''))} /></Field>
          )}
        </div>
      )}
      {settlement === 'customer_paid' && <div className="small muted">The customer's account is credited with the freight they paid the driver on AKB's behalf.</div>}
      {settlement === 'charged_to_customer' && <div className="small muted">The freight is added to the customer's bill for this OG and owed to the transporter.</div>}

      <FormError error={error} />
      {missing.length > 0 && total > 0 && <div className="small muted">Still needed: {missing.join(', ')}.</div>}
      <div className="dialog-actions">
        <span className="small muted" style={{ marginRight: 'auto' }}>{bags(total)} bags · {tons(total)}</span>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button
          className="btn btn-primary"
          disabled={busy || photoBusy || missing.length > 0}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              const r = await api.post(`/api/ogs/${og.id}/dispatches`, {
                truckNo: truckNo.trim(), vehicleDetails: vehicleDetails.trim(), driverName: driverName.trim(), driverPhone: driverPhone.trim(),
                driverCnic: driverCnic.trim() || null, biltyNo: biltyNo || null, gatePassNo: gatePassNo || undefined,
                freightSettlement: settlement, transporterId: transporterId || null,
                freightPerBag: hasFreight ? freightPerBag || '0' : '0', loadingCharges: hasFreight && delivery === 'pohnch' ? loadingCharges || '0' : '0',
                photos: photos.map((p) => ({ mime: p.mime, data: p.data })),
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
          <div><h2>GATE PASS</h2><div className="muted">AKB Group · {x.branch_name ? `${x.branch_name} (${x.branch_code})` : 'Trading'}</div></div>
          <span className="spacer" />
          <div style={{ textAlign: 'right' }}><div style={{ fontFamily: 'var(--font-heading)', fontSize: 22, fontWeight: 600 }}>{x.gate_pass_no}</div><div className="small muted">{x.dispatch_no} · {d(x.business_date)}</div></div>
        </div>
        <hr style={{ border: 0, borderTop: '1px solid var(--divider)', margin: '14px 0' }} />
        <table className="t keep">
          <tbody>
            <tr><td className="muted">Customer</td><td><strong>{x.customer_name}</strong>, {x.customer_city} {x.customer_name_ur && <span className="urdu" style={{ marginLeft: 8 }}>{x.customer_name_ur}</span>}</td></tr>
            <tr><td className="muted">Against OG</td><td>{x.og_no}</td></tr>
            <tr><td className="muted">Delivery</td><td>{DELIVERY_LABEL[x.delivery] ?? '—'}</td></tr>
            <tr><td className="muted">Vehicle</td><td>{x.truck_no}{x.vehicle_details ? ` · ${x.vehicle_details}` : ''}</td></tr>
            <tr><td className="muted">Driver</td><td>{x.driver_name ?? '—'}{x.driver_phone ? ` · ${x.driver_phone}` : ''}{x.driver_cnic ? ` · CNIC ${x.driver_cnic}` : ''}</td></tr>
            <tr><td className="muted">Bilty</td><td>{x.bilty_no ?? '—'}{x.transporter_name ? ` · ${x.transporter_name}` : ''}</td></tr>
          </tbody>
        </table>
        <table className="t keep" style={{ marginTop: 14 }}>
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


/** Loading photos of one dispatch. Fetched with the sign-in token, so they never sit at a public address. */
export function DispatchPhotos({ dispatchId, title, onClose }: { dispatchId: number; title: string; onClose: () => void }) {
  const [urls, setUrls] = useState<string[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let live = true;
    const made: string[] = [];
    (async () => {
      try {
        const x = await api.get(`/api/dispatches/${dispatchId}`);
        for (const ph of x.photos ?? []) made.push(await api.blobUrl(`/api/dispatches/${dispatchId}/photos/${ph.id}`));
        if (live) setUrls([...made]);
      } catch (e) {
        if (live) setError(e);
      }
    })();
    return () => { live = false; made.forEach((u) => URL.revokeObjectURL(u)); };
  }, [dispatchId]);
  return (
    <Dialog title={title} onClose={onClose} wide>
      {error ? <FormError error={error} /> : !urls ? <Loading what="Loading photos" /> : urls.length === 0 ? <Empty>No photos were recorded for this truck.</Empty> : (
        <div className="stack">
          {urls.map((u, i) => <img key={u} src={u} alt={`Loading photo ${i + 1}`} style={{ width: '100%', height: 'auto', border: '1px solid var(--divider)' }} />)}
        </div>
      )}
      <div className="dialog-actions"><button className="btn" onClick={onClose}>Close</button></div>
    </Dialog>
  );
}
