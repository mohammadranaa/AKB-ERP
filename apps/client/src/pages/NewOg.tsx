import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { bags, rs, tons } from '../lib/format';
import { Confirm, Field, FormError, Loading, PageHead, Panel, Seg, useApi, useSubmitKey, useToast } from '../components/ui';

interface Line { productId: number | ''; bags: string; rate: string }

export function NewOg() {
  const nav = useNavigate();
  const toast = useToast();
  const submitKey = useSubmitKey();
  const customers = useApi(() => api.get('/api/parties?kind=customer&active=true'), []);
  const products = useApi(() => api.get('/api/products'), []);
  const branches = useApi(() => api.get('/api/branches'), []);

  const [customerId, setCustomerId] = useState<number | ''>('');
  const [q, setQ] = useState('');
  const [branchId, setBranchId] = useState<number | ''>('');
  const [terms, setTerms] = useState<'credit' | 'cbd' | 'loan'>('credit');
  const [advancePct, setAdvancePct] = useState('0');
  const [creditDays, setCreditDays] = useState('');
  const [freightBy, setFreightBy] = useState<'customer' | 'akb'>('customer');
  const [freight, setFreight] = useState('0');
  const [discount, setDiscount] = useState('0');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<Line[]>([{ productId: '', bags: '', rate: '' }]);
  const [preview, setPreview] = useState<any>(null);
  const [previewErr, setPreviewErr] = useState<unknown>(null);
  const [confirm, setConfirm] = useState(false);

  const godowns = (branches.data ?? []).filter((b: any) => b.kind === 'godown' && b.active);
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
      advancePct: Number(advancePct) || 0,
      creditDays: creditDays === '' ? undefined : Number(creditDays),
      freightBy,
      freightPerBag: freight || '0',
      discount: discount || '0',
      note: note || undefined,
      lines: validLines.map((l) => ({ productId: Number(l.productId), bags: Number(l.bags), rate: l.rate }))
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [customerId, branchId, terms, advancePct, creditDays, freightBy, freight, discount, note, JSON.stringify(validLines)]
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

  if (customers.loading || products.loading || branches.loading) return <Loading />;

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
              <input className="input" placeholder="Search customer by name, city or code" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
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

        <Panel title="Branch and products">
          <div className="stack">
            <Field label="Dispatch from">
              <select className="input" value={branchId} onChange={(e) => setBranchId(e.target.value ? Number(e.target.value) : '')} style={{ maxWidth: 320 }}>
                <option value="">Choose branch…</option>
                {godowns.map((b: any) => <option key={b.id} value={b.id}>{b.code} · {b.name_en}</option>)}
              </select>
            </Field>
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
                          {ck && <div className="muted">Available {bags(ck.available)}</div>}
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

        <Panel title="Terms, freight and discount">
          <div className="stack">
            <Seg value={terms} options={[['credit', 'Credit'], ['cbd', 'Cash before delivery'], ['loan', 'Loan (to be defined)']]} onChange={setTerms} />
            {terms === 'loan' && <div className="note note-amber small">Loan terms are waiting for the team's answer (question 34). For now they are treated like credit.</div>}
            <div className="form-grid">
              {terms !== 'cbd' && (
                <>
                  <Field label="Advance %"><input className="input num" value={advancePct} onChange={(e) => setAdvancePct(e.target.value.replace(/[^\d.]/g, ''))} /></Field>
                  <Field label="Credit days" hint={cust ? `Customer default: ${cust.credit_days}` : undefined}><input className="input num" value={creditDays} placeholder={cust ? String(cust.credit_days) : ''} onChange={(e) => setCreditDays(e.target.value.replace(/\D/g, ''))} /></Field>
                </>
              )}
              <Field label="Freight paid by">
                <select className="input" value={freightBy} onChange={(e) => setFreightBy(e.target.value as 'customer' | 'akb')}>
                  <option value="customer">Customer (added to the bill)</option>
                  <option value="akb">AKB</option>
                </select>
              </Field>
              {freightBy === 'customer' && <Field label="Freight per bag (Rs)"><input className="input num" value={freight} onChange={(e) => setFreight(e.target.value.replace(/[^\d.]/g, ''))} /></Field>}
              <Field label="Discount (Rs, whole OG)"><input className="input num" value={discount} onChange={(e) => setDiscount(e.target.value.replace(/[^\d.]/g, ''))} /></Field>
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
          list={[...preview.reasons, ...(terms === 'cbd' ? ['Cash before delivery: dispatch is held until the full amount is received.'] : [])]}
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
