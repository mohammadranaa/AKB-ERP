// Cash and bank vouchers (EduSoft CPV / CRV) and opening balances (OPV).
import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, qs } from '../lib/api';
import { readProof, type ProofUpload } from '../lib/file';
import { d, dt, rs } from '../lib/format';
import { amountInput, fromP, toP } from '../lib/money';
import { useSession } from '../lib/session';
import { Empty, ErrorBox, Field, FormError, Loading, PageHead, Panel, Seg, useApi, useSubmitKey, useToast } from '../components/ui';
import { MODE_LABEL } from './Purchases';

type Kind = 'payment' | 'receipt';
type Mode = 'cash' | 'cheque' | 'online' | 'bg_adj' | 'dd' | 'cds' | 'cpr' | 'dcf' | 'dcf_adj';
const MODES: [Mode, string][] = [
  ['cash', 'Cash'], ['online', 'Online / IBFT'], ['cheque', 'Cheque'], ['dd', 'DD'], ['cds', 'CDS'], ['cpr', 'CPR'], ['bg_adj', 'BG ADJ'], ['dcf', 'DCF'], ['dcf_adj', 'DCF ADJ']
];
const NEEDS_REF = new Set<Mode>(['cheque', 'online', 'dd', 'cds', 'cpr']);
const REF_LABEL: Partial<Record<Mode, string>> = { cheque: 'Cheque number', online: 'Transaction (IBFT) reference', dd: 'DD number', cds: 'CDS number', cpr: 'CPR number' };
const KIND_LABEL: Record<Kind, string> = { payment: 'Payment (CPV)', receipt: 'Receipt (CRV)' };

export function Vouchers() {
  const { can } = useSession();
  const [kind, setKind] = useState<'all' | Kind>('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const list = useApi(() => api.get(`/api/vouchers${qs({ kind: kind === 'all' ? undefined : kind, from, to })}`), [kind, from, to]);
  return (
    <>
      <PageHead kicker="Accounts" title="Payment and receipt vouchers" sub="Money paid out (CPV) and received other than from customers (CRV): payments to companies, expenses, rent, bank transfers. Customer money goes on the Receipts screen.">
        {can('opening.create') && <Link className="btn" to="/vouchers/opening">Opening balances</Link>}
        {can('voucher.create') && <Link className="btn" to="/vouchers/new?kind=receipt">New receipt voucher</Link>}
        {can('voucher.create') && <Link className="btn btn-primary" to="/vouchers/new?kind=payment">New payment voucher</Link>}
      </PageHead>
      <div className="row" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
        <Seg value={kind} options={[['all', 'All'], ['payment', 'Payments'], ['receipt', 'Receipts']]} onChange={setKind} />
        <Field label="From"><input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To"><input type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>
      <Panel pad={false}>
        {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : !list.data.length ? <Empty>No vouchers in this period.</Empty> : (
          <div className="table-wrap">
            <table className="t">
              <thead><tr><th>Voucher</th><th>Date</th><th>Paid to / received from</th><th>Narration</th><th>Mode</th><th>Cash / bank</th><th className="num">Amount</th><th>Proof</th></tr></thead>
              <tbody>
                {list.data.map((v: any) => (
                  <tr key={v.id} className={v.reversed ? 'muted' : ''}>
                    <td><Link to={`/vouchers/${v.id}`}>{v.entry_no}</Link>{v.reversed && <span className="chip chip-red" style={{ marginLeft: 6 }}>Reversed</span>}</td>
                    <td>{d(v.business_date)}<div className="small muted">{v.created_by_name}</div></td>
                    <td>{v.party_name ?? '—'}</td>
                    <td className="small">{v.narration}</td>
                    <td>{MODE_LABEL[v.mode] ?? v.mode}{v.reference_no && <div className="small muted">{v.reference_no}</div>}</td>
                    <td className="small">{v.money_account_name}</td>
                    <td className="num">{v.kind === 'payment' ? '−' : ''}{rs(v.amount)}</td>
                    <td>{v.attachments ? <span className="chip chip-green">{v.attachments}</span> : NEEDS_REF.has(v.mode) ? <span className="chip chip-amber">Missing</span> : '—'}</td>
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

/** Search the party list by name or code (there are thousands, so no long dropdown). */
function PartyPicker({ value, onChange, kinds, placeholder }: { value: any; onChange: (p: any) => void; kinds?: string[]; placeholder?: string }) {
  const [q, setQ] = useState('');
  const list = useApi(() => (q.trim().length >= 1 ? api.get(`/api/parties${qs({ q: q.trim(), active: 'true' })}`) : Promise.resolve([])), [q]);
  if (value) {
    return (
      <div className="row">
        <div><strong>{value.name_en}</strong> <span className="muted small">{value.code} · {value.kind}{value.city ? ` · ${value.city}` : ''}</span></div>
        <span className="spacer" />
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => { onChange(null); setQ(''); }}>Change</button>
      </div>
    );
  }
  const rows = (list.data ?? []).filter((p: any) => !kinds || kinds.includes(p.kind)).slice(0, 8);
  return (
    <div className="stack" style={{ gap: 4 }}>
      <input className="input" placeholder={placeholder ?? 'Search by name or code'} value={q} onChange={(e) => setQ(e.target.value)} />
      {q.trim() && (
        <div className="pick-list">
          {rows.map((p: any) => (
            <button type="button" key={p.id} className="pick" onClick={() => onChange(p)}>
              <span>{p.name_en} <span className="muted small">{p.code}{p.city ? ` · ${p.city}` : ''}</span></span>
              <span className="small muted">{p.kind}</span>
            </button>
          ))}
          {!list.loading && !rows.length && <div className="small muted">No match.</div>}
        </div>
      )}
    </div>
  );
}

interface VLine { accountId: number | ''; amount: string; memo: string; party: any }
const blankLine = (accountId: number | '' = ''): VLine => ({ accountId, amount: '', memo: '', party: null });

/** A fresh form whenever the link changes (payment / receipt, or from a company order). */
export function NewVoucherPage() {
  const loc = useLocation();
  return <NewVoucher key={loc.search} />;
}

function NewVoucher() {
  const { me } = useSession();
  const toast = useToast();
  const nav = useNavigate();
  const key = useSubmitKey();
  const [params] = useSearchParams();
  const [kind, setKind] = useState<Kind>(params.get('kind') === 'receipt' ? 'receipt' : 'payment');
  const accounts = useApi(() => api.get('/api/accounts'), []);
  const [date, setDate] = useState(me!.businessDate);
  const [mode, setMode] = useState<Mode>('online');
  const [moneyId, setMoneyId] = useState<number | ''>('');
  const [ref, setRef] = useState('');
  const [party, setParty] = useState<any>(null);
  const [narration, setNarration] = useState('');
  const [lines, setLines] = useState<VLine[]>([blankLine()]);
  const [alloc, setAlloc] = useState<Record<string, string>>({});
  const [proof, setProof] = useState<ProofUpload | null>(null);
  const [proofErr, setProofErr] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<any>(null);

  const all: any[] = accounts.data ?? [];
  const byId = useMemo(() => new Map(all.map((a) => [a.id, a])), [accounts.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const codeOf = (id: number | null) => (id ? byId.get(id)?.code : undefined);
  const facilities = all.filter((a) => a.postable && a.active && a.type === 'liability' && codeOf(a.parent_id) === '2200');
  const moneyChoices = all.filter((a) => a.postable && a.active && (
    mode === 'cash' ? a.control === 'cash' : mode === 'dcf' || mode === 'dcf_adj' ? a.control === 'bank' || facilities.includes(a) : a.control === 'bank'
  ));
  const postable = all.filter((a) => a.postable && a.active && a.id !== moneyId && !(kind === 'receipt' && a.control === 'receivable'));

  // ?party=ID&order=ID: from a company order's "Record payment"
  useEffect(() => {
    const pid = params.get('party');
    if (pid && !party) api.get(`/api/parties/${pid}`).then(setParty).catch(() => undefined);
  }, [params]); // eslint-disable-line react-hooks/exhaustive-deps

  // A company paid: the line is usually Trade payables (2100).
  useEffect(() => {
    if (kind !== 'payment' || party?.kind !== 'supplier' || !all.length) return;
    const ap = all.find((a) => a.code === '2100');
    if (ap && lines.length === 1 && !lines[0]!.accountId) setLines([{ ...lines[0]!, accountId: ap.id }]);
  }, [party?.id, kind, accounts.data]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (moneyId && !moneyChoices.some((a) => a.id === moneyId)) setMoneyId('');
    if (!moneyId && moneyChoices.length === 1) setMoneyId(moneyChoices[0].id);
  }, [mode, accounts.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const allocating = kind === 'payment' && party?.kind === 'supplier';
  const orders = useApi(() => (allocating ? api.get(`/api/purchases/orders${qs({ supplierId: party.id, status: 'open' })}`) : Promise.resolve([])), [allocating, party?.id]);
  useEffect(() => {
    const oid = params.get('order');
    const o = (orders.data ?? []).find((x: any) => String(x.id) === oid);
    if (!o || Object.keys(alloc).length) return;
    const due = toP(o.payable) > 0n ? fromP(toP(o.payable)) : '';
    setAlloc({ [o.id]: due });
    if (due && lines.length === 1 && !lines[0]!.amount) setLines([{ ...lines[0]!, amount: due }]);
  }, [orders.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const total = lines.reduce((s, l) => s + toP(l.amount), 0n);
  const allocated = Object.values(alloc).reduce((s, v) => s + toP(v), 0n);
  const set = (i: number, patch: Partial<VLine>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const needsParty = (l: VLine) => {
    const a = l.accountId ? byId.get(l.accountId) : null;
    return !!a && ['receivable', 'payable'].includes(a.control);
  };
  const lineProblem = lines.some((l) => !l.accountId || toP(l.amount) <= 0n || (needsParty(l) && !l.party && !party));
  const refMissing = NEEDS_REF.has(mode) && !ref.trim();
  const canPost = !busy && moneyId && total > 0n && !lineProblem && !refMissing && narration.trim().length >= 3 && allocated <= total;

  const reset = () => {
    setDone(null); setLines([blankLine()]); setAlloc({}); setProof(null); setRef(''); setNarration(''); key.renew();
  };

  if (done) {
    return (
      <>
        <PageHead kicker="Accounts" title={`${done.entryNo} posted`} />
        <Panel>
          <div className="stack">
            <div className="note note-green">{kind === 'payment' ? 'Paid' : 'Received'} {rs(done.amount)}{party ? ` ${kind === 'payment' ? 'to' : 'from'} ${party.name_en}` : ''}.</div>
            {NEEDS_REF.has(mode) && !proof && <div className="note note-amber">No proof attached. Add the screenshot or slip from the voucher when it arrives.</div>}
            <div className="row">
              <Link className="btn" to={`/vouchers/${done.id}`}>Open voucher</Link>
              <button className="btn btn-primary" onClick={reset}>Another {kind === 'payment' ? 'payment' : 'receipt'}</button>
              <button className="btn" onClick={() => nav('/vouchers')}>All vouchers</button>
            </div>
          </div>
        </Panel>
      </>
    );
  }

  return (
    <>
      <PageHead kicker="Accounts" title={kind === 'payment' ? 'New payment voucher (CPV)' : 'New receipt voucher (CRV)'}
        sub={kind === 'payment' ? 'Money going out of a cash or bank account. Posted at once; a mistake is corrected by a reversal.' : 'Money coming in that is not a customer payment (rent, refunds, transfers in). Customer money goes on the Receipts screen.'}>
        <Seg value={kind} options={[['payment', 'Payment'], ['receipt', 'Receipt']]} onChange={(k) => { setKind(k); setAlloc({}); }} />
      </PageHead>
      <div className="split">
        <Panel title="Voucher">
          <div className="stack">
            <div className="seg-wrap"><Seg value={mode} options={MODES} onChange={setMode} /></div>
            <div className="form-grid">
              <Field label="Date"><input type="date" className="input" value={date} max={me!.businessDate} onChange={(e) => setDate(e.target.value)} /></Field>
              <Field label={kind === 'payment' ? (mode === 'cash' ? 'Paid from cash' : 'Paid from') : (mode === 'cash' ? 'Into cash' : 'Into')}>
                <select className="input" value={moneyId} onChange={(e) => setMoneyId(e.target.value ? Number(e.target.value) : '')}>
                  <option value="">Choose…</option>
                  {moneyChoices.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}{a.account_no ? ` · ${a.account_no}` : ''}</option>)}
                </select>
              </Field>
              {mode !== 'cash' && (
                <Field label={REF_LABEL[mode] ?? 'Reference'} hint={NEEDS_REF.has(mode) ? 'Required' : 'Optional'}>
                  <input className="input" value={ref} onChange={(e) => setRef(e.target.value)} />
                </Field>
              )}
            </div>
            <Field label={kind === 'payment' ? 'Paid to' : 'Received from'}>
              <PartyPicker value={party} onChange={(p) => { setParty(p); setAlloc({}); }} kinds={kind === 'receipt' ? ['supplier', 'transporter', 'tenant', 'employee', 'other'] : undefined} placeholder="Company, transporter, tenant… (optional for expenses)" />
            </Field>
            <Field label="Narration"><input className="input" value={narration} onChange={(e) => setNarration(e.target.value)} placeholder={kind === 'payment' ? 'e.g. Payment to FFC against CO 77120' : 'e.g. Shop rent for November'} /></Field>
            <div className="field">
              <span>Proof (IBFT screenshot, deposit slip, bank advice)</span>
              <input type="file" accept="image/*,application/pdf" onChange={async (e) => {
                const file = e.target.files?.[0];
                setProofErr(null);
                if (!file) { setProof(null); return; }
                try { setProof(await readProof(file)); } catch (x) { setProof(null); setProofErr(x instanceof Error ? x.message : String(x)); }
              }} />
              {proof?.preview && <img src={proof.preview} alt="Proof preview" style={{ maxWidth: 220, maxHeight: 160, objectFit: 'contain', border: '1px solid var(--divider)' }} />}
              {proof && !proof.preview && <span className="small">{proof.name} · {Math.round(proof.size / 1024)} KB</span>}
              {proofErr && <span className="small" style={{ color: 'var(--red-tx)' }}>{proofErr}</span>}
            </div>
          </div>
        </Panel>

        <Panel title={kind === 'payment' ? 'What it pays for' : 'What it is for'}>
          <div className="stack">
            <table className="t">
              <thead><tr><th>Account</th><th className="num">Amount</th><th /></tr></thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={i}>
                    <td style={{ minWidth: 220 }}>
                      <select className="input" value={l.accountId} onChange={(e) => set(i, { accountId: e.target.value ? Number(e.target.value) : '' })}>
                        <option value="">Choose account…</option>
                        {postable.map((a) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
                      </select>
                      {needsParty(l) && (
                        <div style={{ marginTop: 4 }}>
                          {l.party || !party ? <PartyPicker value={l.party} onChange={(p) => set(i, { party: p })} placeholder="Party for this line (required)" /> : <span className="small muted">Party: {party.name_en}</span>}
                        </div>
                      )}
                      <input className="input" style={{ marginTop: 4 }} placeholder="Memo (optional)" value={l.memo} onChange={(e) => set(i, { memo: e.target.value })} />
                    </td>
                    <td><input className="input num" style={{ width: 130 }} inputMode="decimal" value={l.amount} onChange={(e) => set(i, { amount: amountInput(e.target.value) })} /></td>
                    <td>{lines.length > 1 && <button className="btn btn-sm btn-ghost" onClick={() => setLines(lines.filter((_, j) => j !== i))}>Remove</button>}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr><td><button className="btn btn-sm" onClick={() => setLines([...lines, blankLine()])}>Add line</button></td><td className="num"><strong>{rs(fromP(total), { keepZero: true })}</strong></td><td /></tr></tfoot>
            </table>

            {allocating && (
              <div className="stack">
                <div className="row"><strong>Against company orders</strong><span className="spacer" />
                  <button className="btn btn-sm" disabled={!total || !(orders.data ?? []).length} onClick={() => {
                    let left = total;
                    const next: Record<string, string> = {};
                    for (const o of orders.data ?? []) {
                      const due = toP(o.payable);
                      if (left <= 0n || due <= 0n) continue;
                      const take = left < due ? left : due;
                      next[o.id] = fromP(take);
                      left -= take;
                    }
                    setAlloc(next);
                  }}>Oldest first</button>
                </div>
                {!(orders.data ?? []).length ? <div className="small muted">{party.name_en} has no open orders. The payment is kept as an advance on their account.</div> : (
                  <table className="t">
                    <thead><tr><th>Order</th><th className="num">Payable</th><th className="num">Pay now</th></tr></thead>
                    <tbody>
                      {(orders.data ?? []).map((o: any) => (
                        <tr key={o.id}>
                          <td>{o.order_no}{o.company_order_no && <span className="small muted"> · CO {o.company_order_no}</span>}<div className="small muted">{o.product_name} · {o.bags} bags{o.due_date ? ` · due ${d(o.due_date)}` : ''}</div></td>
                          <td className="num">{toP(o.payable) > 0n ? rs(o.payable) : toP(o.payable) < 0n ? <span className="muted">advance {rs(fromP(-toP(o.payable)))}</span> : <span className="muted">not invoiced</span>}</td>
                          <td className="num"><input className="input num" style={{ width: 120 }} value={alloc[o.id] ?? ''} onChange={(e) => setAlloc({ ...alloc, [o.id]: amountInput(e.target.value) })} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <div className="totals">
                  <div><span>Allocated to orders</span><strong>{rs(fromP(allocated), { keepZero: true })}</strong></div>
                  <div><span>{allocated > total ? 'Over-allocated' : 'Not allocated'}</span><strong style={allocated > total ? { color: 'var(--red-tx)' } : undefined}>{rs(fromP(total - allocated), { keepZero: true })}</strong></div>
                </div>
              </div>
            )}
          </div>
        </Panel>
      </div>
      {refMissing && moneyId && total > 0n && <div className="note note-amber" style={{ marginTop: 12 }}>Enter the {REF_LABEL[mode]?.toLowerCase() ?? 'reference'}.</div>}
      <FormError error={err} />
      <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
        <button className="btn btn-primary" disabled={!canPost} onClick={async () => {
          setBusy(true);
          setErr(null);
          try {
            const r = await api.post('/api/vouchers', {
              kind, businessDate: date, moneyAccountId: moneyId, mode, referenceNo: mode === 'cash' ? null : ref.trim() || null,
              partyId: party?.id ?? null, narration: narration.trim(),
              lines: lines.map((l) => ({ accountId: Number(l.accountId), amount: fromP(toP(l.amount)), partyId: l.party?.id ?? null, memo: l.memo.trim() || null })),
              allocations: allocating ? Object.entries(alloc).filter(([, v]) => toP(v) > 0n).map(([id, v]) => ({ companyOrderId: Number(id), amount: fromP(toP(v)) })) : [],
              attachment: proof ? { mime: proof.mime, data: proof.data } : null
            }, key.key());
            toast(`${r.entryNo} posted`);
            setDone(r);
          } catch (e) { setErr(e); } finally { setBusy(false); }
        }}>{busy ? 'Posting…' : `Post ${kind === 'payment' ? 'payment' : 'receipt'} · ${rs(fromP(total), { keepZero: true })}`}</button>
      </div>
    </>
  );
}

export function VoucherDetail() {
  const { id } = useParams();
  const { can } = useSession();
  const toast = useToast();
  const v = useApi(() => api.get(`/api/vouchers/${id}`), [id]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (v.loading && !v.data) return <Loading />;
  if (v.error) return <ErrorBox error={v.error} onRetry={v.reload} />;
  const x = v.data;
  return (
    <>
      <PageHead kicker={KIND_LABEL[x.kind as Kind]} title={x.entry_no} sub={<>{d(x.business_date)} · {MODE_LABEL[x.mode] ?? x.mode}{x.reference_no ? ` ${x.reference_no}` : ''} · {x.money_account_code} {x.money_account_name}</>}>
        <Link className="btn" to={`/ledger/journals/${x.journal_entry_id}`}>Ledger entry{x.reversed ? '' : ' · request reversal'}</Link>
      </PageHead>
      {x.reversed && <div className="note note-amber" style={{ marginBottom: 12 }}>Reversed by {x.reversed_by_no}. It no longer counts against any order.</div>}
      <div className="stack">
        <Panel>
          <div className="stack">
            <div><strong>{rs(x.amount)}</strong> {x.kind === 'payment' ? 'paid to' : 'received from'} {x.party_name ?? '—'}</div>
            <div>{x.narration}</div>
            <div className="small muted">Entered by {x.created_by_name} at {dt(x.created_at)}</div>
          </div>
        </Panel>
        <Panel pad={false}>
          <table className="t">
            <thead><tr><th>Account</th><th>Party</th><th>Memo</th><th className="num">Debit</th><th className="num">Credit</th></tr></thead>
            <tbody>
              {x.lines.map((l: any) => (
                <tr key={l.line_no}>
                  <td><Link to={`/ledger/accounts/${l.account_id}`}>{l.account_code}</Link> {l.account_name}</td>
                  <td className="small">{l.party_name ?? ''}</td><td className="small">{l.memo ?? ''}</td>
                  <td className="num">{toP(l.debit) ? rs(l.debit) : ''}</td><td className="num">{toP(l.credit) ? rs(l.credit) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
        {x.allocations.length > 0 && (
          <Panel title="Against company orders" pad={false}>
            <table className="t">
              <tbody>{x.allocations.map((a: any) => <tr key={a.id}><td><Link to={`/purchases/orders/${a.company_order_id}`}>{a.order_no}</Link>{a.company_order_no ? ` · CO ${a.company_order_no}` : ''}</td><td className="num">{rs(a.amount)}</td></tr>)}</tbody>
            </table>
          </Panel>
        )}
        <Panel title="Proof" actions={can('voucher.create') && (
          <label className="btn btn-sm">
            {busy ? 'Uploading…' : 'Add file'}
            <input type="file" accept="image/*,application/pdf" style={{ display: 'none' }} disabled={busy} onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              setBusy(true);
              setErr(null);
              try {
                const p = await readProof(file);
                await api.post(`/api/vouchers/${x.id}/attachments`, { mime: p.mime, data: p.data });
                toast('Proof added');
                await v.reload();
              } catch (z) { setErr(z instanceof Error ? z.message : String(z)); } finally { setBusy(false); }
            }} />
          </label>
        )}>
          {err && <div className="note note-red">{err}</div>}
          {!x.attachments.length ? <Empty>No proof attached.</Empty> : (
            <div className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-start' }}>
              {x.attachments.map((a: any) => <Proof key={a.id} voucherId={x.id} a={a} />)}
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}

function Proof({ voucherId, a }: { voucherId: number; a: any }) {
  const [url, setUrl] = useState<string | null>(null);
  const path = `/api/vouchers/${voucherId}/attachments/${a.id}`;
  useEffect(() => {
    if (a.mime === 'application/pdf') return;
    let u: string | null = null;
    api.blobUrl(path).then((x) => { u = x; setUrl(x); }).catch(() => undefined);
    return () => { if (u) URL.revokeObjectURL(u); };
  }, [path, a.mime]);
  if (a.mime === 'application/pdf') {
    return <button className="btn" onClick={async () => window.open(await api.blobUrl(path), '_blank', 'noopener')}>Open PDF · {Math.round(a.size / 1024)} KB</button>;
  }
  return url ? <a href={url} target="_blank" rel="noreferrer"><img src={url} alt="Proof of payment" style={{ maxWidth: 320, maxHeight: 240, objectFit: 'contain', border: '1px solid var(--divider)' }} /></a> : <span className="muted small">Loading…</span>;
}

// ---------------- Opening balances ----------------
interface OLine { accountId: number | ''; party: any; debit: string; credit: string; memo: string }
const blankO = (): OLine => ({ accountId: '', party: null, debit: '', credit: '', memo: '' });

export function OpeningVoucher() {
  const nav = useNavigate();
  const toast = useToast();
  const key = useSubmitKey();
  const accounts = useApi(() => api.get('/api/accounts'), []);
  const [date, setDate] = useState('');
  const [narration, setNarration] = useState('Opening balances');
  const [lines, setLines] = useState<OLine[]>([blankO(), blankO()]);
  const [toEquity, setToEquity] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const postable = (accounts.data ?? []).filter((a: any) => a.postable && a.active);
  const byId = useMemo(() => new Map(postable.map((a: any) => [a.id, a])), [accounts.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const td = lines.reduce((s, l) => s + toP(l.debit), 0n);
  const tc = lines.reduce((s, l) => s + toP(l.credit), 0n);
  const set = (i: number, patch: Partial<OLine>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const needsParty = (l: OLine) => { const a: any = l.accountId ? byId.get(l.accountId) : null; return !!a && ['receivable', 'payable'].includes(a.control); };
  const problem = lines.some((l) => !l.accountId || (toP(l.debit) > 0n) === (toP(l.credit) > 0n) || (needsParty(l) && !l.party));
  return (
    <>
      <PageHead kicker="Accounts" title="Opening balances (OPV)" sub="Balances brought forward from EduSoft or the old books: cash, banks, what customers owe, what AKB owes the companies. The owner approves before it is posted." />
      <Panel>
        <div className="stack">
          <div className="form-grid">
            <Field label="As at date" hint="Usually the day before the new system starts"><input type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
            <Field label="Narration"><input className="input" value={narration} onChange={(e) => setNarration(e.target.value)} /></Field>
          </div>
          <div className="table-wrap">
            <table className="t">
              <thead><tr><th>Account</th><th>Party</th><th className="num">Debit</th><th className="num">Credit</th><th /></tr></thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={i}>
                    <td style={{ minWidth: 220 }}>
                      <select className="input" value={l.accountId} onChange={(e) => set(i, { accountId: e.target.value ? Number(e.target.value) : '', party: null })}>
                        <option value="">Choose…</option>
                        {postable.map((a: any) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
                      </select>
                    </td>
                    <td style={{ minWidth: 220 }}>{needsParty(l) ? <PartyPicker value={l.party} onChange={(p) => set(i, { party: p })} placeholder="Required" /> : <span className="muted small">—</span>}</td>
                    <td><input className="input num" style={{ width: 130 }} value={l.debit} onChange={(e) => set(i, { debit: amountInput(e.target.value), credit: e.target.value ? '' : l.credit })} /></td>
                    <td><input className="input num" style={{ width: 130 }} value={l.credit} onChange={(e) => set(i, { credit: amountInput(e.target.value), debit: e.target.value ? '' : l.debit })} /></td>
                    <td>{lines.length > 1 && <button className="btn btn-sm btn-ghost" onClick={() => setLines(lines.filter((_, j) => j !== i))}>Remove</button>}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={2}><button className="btn btn-sm" onClick={() => setLines([...lines, blankO()])}>Add line</button></td>
                  <td className="num">{rs(fromP(td), { keepZero: true })}</td><td className="num">{rs(fromP(tc), { keepZero: true })}</td><td />
                </tr>
              </tfoot>
            </table>
          </div>
          {td !== tc && (
            <div className="note note-amber row" style={{ flexWrap: 'wrap' }}>
              <span>Debits and credits differ by {rs(fromP(td > tc ? td - tc : tc - td))}.</span>
              <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={toEquity} onChange={(e) => setToEquity(e.target.checked)} /> Put the difference to Opening equity (3300)</label>
            </div>
          )}
          <FormError error={err} />
          <div className="dialog-actions">
            <button className="btn" onClick={() => nav('/vouchers')}>Cancel</button>
            <button className="btn btn-primary" disabled={busy || !date || problem || td + tc === 0n || (td !== tc && !toEquity) || narration.trim().length < 3} onClick={async () => {
              setBusy(true);
              setErr(null);
              try {
                const r = await api.post('/api/vouchers/opening', {
                  businessDate: date, narration: narration.trim(), balanceToEquity: td !== tc && toEquity,
                  lines: lines.map((l) => ({ accountId: Number(l.accountId), partyId: l.party?.id ?? null, debit: fromP(toP(l.debit)), credit: fromP(toP(l.credit)), memo: l.memo || null }))
                }, key.key());
                key.renew();
                toast('Sent to the owner for approval');
                nav(`/ledger/journals/${r.id}`);
              } catch (e) { setErr(e); } finally { setBusy(false); }
            }}>Send for approval</button>
          </div>
        </div>
      </Panel>
    </>
  );
}
