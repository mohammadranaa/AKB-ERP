import { useState } from 'react';
import { api, qs } from '../lib/api';
import { bags, d, dt, tons } from '../lib/format';
import { useSession } from '../lib/session';
import { Dialog, Empty, ErrorBox, Field, FormError, Loading, PageHead, Panel, Seg, useApi, useSubmitKey, useToast } from '../components/ui';

type Measure = 'available' | 'on_hand' | 'committed' | 'unpurchased';

export function Stock() {
  const { data, error, loading, reload } = useApi(() => api.get('/api/stock/matrix'), []);
  const [m, setM] = useState<Measure>('available');
  const [cell, setCell] = useState<{ product: any; branch: any } | null>(null);
  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  const get = (p: number, b: number) => data.cells.find((c: any) => c.product_id === p && c.branch_id === b);
  const sum = (k: Measure) => data.cells.reduce((s: number, c: any) => s + Number(c[k]), 0);
  return (
    <>
      <PageHead kicker="Distribution" title="Branch stock" sub="Every figure is calculated from receipts, dispatches, transfers and approved adjustments. Click a figure to see its history." />
      <div className="grid4" style={{ marginBottom: 16 }}>
        <div className="kpi"><div className="label">On hand</div><div className="value">{bags(sum('on_hand'))} bags</div><div className="sub">{tons(sum('on_hand'))}</div></div>
        <div className="kpi"><div className="label">Committed to OGs</div><div className="value">{bags(sum('committed'))} bags</div><div className="sub">approved, not yet dispatched</div></div>
        <div className="kpi"><div className="label">Available</div><div className="value">{bags(sum('available'))} bags</div><div className="sub">on hand minus committed</div></div>
        <div className="kpi"><div className="label">Unpurchased</div><div className="value" style={sum('unpurchased') ? { color: 'var(--amber-tx)' } : undefined}>{bags(sum('unpurchased'))} bags</div><div className="sub">sold ahead of stock</div></div>
      </div>
      <div style={{ marginBottom: 10 }}>
        <Seg value={m} options={[['available', 'Available'], ['on_hand', 'On hand'], ['committed', 'Committed'], ['unpurchased', 'Unpurchased']]} onChange={setM} />
      </div>
      <Panel pad={false}>
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr><th>Product</th>{data.branches.map((b: any) => <th key={b.id} className="num">{b.code}</th>)}<th className="num">Total</th></tr>
            </thead>
            <tbody>
              {data.products.map((p: any) => {
                const total = data.branches.reduce((s: number, b: any) => s + Number(get(p.id, b.id)?.[m] ?? 0), 0);
                return (
                  <tr key={p.id}>
                    <td>{p.name_en} <span className="muted small">· {p.manufacturer}</span></td>
                    {data.branches.map((b: any) => {
                      const c = get(p.id, b.id);
                      const v = Number(c?.[m] ?? 0);
                      const short = Number(c?.available ?? 0) < 0;
                      return (
                        <td key={b.id} className={`num${short && m === 'available' ? ' short' : ''}`}>
                          <button className="cell-btn" onClick={() => setCell({ product: p, branch: b })} title={`On hand ${bags(c?.on_hand)} · committed ${bags(c?.committed)}`}>
                            {v === 0 ? <span className="muted">—</span> : bags(v)}
                          </button>
                        </td>
                      );
                    })}
                    <td className="num"><strong>{bags(total)}</strong></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>
      {cell && <Movements product={cell.product} branch={cell.branch} onClose={() => { setCell(null); void reload(); }} />}
    </>
  );
}

function Movements({ product, branch, onClose }: { product: any; branch: any; onClose: () => void }) {
  const { can } = useSession();
  const toast = useToast();
  const { data, error, loading } = useApi(() => api.get(`/api/stock/movements${qs({ productId: product.id, branchId: branch.id })}`), []);
  const [adj, setAdj] = useState(false);
  const [bagsAdj, setBagsAdj] = useState('');
  const [reason, setReason] = useState('');
  const [err, setErr] = useState<unknown>(null);
  return (
    <Dialog title={`${product.name_en} · ${branch.code}`} onClose={onClose} wide>
      {loading ? <Loading /> : error ? <ErrorBox error={error} /> : !data.length ? <Empty>No movements yet.</Empty> : (
        <div className="table-wrap" style={{ maxHeight: 420 }}>
          <table className="t">
            <thead><tr><th>Date</th><th>Type</th><th>Reference</th><th className="num">In</th><th className="num">Out</th><th className="num">Balance</th><th>By</th></tr></thead>
            <tbody>
              {data.map((x: any) => (
                <tr key={x.id}>
                  <td>{d(x.business_date)}<div className="small muted">{dt(x.created_at)}</div></td>
                  <td>{x.kind.replace('_', ' ')}</td>
                  <td>{x.ref_id}{x.note && <div className="small muted">{x.note}</div>}</td>
                  <td className="num">{x.bags > 0 ? bags(x.bags) : ''}</td>
                  <td className="num">{x.bags < 0 ? bags(-x.bags) : ''}</td>
                  <td className="num"><strong>{bags(x.running)}</strong></td>
                  <td className="small">{x.created_by_name}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {can('stock.adjust.request') && (adj ? (
        <div className="stack">
          <div className="form-grid">
            <Field label="Bags (+ to add, − to remove)"><input className="input num" value={bagsAdj} onChange={(e) => setBagsAdj(e.target.value.replace(/[^\d-]/g, ''))} /></Field>
            <Field label="Reason"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. 5 torn bags found at count" /></Field>
          </div>
          <FormError error={err} />
          <div className="dialog-actions">
            <button className="btn" onClick={() => setAdj(false)}>Cancel</button>
            <button className="btn btn-primary" disabled={!Number(bagsAdj) || reason.trim().length < 5} onClick={async () => {
              try {
                const r = await api.post('/api/stock/adjustments', { branchId: branch.id, productId: product.id, bags: Number(bagsAdj), reason });
                toast(`${r.adjNo} sent for approval`);
                setAdj(false);
              } catch (e) { setErr(e); }
            }}>Request adjustment</button>
          </div>
        </div>
      ) : (
        <div className="dialog-actions"><button className="btn" onClick={() => setAdj(true)}>Request a stock adjustment</button><button className="btn btn-primary" onClick={onClose}>Close</button></div>
      ))}
    </Dialog>
  );
}

// ---------------- Goods receipts ----------------
export function GoodsReceipts() {
  const { can } = useSession();
  const list = useApi(() => api.get('/api/stock/goods-receipts'), []);
  const [open, setOpen] = useState(false);
  return (
    <>
      <PageHead kicker="Distribution" title="Goods receipts" sub="Bags received into a godown from a company order.">
        {can('stock.receive') && <button className="btn btn-primary" onClick={() => setOpen(true)}>Receive goods</button>}
      </PageHead>
      <Panel pad={false}>
        {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} /> : !list.data.length ? <Empty>No goods received yet.</Empty> : (
          <table className="t">
            <thead><tr><th>GR</th><th>Date</th><th>Branch</th><th>Supplier</th><th>Company order</th><th>Truck</th><th className="num">Bags</th><th>By</th></tr></thead>
            <tbody>{list.data.map((g: any) => (
              <tr key={g.id}><td>{g.gr_no}</td><td>{d(g.business_date)}</td><td>{g.branch_code}</td><td>{g.supplier_name ?? '—'}</td><td>{g.company_order_ref ?? '—'}</td><td>{g.truck_no ?? '—'}</td><td className="num">{bags(g.bags)}</td><td className="small">{g.created_by_name}</td></tr>
            ))}</tbody>
          </table>
        )}
      </Panel>
      {open && <ReceiveForm onClose={() => setOpen(false)} onDone={list.reload} />}
    </>
  );
}

function ReceiveForm({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const key = useSubmitKey();
  const branches = useApi(() => api.get('/api/branches'), []);
  const products = useApi(() => api.get('/api/products'), []);
  const suppliers = useApi(() => api.get('/api/parties?kind=supplier'), []);
  const [branchId, setBranch] = useState<number | ''>('');
  const [supplierId, setSupplier] = useState<number | ''>('');
  const [co, setCo] = useState('');
  const [truck, setTruck] = useState('');
  const [lines, setLines] = useState([{ productId: '' as number | '', bagsReceived: '', bagsShort: '0', bagsDamaged: '0' }]);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog title="Receive goods" onClose={onClose} wide>
      <div className="form-grid">
        <Field label="Godown"><select className="input" value={branchId} onChange={(e) => setBranch(e.target.value ? Number(e.target.value) : '')}><option value="">Choose…</option>{(branches.data ?? []).filter((b: any) => b.kind === 'godown').map((b: any) => <option key={b.id} value={b.id}>{b.code} · {b.name_en}</option>)}</select></Field>
        <Field label="Supplier"><select className="input" value={supplierId} onChange={(e) => setSupplier(e.target.value ? Number(e.target.value) : '')}><option value="">—</option>{(suppliers.data ?? []).map((s: any) => <option key={s.id} value={s.id}>{s.name_en}</option>)}</select></Field>
        <Field label="Company order (CO) number"><input className="input" value={co} onChange={(e) => setCo(e.target.value)} /></Field>
        <Field label="Truck"><input className="input" value={truck} onChange={(e) => setTruck(e.target.value.toUpperCase())} /></Field>
      </div>
      <table className="t">
        <thead><tr><th>Product</th><th className="num">Bags received</th><th className="num">Short</th><th className="num">Damaged</th><th /></tr></thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}>
              <td><select className="input" value={l.productId} onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, productId: e.target.value ? Number(e.target.value) : '' } : x))}><option value="">Choose…</option>{(products.data ?? []).map((p: any) => <option key={p.id} value={p.id}>{p.name_en}</option>)}</select></td>
              {(['bagsReceived', 'bagsShort', 'bagsDamaged'] as const).map((k) => (
                <td key={k}><input className="input num" style={{ width: 100 }} value={l[k]} onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, [k]: e.target.value.replace(/\D/g, '') } : x))} /></td>
              ))}
              <td>{lines.length > 1 && <button className="btn btn-ghost btn-sm" onClick={() => setLines(lines.filter((_, j) => j !== i))}>Remove</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div><button className="btn btn-sm" onClick={() => setLines([...lines, { productId: '', bagsReceived: '', bagsShort: '0', bagsDamaged: '0' }])}>Add product</button></div>
      <div className="small muted">Damaged bags are received and then sent for approval as a stock adjustment.</div>
      <FormError error={err} />
      <div className="dialog-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !branchId || lines.some((l) => !l.productId || !Number(l.bagsReceived))} onClick={async () => {
          setBusy(true);
          try {
            const r = await api.post('/api/stock/goods-receipts', {
              branchId, supplierId: supplierId || null, companyOrderRef: co || null, truckNo: truck || null,
              lines: lines.map((l) => ({ productId: Number(l.productId), bagsReceived: Number(l.bagsReceived), bagsShort: Number(l.bagsShort) || 0, bagsDamaged: Number(l.bagsDamaged) || 0 }))
            }, key.key());
            key.renew();
            toast(`${r.grNo} recorded`);
            onDone();
            onClose();
          } catch (e) { setErr(e); } finally { setBusy(false); }
        }}>Record receipt</button>
      </div>
    </Dialog>
  );
}

// ---------------- Transfers ----------------
export function Transfers() {
  const { can, me } = useSession();
  const toast = useToast();
  const list = useApi(() => api.get('/api/stock/transfers'), []);
  const [open, setOpen] = useState(false);
  return (
    <>
      <PageHead kicker="Distribution" title="Stock transfers" sub="Stock leaves the sending godown when dispatched and arrives when the receiving godown confirms it.">
        {can('stock.transfer') && <button className="btn btn-primary" onClick={() => setOpen(true)}>Send stock</button>}
      </PageHead>
      <Panel pad={false}>
        {list.loading && !list.data ? <Loading /> : !list.data?.length ? <Empty>No transfers yet.</Empty> : (
          <table className="t">
            <thead><tr><th>Transfer</th><th>Date</th><th>From</th><th>To</th><th>Truck</th><th className="num">Bags</th><th>Status</th><th /></tr></thead>
            <tbody>{list.data.map((t: any) => (
              <tr key={t.id}>
                <td>{t.transfer_no}</td><td>{d(t.business_date)}</td><td>{t.from_code}</td><td>{t.to_code}</td><td>{t.truck_no ?? '—'}</td><td className="num">{bags(t.bags)}</td>
                <td>{t.status === 'in_transit' ? <span className="chip chip-amber">In transit</span> : <span className="chip chip-green">Received {d(t.received_date)}</span>}</td>
                <td>{t.status === 'in_transit' && can('stock.transfer') && (!me!.branchIds || me!.branchIds.includes(t.to_branch_id)) && (
                  <button className="btn btn-sm" onClick={async () => { await api.post(`/api/stock/transfers/${t.id}/receive`, {}); toast(`${t.transfer_no} received`); list.reload(); }}>Mark received</button>
                )}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </Panel>
      {open && <TransferForm onClose={() => setOpen(false)} onDone={list.reload} />}
    </>
  );
}

function TransferForm({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const key = useSubmitKey();
  const branches = useApi(() => api.get('/api/branches'), []);
  const products = useApi(() => api.get('/api/products'), []);
  const [from, setFrom] = useState<number | ''>('');
  const [to, setTo] = useState<number | ''>('');
  const [truck, setTruck] = useState('');
  const [productId, setProduct] = useState<number | ''>('');
  const [n, setN] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const godowns = (branches.data ?? []).filter((b: any) => b.kind === 'godown');
  return (
    <Dialog title="Send stock to another godown" onClose={onClose}>
      <div className="form-grid">
        <Field label="From"><select className="input" value={from} onChange={(e) => setFrom(e.target.value ? Number(e.target.value) : '')}><option value="">Choose…</option>{godowns.map((b: any) => <option key={b.id} value={b.id}>{b.code}</option>)}</select></Field>
        <Field label="To"><select className="input" value={to} onChange={(e) => setTo(e.target.value ? Number(e.target.value) : '')}><option value="">Choose…</option>{godowns.filter((b: any) => b.id !== from).map((b: any) => <option key={b.id} value={b.id}>{b.code}</option>)}</select></Field>
        <Field label="Product"><select className="input" value={productId} onChange={(e) => setProduct(e.target.value ? Number(e.target.value) : '')}><option value="">Choose…</option>{(products.data ?? []).map((p: any) => <option key={p.id} value={p.id}>{p.name_en}</option>)}</select></Field>
        <Field label="Bags"><input className="input num" value={n} onChange={(e) => setN(e.target.value.replace(/\D/g, ''))} /></Field>
        <Field label="Truck"><input className="input" value={truck} onChange={(e) => setTruck(e.target.value.toUpperCase())} /></Field>
      </div>
      <FormError error={err} />
      <div className="dialog-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!from || !to || !productId || !Number(n)} onClick={async () => {
          try {
            const r = await api.post('/api/stock/transfers', { fromBranchId: from, toBranchId: to, truckNo: truck || null, lines: [{ productId, bags: Number(n) }] }, key.key());
            key.renew();
            toast(`${r.transferNo} sent`);
            onDone();
            onClose();
          } catch (e) { setErr(e); }
        }}>Send</button>
      </div>
    </Dialog>
  );
}
