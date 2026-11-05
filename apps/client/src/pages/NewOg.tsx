import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { bags, rs, tons } from '../lib/format';
import { Confirm, Field, FormError, Loading, PageHead, Panel, Seg, useApi, useSubmitKey, useToast } from '../components/ui';
import { NewCustomerDialog, NewLocationDialog, SOURCES, type SourceKind } from '../components/masters';
import { useSession } from '../lib/session';

interface Line { productId: number | ''; bags: string; rate: string }

export function NewOg() {
  const nav = useNavigate();
  const { can } = useSession();
  const toast = useToast();
  const submitKey = useSubmitKey();
  const customers = useApi(() => api.get('/api/parties?kind=customer&active=true'), []);
  const products = useApi(() => api.get('/api/products'), []);
  const branches = useApi(() => api.get('/api/branches'), []);

  const [customerId, setCustomerId] = useState<number | ''>('');
  const [q, setQ] = useState('');
  const [branchId, setBranchId] = useState<number | ''>('');
  const [source, setSource] = useState<SourceKind>('store');
  const [terms, setTerms] = useState<'credit' | 'cbd'>('credit');
  const [creditDays, setCreditDays] = useState('');
  const [delivery, setDelivery] = useState<'pohnch' | 'x'>('x');
  const [addCustomer, setAddCustomer] = useState(false);
  const [addLocation, setAddLocation] = useState(false);
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<Line[]>([{ productId: '', bags: '', rate: '' }]);
  const [preview, setPreview] = useState<any>(null);
  const [previewErr, setPreviewErr] = useState<unknown>(null);
  const [confirm, setConfirm] = useState(false);

  const locations = (branches.data ?? []).filter((b: any) => b.active && (source === 'store' ? b.kind === 'godown' : b.kind === source));
  const loc = (branches.data ?? []).find((b: any) => b.id === branchId);
  const trading = loc?.kind === 'dealer';
  const cust = (customers.data ?? []).find((c: any) => c.id === customerId);
  const matches = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (customers.data ?? []).filter((c: any) => !s || `${c.name_en} ${c.city ?? ''} ${c.code}`.toLowerCase().includes(s) || (c.name_ur ?? '').includes(q.trim())).slice(0, 8);
  }, [q, customers.data]);

  const validLines = lines.filter((l) => l.productId && Number(l.bags) > 0 && Number(l.rate) > 0);
  const body = useMemo(
    () => ({
      customerId: customerId || undefined,
      branchId: branchId || undefined,
      terms,
      creditDays: terms === 'cbd' || creditDays === '' ? undefined : Number(creditDays),
      delivery,
      note: note || undefined,
      lines: validLines.map((l) => ({ productId: Number(l.productId), bags: Number(l.bags), rate: l.rate }))
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [customerId, branchId, terms, creditDays, delivery, note, JSON.stringify(validLines)]
  );

  // Live checks: credit limit, floor price and stock, recomputed by the server as the form changes.
  useEffect(() => {
    if (!customerId || !branchId || !body.lines.length) {
      setPreview(null);
      return;
    }
    const t = setTimeout(() => {
      api.post('/api/ogs/preview', body).then((p) => { setPreview(p); setPreviewErr(null); }).catch((e) => { setPreview(null); setPreviewErr(e); });
    }, 300);
    return () => clearTimeout(t);
  }, [body, customerId, branchId]);

  if (!customers.data || !products.data || !branches.data) return <Loading />;

  const setLine = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const lineCheck = (i: number) => {
    const l = lines[i]!;
    if (!preview || !l.productId) return null;
    const idx = validLines.indexOf(l);
    return idx >= 0 ? preview.lines[idx] : null;
  };
  const ready = !!customerId && !!branchId && validLines.length === lines.length && lines.length > 0;
  const save = async (submit: boolean) => {
    const r = await api.post('/api/ogs', { ...body, submit }, submitKey.key());
    submitKey.renew();
    toast(submit ? `${r.ogNo} ${r.status === 'approved' ? 'approved and sent to dispatch' : 'sent for approval'}` : 'Draft saved');
    nav(`/ogs/${r.id}`);
  };

  return (
    <>
      <PageHead kicker="Sales" title="New OG" sub="Checks for credit limit, floor price and stock run as you type." />
      {addCustomer && (
        <NewCustomerDialog
          initialName={q.trim()}
          onClose={() => setAddCustomer(false)}
          onCreated={async (c) => {
            setAddCustomer(false);
            await customers.reload();
            setCustomerId(c.id);
            setQ('');
            toast(`Customer ${c.code} added`);
          }}
        />
      )}
      {addLocation && source !== 'store' && (
        <NewLocationDialog
          kind={source}
          defaultPartyId={source === 'amanat' && customerId ? customerId : undefined}
          onClose={() => setAddLocation(false)}
          onCreated={async (l) => {
            setAddLocation(false);
            await branches.reload();
            setBranchId(l.id);
            toast(`${l.code} · ${l.name} added`);
          }}
        />
      )}
      <div className="stack" style={{ maxWidth: 1100 }}>
        <Panel title="Customer">
          {cust ? (
            <div className="row">
              <div>
                <strong>{cust.name_en}</strong> <span className="muted">· {cust.city} · {cust.code}</span>
                {cust.name_ur && <div className="urdu">{cust.name_ur}</div>}
              </div>
              <span className="spacer" />
              <button className="btn btn-sm" onClick={() => setCustomerId('')}>Change</button>
            </div>
          ) : (
            <div className="stack">
              <div className="row">
                <input className="input" placeholder="Search customer by name, city or code" value={q} onChange={(e) => setQ(e.target.value)} autoFocus style={{ flex: 1 }} />
                {can('customer.create', 'masters.write') && <button className="btn" onClick={() => setAddCustomer(true)}>New customer</button>}
              </div>
              {q.trim() && !matches.length && <div className="small muted">No customer found.{can('customer.create', 'masters.write') ? ' Use “New customer” to add one.' : ''}</div>}
              <table className="t">
                <tbody>
                  {matches.map((c: any) => (
                    <tr key={c.id} className="click" onClick={() => { setCustomerId(c.id); setQ(''); }}>
                      <td>{c.name_en}<div className="small muted">{c.city} · {c.code}</div></td>
                      <td className="num">Balance {rs(c.balance)}</td>
                      <td className="num hide-sm">Limit {rs(c.credit_limit)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {cust && preview?.credit && (
            <div style={{ marginTop: 12 }}>
              <div className="row small"><span>Balance {rs(preview.credit.balance)} · approved not dispatched {rs(preview.credit.undispatched)}</span><span className="spacer" /><span>Limit {rs(preview.credit.limit)}</span></div>
              <CreditBar limit={Number(preview.credit.limit)} before={Number(preview.credit.after) - Number(preview.totalValue)} add={Number(preview.totalValue)} />
              <div className="small muted">After this OG: {rs(preview.credit.after)}{Number(preview.credit.overBy) > 0 && <strong style={{ color: 'var(--amber-tx)' }}> · over the limit by {rs(preview.credit.overBy)}</strong>}</div>
            </div>
          )}
        </Panel>

        <Panel title="Collect from and products">
          <div className="stack">
            <div className="seg-grid"><Seg value={source} options={SOURCES} onChange={(v) => { setSource(v); setBranchId(''); }} /></div>
            <div className="row" style={{ alignItems: 'flex-end' }}>
              <Field label={source === 'store' ? 'AKB store' : source === 'company_site' ? 'Company warehouse / plant' : source === 'amanat' ? 'Customer warehouse' : 'Dealer'}>
                <select className="input" value={branchId} onChange={(e) => setBranchId(e.target.value ? Number(e.target.value) : '')} style={{ minWidth: 260, maxWidth: 420 }}>
                  <option value="">{locations.length ? 'Choose…' : 'None added yet'}</option>
                  {locations.map((b: any) => <option key={b.id} value={b.id}>{b.code} · {b.name_en}{b.city ? `, ${b.city}` : ''}</option>)}
                </select>
              </Field>
              {source !== 'store' && can('locations.manage', 'masters.write') && <button className="btn" onClick={() => setAddLocation(true)}>{source === 'dealer' ? 'Add dealer' : 'Add location'}</button>}
            </div>
            {source === 'amanat' && <div className="small muted">AKB stock kept at a customer's warehouse. The count goes down when this OG is dispatched.</div>}
            {source === 'company_site' && <div className="small muted">Stock AKB holds at the company's warehouse or plant.</div>}
            {source === 'dealer' && <div className="small muted">Trading: the goods come from another dealer, so there is no stock check.</div>}
            <div className="table-wrap">
              <table className="t">
                <thead><tr><th style={{ minWidth: 200 }}>Product</th><th className="num">Bags</th><th className="num">Rate / bag</th><th className="num">Amount</th><th>Checks</th><th /></tr></thead>
                <tbody>
                  {lines.map((l, i) => {
                    const ck = lineCheck(i);
                    const p = (products.data ?? []).find((x: any) => x.id === l.productId);
                    return (
                      <tr key={i}>
                        <td>
                          <select className="input" value={l.productId} onChange={(e) => {
                            const pid = e.target.value ? Number(e.target.value) : '';
                            const pr = (products.data ?? []).find((x: any) => x.id === pid);
                            setLine(i, { productId: pid, rate: l.rate || (pr?.floor_price ? String(Number(pr.floor_price)) : '') });
                          }}>
                            <option value="">Choose…</option>
                            {(products.data ?? []).filter((x: any) => x.active).map((x: any) => <option key={x.id} value={x.id}>{x.name_en} · {x.manufacturer}</option>)}
                          </select>
                          {p?.floor_price && <div className="small muted">Floor {rs(p.floor_price)}</div>}
                        </td>
                        <td><input className={`input num${ck?.unpurchased ? ' warn' : ''}`} inputMode="numeric" value={l.bags} onChange={(e) => setLine(i, { bags: e.target.value.replace(/\D/g, '') })} style={{ width: 100 }} />
                          {Number(l.bags) > 0 && <div className="small muted num">{tons(l.bags)}</div>}</td>
                        <td><input className={`input num${ck?.belowFloor ? ' warn' : ''}`} inputMode="decimal" value={l.rate} onChange={(e) => setLine(i, { rate: e.target.value.replace(/[^\d.]/g, '') })} style={{ width: 120 }} /></td>
                        <td className="num">{Number(l.bags) && Number(l.rate) ? rs(Number(l.bags) * Number(l.rate)) : '—'}</td>
                        <td className="small">
                          {ck && !trading && <div className="muted">Available {bags(ck.available)}</div>}
                          {ck?.unpurchased > 0 && <span className="chip chip-amber">Unpurchased: {bags(ck.unpurchased)} bags not in stock</span>}
                          {ck?.belowFloor && <span className="chip chip-amber">Below floor</span>}
                        </td>
                        <td>{lines.length > 1 && <button className="btn btn-ghost btn-sm" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))} aria-label="Remove line">Remove</button>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div><button className="btn btn-sm" onClick={() => setLines((ls) => [...ls, { productId: '', bags: '', rate: '' }])}>Add product</button></div>
          </div>
        </Panel>

        <Panel title="Payment and delivery">
          <div className="stack">
            <div className="field" style={{ alignItems: 'flex-start' }}><span>Payment</span>
              <Seg value={terms} options={[['credit', 'Credit'], ['cbd', 'Cash']]} onChange={setTerms} />
            </div>
            {terms === 'credit' ? (
              <div className="form-grid" style={{ maxWidth: 360 }}>
                <Field label="Credit days" hint={cust ? `Customer default: ${cust.credit_days}` : '30, 60, 90 or 180'}>
                  <input className="input num" inputMode="numeric" value={creditDays} placeholder={cust ? String(cust.credit_days) : ''} onChange={(e) => setCreditDays(e.target.value.replace(/\D/g, ''))} />
                </Field>
              </div>
            ) : <div className="small muted">Cash: dispatch is held until the full amount is received.</div>}
            <div className="field" style={{ alignItems: 'flex-start' }}><span>Delivery</span>
              <Seg value={delivery} options={[['pohnch', 'Pohnch (AKB delivers)'], ['x', 'X (customer collects)']]} onChange={setDelivery} />
            </div>
            <div className="small muted">
              {delivery === 'pohnch'
                ? 'AKB arranges the vehicle. The freight cost is entered at dispatch, with the vehicle, driver and loading photos.'
                : 'The customer arranges the vehicle. The vehicle, driver and loading photos are still recorded at dispatch; freight is not AKB\'s cost.'}
            </div>
            <Field label="Note (optional)"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          </div>
        </Panel>

        <Panel>
          <div className="row">
            <div>
              <div className="kicker">Total</div>
              <div style={{ fontFamily: 'var(--font-heading)', fontSize: 28, fontWeight: 600 }}>{preview ? rs(preview.totalValue) : '—'}</div>
              {preview && <div className="small muted">{bags(preview.bags)} bags · {tons(preview.bags)}</div>}
            </div>
            <span className="spacer" />
            <button className="btn" disabled={!ready} onClick={() => save(false).catch((e) => setPreviewErr(e))}>Save draft</button>
            <button className="btn btn-primary" disabled={!ready || !preview} onClick={() => setConfirm(true)}>{preview?.needsApproval ? 'Submit for approval' : 'Submit OG'}</button>
          </div>
          {preview?.reasons?.length > 0 && <div className="note note-amber" style={{ marginTop: 12 }}><strong>Needs approval:</strong> {preview.reasons.join(' · ')}</div>}
          {preview?.unpurchasedBags > 0 && <div className="note note-amber" style={{ marginTop: 8 }}>{bags(preview.unpurchasedBags)} bags will be flagged to procurement as unpurchased. This does not block the OG.</div>}
          {previewErr ? <div style={{ marginTop: 8 }}><FormError error={previewErr} /></div> : null}
        </Panel>
      </div>
      {confirm && preview && (
        <Confirm
          title={preview.needsApproval ? 'Submit OG for approval?' : 'Submit OG?'}
          body={preview.needsApproval
            ? `This OG for ${cust?.name_en} (${rs(preview.totalValue)}) goes to an approver. It cannot be dispatched until approved.`
            : `This OG for ${cust?.name_en} (${rs(preview.totalValue)}) is within limits and goes straight to the dispatch queue.`}
          list={[
            ...preview.reasons,
            `Collect from: ${loc ? `${loc.code} · ${loc.name_en}` : '—'}`,
            delivery === 'pohnch' ? 'Pohnch: AKB delivers' : 'X: customer collects',
            ...(terms === 'cbd' ? ['Cash: dispatch is held until the full amount is received.'] : [])
          ]}
          confirmLabel={preview.needsApproval ? 'Submit for approval' : 'Submit OG'}
          onClose={() => setConfirm(false)}
          onConfirm={() => save(true)}
        />
      )}
    </>
  );
}

function CreditBar({ limit, before, add }: { limit: number; before: number; add: number }) {
  const scale = Math.max(limit, before + add, 1);
  const over = before + add > limit;
  return (
    <div style={{ position: 'relative', height: 10, background: 'var(--n200)', margin: '6px 0' }}>
      <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${(Math.max(0, before) / scale) * 100}%`, background: before / Math.max(limit, 1) > 0.9 ? 'var(--red)' : 'var(--a700)' }} />
      <div style={{ position: 'absolute', left: `${(Math.max(0, before) / scale) * 100}%`, top: 0, bottom: 0, width: `${(add / scale) * 100}%`, background: over ? 'repeating-linear-gradient(45deg, var(--amber) 0 5px, var(--amber-bg) 5px 10px)' : 'var(--a300)' }} />
      <div style={{ position: 'absolute', left: `${(limit / scale) * 100}%`, top: -3, bottom: -3, width: 2, background: 'var(--text)' }} title="Credit limit" />
    </div>
  );
}
