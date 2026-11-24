// Company orders (EduSoft "purchase orders"): booked with the company under one of AKB's dealer codes,
// then the company's invoices (posted as PV), the goods received, and the payments made against them.
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, qs } from '../lib/api';
import { bags, d, rs, rsShort } from '../lib/format';
import { amountInput, fromP, toP } from '../lib/money';
import { useSession } from '../lib/session';
import { Confirm, Dialog, Empty, ErrorBox, Field, FormError, Kpi, Loading, PageHead, Panel, Seg, useApi, useSubmitKey, useToast } from '../components/ui';
import { KIND_LABEL } from '../components/masters';

const STATUS: Record<string, [string, string]> = { open: ['Open', 'chip-green'], closed: ['Closed', 'chip'], cancelled: ['Cancelled', 'chip-red'] };
const ORDER_LOCATIONS = ['godown', 'office', 'sale_point', 'company_site', 'amanat'];
const CREDIT_DAYS: [string, string][] = [['0', 'None'], ['30', '30'], ['60', '60'], ['90', '90'], ['180', '180']];

/** Invoice date + credit days - 1, as finance works it out (same day when there is no credit). */
function dueDate(date: string, days: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return '';
  const x = new Date(`${date}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + Math.max(days - 1, 0));
  return x.toISOString().slice(0, 10);
}

export function CompanyOrders() {
  const { can } = useSession();
  const nav = useNavigate();
  const [status, setStatus] = useState<'open' | 'closed' | 'cancelled' | 'all'>('open');
  const [supplierId, setSupplier] = useState('');
  const list = useApi(() => api.get(`/api/purchases/orders${qs({ status: status === 'all' ? undefined : status, supplierId })}`), [status, supplierId]);
  const pay = useApi(() => api.get('/api/purchases/payables'), []);
  const suppliers = useApi(() => api.get('/api/parties?kind=supplier'), []);
  const [add, setAdd] = useState(false);
  return (
    <>
      <PageHead kicker="Purchases" title="Company orders" sub="Orders booked with the companies, their invoices, the bags received and what AKB still owes on each.">
        {can('purchase.create') && <button className="btn btn-primary" onClick={() => setAdd(true)}>New company order</button>}
      </PageHead>
      {pay.data && (
        <div className="grid4" style={{ marginBottom: 16 }}>
          <Kpi label="Owed to companies" value={rsShort(pay.data.totals.balance)} sub={`${pay.data.rows.filter((r: any) => toP(r.balance) > 0n).length} companies`} />
          <Kpi label="Overdue" value={rsShort(pay.data.totals.overdue)} sub="invoices past their due date" warn={toP(pay.data.totals.overdue) > 0n} />
          <Kpi label="Due in the next 7 days" value={rsShort(pay.data.totals.due7d)} sub={`to ${d(addDays(pay.data.asOf, 7))}`} />
        </div>
      )}
      <div className="row" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
        <Seg value={status} options={[['open', 'Open'], ['closed', 'Closed'], ['cancelled', 'Cancelled'], ['all', 'All']]} onChange={setStatus} />
        <select className="input" style={{ width: 'auto' }} value={supplierId} onChange={(e) => setSupplier(e.target.value)} aria-label="Company">
          <option value="">All companies</option>
          {(suppliers.data ?? []).map((s: any) => <option key={s.id} value={s.id}>{s.name_en}</option>)}
        </select>
        <span className="spacer" />
        <Link to="/purchases/dealer-codes" className="small">Dealer codes</Link>
      </div>
      <Panel pad={false}>
        {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : !list.data.length ? <Empty>No company orders here.</Empty> : (
          <div className="table-wrap">
            <table className="t">
              <thead><tr><th>Order</th><th>Date</th><th>Company · dealer code</th><th>Product</th><th>Held at</th><th className="num">Bags</th><th className="num">Invoiced</th><th className="num">Received</th><th className="num">Payable</th><th>Due</th><th>Status</th></tr></thead>
              <tbody>
                {list.data.map((o: any) => {
                  const [label, cls] = STATUS[o.status] ?? [o.status, 'chip'];
                  const overdue = o.due_date && toP(o.payable) > 0n && o.due_date < (pay.data?.asOf ?? '');
                  return (
                    <tr key={o.id} className="click" onClick={() => nav(`/purchases/orders/${o.id}`)} style={{ cursor: 'pointer' }}>
                      <td><Link to={`/purchases/orders/${o.id}`} onClick={(e) => e.stopPropagation()}>{o.order_no}</Link>{o.company_order_no && <div className="small muted">CO {o.company_order_no}</div>}</td>
                      <td>{d(o.order_date)}</td>
                      <td>{o.supplier_name}<div className="small muted">{o.dealer_title}</div></td>
                      <td>{o.product_name}</td>
                      <td className="small">{o.location_code}</td>
                      <td className="num">{bags(o.bags)}</td>
                      <td className="num">{bags(o.invoiced_bags)}</td>
                      <td className="num">{bags(o.received_bags)}</td>
                      <td className="num">{toP(o.payable) < 0n ? <span className="muted">advance {rs(fromP(-toP(o.payable)))}</span> : toP(o.payable) > 0n ? rs(o.payable) : '—'}</td>
                      <td style={overdue ? { color: 'var(--red-tx)' } : undefined}>{o.due_date ? d(o.due_date) : '—'}</td>
                      <td><span className={`chip ${cls}`}>{label}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      {pay.data && pay.data.rows.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <Panel title="What AKB owes each company" pad={false}>
            <table className="t">
              <thead><tr><th>Company</th><th className="num">Balance</th><th className="num">Overdue</th><th className="num">Due in 7 days</th></tr></thead>
              <tbody>
                {pay.data.rows.map((r: any) => (
                  <tr key={r.supplier_id}>
                    <td>{r.name_en} <span className="small muted">{r.code}</span></td>
                    <td className="num">{toP(r.balance) < 0n ? <span className="muted">advance {rs(fromP(-toP(r.balance)))}</span> : rs(r.balance, { keepZero: true })}</td>
                    <td className="num" style={toP(r.overdue) > 0n ? { color: 'var(--red-tx)' } : undefined}>{toP(r.overdue) > 0n ? rs(r.overdue) : '—'}</td>
                    <td className="num">{toP(r.due_7d) > 0n ? rs(r.due_7d) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </div>
      )}
      {add && <OrderForm onClose={() => setAdd(false)} onSaved={(id) => nav(`/purchases/orders/${id}`)} />}
    </>
  );
}

function addDays(date: string, n: number) {
  const x = new Date(`${date}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}

function OrderForm({ order, onClose, onSaved }: { order?: any; onClose: () => void; onSaved: (id: number) => void }) {
  const { me } = useSession();
  const toast = useToast();
  const key = useSubmitKey();
  const codes = useApi(() => api.get('/api/purchases/dealer-codes'), []);
  const products = useApi(() => api.get('/api/products'), []);
  const branches = useApi(() => api.get('/api/branches'), []);
  const invoiced = !!order && Number(order.invoiced_bags) > 0;
  const [f, setF] = useState({
    orderDate: me!.businessDate,
    companyOrderNo: order?.company_order_no ?? '',
    dealerCodeId: order?.dealer_code_id ? String(order.dealer_code_id) : '',
    productId: order?.product_id ? String(order.product_id) : '',
    locationId: order?.location_id ? String(order.location_id) : '',
    bags: order ? String(order.bags) : '',
    rate: order?.rate ?? '',
    bgChargePerBag: order && toP(order.bg_charge_per_bag) ? order.bg_charge_per_bag : '',
    freightBy: (order?.freight_by ?? 'company') as 'company' | 'akb',
    freightPerBag: order && toP(order.freight_per_bag) ? order.freight_per_bag : '',
    creditDays: String(order?.credit_days ?? 30),
    note: order?.note ?? ''
  });
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const s = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const value = BigInt(Number(f.bags) || 0) * (toP(f.rate) + toP(f.bgChargePerBag));
  const activeCodes = (codes.data ?? []).filter((c: any) => c.active || String(c.id) === f.dealerCodeId);
  // Products are matched to the company by the manufacturer's name (EduSoft's product-supplier association).
  const company: string = ((codes.data ?? []).find((c: any) => String(c.id) === f.dealerCodeId)?.supplier_name ?? '').toLowerCase();
  const madeBy = (p: any) => !!company && company.includes(String(p.manufacturer ?? '').toLowerCase().replace(/[^a-z ]/g, ' ').trim().split(/\s+/)[0] || '\u0000');
  const activeProducts = (products.data ?? []).filter((p: any) => p.active || String(p.id) === f.productId);
  const ours = activeProducts.filter(madeBy);
  const others = activeProducts.filter((p: any) => !madeBy(p));
  const chosen = activeProducts.find((p: any) => String(p.id) === f.productId);
  const mismatch = !!company && !!chosen && !madeBy(chosen);
  const ok = f.dealerCodeId && f.productId && f.locationId && Number(f.bags) > 0 && toP(f.rate) > 0n;
  return (
    <Dialog title={order ? `Edit ${order.order_no}` : 'New company order'} onClose={onClose} wide>
      <div className="form-grid">
        {!order && <Field label="Order date"><input type="date" className="input" value={f.orderDate} max={me!.businessDate} onChange={s('orderDate')} /></Field>}
        <Field label="Company's CO number" hint="Can be added later when the company confirms"><input className="input" value={f.companyOrderNo} onChange={s('companyOrderNo')} /></Field>
        <Field label="Dealer code (company · district)">
          <select className="input" value={f.dealerCodeId} onChange={s('dealerCodeId')} disabled={!!order}>
            <option value="">Choose…</option>
            {activeCodes.map((c: any) => <option key={c.id} value={c.id}>{c.supplier_name} · {c.title}</option>)}
          </select>
        </Field>
        <Field label="Product">
          <select className="input" value={f.productId} onChange={s('productId')} disabled={!!order}>
            <option value="">Choose…</option>
            {company && ours.length > 0 ? (
              <>
                <optgroup label="This company's products">{ours.map((p: any) => <option key={p.id} value={p.id}>{p.name_en} · {p.manufacturer}</option>)}</optgroup>
                <optgroup label="Other products">{others.map((p: any) => <option key={p.id} value={p.id}>{p.name_en} · {p.manufacturer}</option>)}</optgroup>
              </>
            ) : activeProducts.map((p: any) => <option key={p.id} value={p.id}>{p.name_en} · {p.manufacturer}</option>)}
          </select>
        </Field>
        <Field label="Bags will be held at" hint="An AKB store, the company's plant or warehouse, or a customer warehouse">
          <select className="input" value={f.locationId} onChange={s('locationId')}>
            <option value="">Choose…</option>
            {(branches.data ?? []).filter((b: any) => b.active && ORDER_LOCATIONS.includes(b.kind)).map((b: any) => <option key={b.id} value={b.id}>{b.code} · {b.name_en} ({KIND_LABEL[b.kind] ?? b.kind})</option>)}
          </select>
        </Field>
        <Field label="Bags"><input className="input num" inputMode="numeric" value={f.bags} onChange={(e) => setF({ ...f, bags: e.target.value.replace(/\D/g, '') })} /></Field>
        <Field label="Rate per bag (Rs, incl. taxes)" hint={invoiced ? 'Fixed: the company has invoiced this order' : undefined}>
          <input className="input num" inputMode="decimal" value={f.rate} disabled={invoiced} onChange={(e) => setF({ ...f, rate: amountInput(e.target.value) })} />
        </Field>
        <Field label="BG charges per bag (Rs)" hint="When the order is on a bank guarantee">
          <input className="input num" inputMode="decimal" value={f.bgChargePerBag} disabled={invoiced} onChange={(e) => setF({ ...f, bgChargePerBag: amountInput(e.target.value) })} placeholder="0" />
        </Field>
        <div className="field" style={{ alignItems: 'flex-start' }}>
          <span>Credit days</span>
          <Seg value={f.creditDays} options={CREDIT_DAYS} onChange={(v) => setF({ ...f, creditDays: v })} />
        </div>
        <div className="field" style={{ alignItems: 'flex-start' }}>
          <span>Freight paid by</span>
          <Seg value={f.freightBy} options={[['company', 'Company'], ['akb', 'AKB']]} onChange={(v) => setF({ ...f, freightBy: v })} />
        </div>
        {f.freightBy === 'akb' && <Field label="Freight per bag (Rs)"><input className="input num" value={f.freightPerBag} onChange={(e) => setF({ ...f, freightPerBag: amountInput(e.target.value) })} /></Field>}
        <Field label="Note"><input className="input" value={f.note} onChange={s('note')} /></Field>
      </div>
      {mismatch && <div className="note note-amber small">{chosen.name_en} is made by {chosen.manufacturer}, not by the company of this dealer code. Check the product.</div>}
      <div className="totals">
        <div><span>Order value (bags × (rate + BG charges))</span><strong>{rs(fromP(value), { keepZero: true })}</strong></div>
      </div>
      <FormError error={err} />
      <div className="dialog-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!ok || busy} onClick={async () => {
          setBusy(true);
          setErr(null);
          try {
            const body = {
              companyOrderNo: f.companyOrderNo.trim() || null, productId: Number(f.productId), locationId: Number(f.locationId), bags: Number(f.bags),
              rate: fromP(toP(f.rate)), bgChargePerBag: fromP(toP(f.bgChargePerBag)), freightBy: f.freightBy,
              freightPerBag: f.freightBy === 'akb' ? fromP(toP(f.freightPerBag)) : '0.00', creditDays: Number(f.creditDays), note: f.note.trim() || null
            };
            if (order) {
              await api.put(`/api/purchases/orders/${order.id}`, body, key.key());
              toast(`${order.order_no} saved`);
              onSaved(Number(order.id));
            } else {
              const r = await api.post('/api/purchases/orders', { ...body, orderDate: f.orderDate, dealerCodeId: Number(f.dealerCodeId) }, key.key());
              toast(`${r.orderNo} booked`);
              onSaved(Number(r.id));
            }
            key.renew();
            onClose();
          } catch (e) { setErr(e); } finally { setBusy(false); }
        }}>{order ? 'Save' : 'Book order'}</button>
      </div>
    </Dialog>
  );
}

export function CompanyOrderDetail() {
  const { id } = useParams();
  const { can } = useSession();
  const nav = useNavigate();
  const toast = useToast();
  const o = useApi(() => api.get(`/api/purchases/orders/${id}`), [id]);
  const [ask, setAsk] = useState<'edit' | 'invoice' | 'close' | 'cancel' | null>(null);
  if (o.loading && !o.data) return <Loading />;
  if (o.error) return <ErrorBox error={o.error} onRetry={o.reload} />;
  const x = o.data;
  const [label, cls] = STATUS[x.status] ?? [x.status, 'chip'];
  const open = x.status === 'open';
  const left = x.bags - x.invoiced_bags;
  return (
    <>
      <PageHead
        kicker="Company order"
        title={`${x.order_no}${x.company_order_no ? ` · CO ${x.company_order_no}` : ''}`}
        sub={<>{d(x.order_date)} · {x.supplier_name} · {x.dealer_title} · <span className={`chip ${cls}`}>{label}</span></>}
      >
        {open && can('purchase.create') && <button className="btn" onClick={() => setAsk('edit')}>Edit</button>}
        {open && can('voucher.create') && <button className="btn" onClick={() => nav(`/vouchers/new?kind=payment&party=${x.supplier_id}&order=${x.id}`)}>Record payment</button>}
        {open && can('purchase.create') && left > 0 && <button className="btn btn-primary" onClick={() => setAsk('invoice')}>Record company invoice</button>}
      </PageHead>
      {x.status === 'cancelled' && <div className="note note-red" style={{ marginBottom: 12 }}>Cancelled: {x.cancel_reason}</div>}
      <div className="grid4" style={{ marginBottom: 16 }}>
        <Kpi label="Ordered" value={`${bags(x.bags)} bags`} sub={`${x.product_name} · held at ${x.location_code}`} />
        <Kpi label="Invoiced" value={`${bags(x.invoiced_bags)} bags`} sub={rs(x.invoiced_amount, { keepZero: true })} />
        <Kpi label="Received" value={`${bags(x.received_bags)} bags`} sub={`${bags(x.bags - x.received_bags)} still to come`} />
        <Kpi label={toP(x.payable) < 0n ? 'Advance paid' : 'Payable'} value={rs(fromP(toP(x.payable) < 0n ? -toP(x.payable) : toP(x.payable)), { keepZero: true })} sub={`paid ${rs(x.paid, { keepZero: true })}${x.due_date ? ` · due ${d(x.due_date)}` : ''}`} warn={toP(x.payable) > 0n} />
      </div>
      <div className="stack">
        <Panel title="Terms">
          <div className="form-grid small">
            <div><div className="muted">Rate per bag</div>{rs(x.rate, { keepZero: true })}</div>
            <div><div className="muted">BG charges per bag</div>{toP(x.bg_charge_per_bag) ? rs(x.bg_charge_per_bag) : '—'}</div>
            <div><div className="muted">Order value</div>{rs(x.order_value, { keepZero: true })}</div>
            <div><div className="muted">Credit days</div>{x.credit_days || 'None'}</div>
            <div><div className="muted">Freight</div>{x.freight_by === 'akb' ? `AKB pays ${rs(x.freight_per_bag)} per bag` : 'Company pays'}</div>
            <div><div className="muted">Booked by</div>{x.created_by_name}</div>
            {x.note && <div><div className="muted">Note</div>{x.note}</div>}
          </div>
        </Panel>
        <Panel title="Company invoices (PV)" pad={false}>
          {!x.invoices.length ? <Empty>No invoices yet.</Empty> : (
            <table className="t">
              <thead><tr><th>Invoice</th><th>Date</th><th className="num">Bags</th><th className="num">Amount</th><th>Due</th><th>Voucher</th></tr></thead>
              <tbody>
                {x.invoices.map((i: any) => (
                  <tr key={i.id} className={i.reversed ? 'muted' : ''}>
                    <td>{i.invoice_no}</td><td>{d(i.invoice_date)}</td><td className="num">{bags(i.bags)}</td><td className="num">{rs(i.amount)}</td><td>{d(i.due_date)}</td>
                    <td><Link to={`/ledger/journals/${i.journal_entry_id}`}>{i.entry_no}</Link>{i.reversed && <span className="chip chip-red" style={{ marginLeft: 6 }}>Reversed</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
        <Panel title="Goods received" pad={false}>
          {!x.receipts.length ? <Empty>Nothing received yet. Distribution records it under Goods receipts, choosing this order.</Empty> : (
            <table className="t">
              <thead><tr><th>GR</th><th>Date</th><th>At</th><th>Truck</th><th className="num">Bags</th><th className="num">Short</th><th className="num">Damaged</th></tr></thead>
              <tbody>
                {x.receipts.map((g: any) => (
                  <tr key={g.id}><td>{g.gr_no}</td><td>{d(g.business_date)}</td><td>{g.branch_code}</td><td>{g.truck_no ?? '—'}</td><td className="num">{bags(g.bags)}</td><td className="num">{g.short || '—'}</td><td className="num">{g.damaged || '—'}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
        <Panel title="Payments" pad={false}>
          {!x.payments.length ? <Empty>No payments allocated to this order.</Empty> : (
            <table className="t">
              <thead><tr><th>Voucher</th><th>Date</th><th>Mode</th><th className="num">Amount</th></tr></thead>
              <tbody>
                {x.payments.map((p: any) => (
                  <tr key={p.id} className={p.reversed ? 'muted' : ''}>
                    <td><Link to={`/vouchers/${p.voucher_id}`}>{p.entry_no}</Link>{p.reversed && <span className="chip chip-red" style={{ marginLeft: 6 }}>Reversed</span>}</td>
                    <td>{d(p.business_date)}</td><td>{MODE_LABEL[p.mode] ?? p.mode}{p.reference_no ? ` · ${p.reference_no}` : ''}</td><td className="num">{rs(p.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
        {open && can('purchase.create') && (
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn" onClick={() => setAsk('close')}>Close order</button>
            {x.invoiced_bags === 0 && x.received_bags === 0 && toP(x.paid) === 0n && <button className="btn btn-danger" onClick={() => setAsk('cancel')}>Cancel order</button>}
          </div>
        )}
      </div>
      {ask === 'edit' && <OrderForm order={x} onClose={() => setAsk(null)} onSaved={() => void o.reload()} />}
      {ask === 'invoice' && <InvoiceForm order={x} onClose={() => setAsk(null)} onSaved={() => void o.reload()} />}
      {ask === 'close' && (
        <Confirm title={`Close ${x.order_no}?`} confirmLabel="Close order"
          body={left > 0 ? `${bags(left)} bags were never invoiced. No more invoices can be recorded once it is closed; goods and payments already recorded stay.` : 'No more invoices can be recorded once it is closed.'}
          onClose={() => setAsk(null)}
          onConfirm={async () => { await api.post(`/api/purchases/orders/${x.id}/close`, {}); toast(`${x.order_no} closed`); await o.reload(); }} />
      )}
      {ask === 'cancel' && (
        <Confirm title={`Cancel ${x.order_no}?`} danger confirmLabel="Cancel order" needComment="Reason (required)"
          body="The order stays on record as cancelled."
          onClose={() => setAsk(null)}
          onConfirm={async (reason) => { await api.post(`/api/purchases/orders/${x.id}/cancel`, { reason }); toast(`${x.order_no} cancelled`); await o.reload(); }} />
      )}
    </>
  );
}

export const MODE_LABEL: Record<string, string> = {
  cash: 'Cash', cheque: 'Cheque', online: 'Online / IBFT', bg_adj: 'BG adjustment', dd: 'Demand draft', cds: 'CDS', cpr: 'CPR', dcf: 'DCF', dcf_adj: 'DCF adjustment'
};

function InvoiceForm({ order, onClose, onSaved }: { order: any; onClose: () => void; onSaved: () => void }) {
  const { me } = useSession();
  const toast = useToast();
  const key = useSubmitKey();
  const left = order.bags - order.invoiced_bags;
  const [f, setF] = useState({ invoiceNo: '', invoiceDate: me!.businessDate, bags: String(left), amount: '' });
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const computed = useMemo(() => BigInt(Number(f.bags) || 0) * (toP(order.rate) + toP(order.bg_charge_per_bag)), [f.bags, order]);
  const amount = f.amount ? toP(f.amount) : computed;
  const due = dueDate(f.invoiceDate, order.credit_days);
  return (
    <Dialog title={`Company invoice on ${order.order_no}`} onClose={onClose}>
      <div className="form-grid">
        <Field label="Company's invoice number"><input className="input" autoFocus value={f.invoiceNo} onChange={(e) => setF({ ...f, invoiceNo: e.target.value })} /></Field>
        <Field label="Invoice date"><input type="date" className="input" value={f.invoiceDate} max={me!.businessDate} onChange={(e) => setF({ ...f, invoiceDate: e.target.value })} /></Field>
        <Field label="Bags" hint={`${bags(left)} left to invoice`}><input className="input num" value={f.bags} onChange={(e) => setF({ ...f, bags: e.target.value.replace(/\D/g, '') })} /></Field>
        <Field label="Amount (Rs)" hint="Leave empty to use bags × (rate + BG charges)"><input className="input num" value={f.amount} placeholder={fromP(computed)} onChange={(e) => setF({ ...f, amount: amountInput(e.target.value) })} /></Field>
      </div>
      <div className="totals">
        <div><span>Posts as PV</span><strong>Dr Purchases · Cr {order.supplier_name}</strong></div>
        <div><span>Amount</span><strong>{rs(fromP(amount), { keepZero: true })}</strong></div>
        <div><span>Due date ({order.credit_days || 'no'} credit days)</span><strong>{d(due)}</strong></div>
      </div>
      {f.amount && amount !== computed && <div className="note note-amber small">Differs from the order terms ({rs(fromP(computed))}) by {rs(fromP(amount - computed))}.</div>}
      <FormError error={err} />
      <div className="dialog-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !f.invoiceNo.trim() || !(Number(f.bags) > 0) || Number(f.bags) > left || amount <= 0n} onClick={async () => {
          setBusy(true);
          setErr(null);
          try {
            const r = await api.post(`/api/purchases/orders/${order.id}/invoices`, {
              invoiceNo: f.invoiceNo.trim(), invoiceDate: f.invoiceDate, bags: Number(f.bags), amount: f.amount ? fromP(amount) : undefined
            }, key.key());
            key.renew();
            toast(`${r.entryNo} posted · due ${d(r.dueDate)}`);
            onSaved();
            onClose();
          } catch (e) { setErr(e); } finally { setBusy(false); }
        }}>Post invoice</button>
      </div>
    </Dialog>
  );
}

// ---------------- Dealer codes ----------------
export function DealerCodes() {
  const { can } = useSession();
  const list = useApi(() => api.get('/api/purchases/dealer-codes'), []);
  const [edit, setEdit] = useState<any>(null);
  return (
    <>
      <PageHead kicker="Purchases" title="Dealer codes" sub="AKB's account code with each company for a district (EduSoft “agencies”). Every company order is booked under one.">
        {can('purchase.create', 'masters.write') && <button className="btn btn-primary" onClick={() => setEdit({})}>Add dealer code</button>}
      </PageHead>
      <Panel pad={false}>
        {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} /> : !list.data.length ? <Empty>No dealer codes yet.</Empty> : (
          <table className="t">
            <thead><tr><th>Company</th><th>Code</th><th>Title</th><th>District</th><th className="num">Orders</th><th>Status</th><th /></tr></thead>
            <tbody>
              {list.data.map((c: any) => (
                <tr key={c.id} className={c.active ? '' : 'muted'}>
                  <td>{c.supplier_name}</td><td>{c.code}</td><td>{c.title}</td><td>{c.district ?? '—'}</td><td className="num">{c.orders}</td>
                  <td>{c.active ? 'Active' : 'Inactive'}</td>
                  <td>{can('purchase.create', 'masters.write') && <button className="btn btn-sm" onClick={() => setEdit(c)}>Edit</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
      {edit && <DealerCodeForm c={edit} onClose={() => setEdit(null)} onSaved={list.reload} />}
    </>
  );
}

function DealerCodeForm({ c, onClose, onSaved }: { c: any; onClose: () => void; onSaved: () => void }) {
  const key = useSubmitKey();
  const suppliers = useApi(() => api.get('/api/parties?kind=supplier&active=true'), []);
  const [f, setF] = useState({ supplierId: c.supplier_id ? String(c.supplier_id) : '', code: c.code ?? '', title: c.title ?? '', district: c.district ?? '', active: c.active ?? true });
  const [err, setErr] = useState<unknown>(null);
  const used = Number(c.orders) > 0;
  const supplierName = (suppliers.data ?? []).find((s: any) => String(s.id) === f.supplierId)?.name_en ?? '';
  return (
    <Dialog title={c.id ? `Edit ${c.title}` : 'Add dealer code'} onClose={onClose}>
      <div className="form-grid">
        <Field label="Company">
          <select className="input" value={f.supplierId} disabled={used} onChange={(e) => setF({ ...f, supplierId: e.target.value })}>
            <option value="">Choose…</option>
            {(suppliers.data ?? []).map((s: any) => <option key={s.id} value={s.id}>{s.name_en}</option>)}
          </select>
        </Field>
        <Field label="Code given by the company" hint={used ? 'Has orders, so it cannot change' : undefined}><input className="input" value={f.code} disabled={used} onChange={(e) => setF({ ...f, code: e.target.value })} /></Field>
        <Field label="District"><input className="input" value={f.district} onChange={(e) => setF({ ...f, district: e.target.value })} /></Field>
        <Field label="Title" hint="As the team calls it, e.g. FFC SWL CC# 2130004749">
          <input className="input" value={f.title} placeholder={supplierName && f.code ? `${supplierName.split(' ')[0]} ${f.district ? f.district.slice(0, 3).toUpperCase() + ' ' : ''}${f.code}` : ''} onChange={(e) => setF({ ...f, title: e.target.value })} />
        </Field>
        <Field label="Status"><select className="input" value={f.active ? 'y' : 'n'} onChange={(e) => setF({ ...f, active: e.target.value === 'y' })}><option value="y">Active</option><option value="n">Inactive</option></select></Field>
      </div>
      <FormError error={err} />
      <div className="dialog-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!f.supplierId || !f.code.trim()} onClick={async () => {
          try {
            const title = f.title.trim() || `${supplierName.split(' ')[0]} ${f.district ? f.district.slice(0, 3).toUpperCase() + ' ' : ''}${f.code.trim()}`;
            const body = { supplierId: Number(f.supplierId), code: f.code.trim(), title, district: f.district.trim() || null, active: f.active };
            if (c.id) await api.put(`/api/purchases/dealer-codes/${c.id}`, body); else await api.post('/api/purchases/dealer-codes', body, key.key());
            key.renew();
            onSaved();
            onClose();
          } catch (e) { setErr(e); }
        }}>Save</button>
      </div>
    </Dialog>
  );
}
