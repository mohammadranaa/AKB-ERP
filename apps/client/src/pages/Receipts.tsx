import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, qs } from '../lib/api';
import { d, rs } from '../lib/format';
import { useSession } from '../lib/session';
import { Confirm, Empty, ErrorBox, Field, FormError, Loading, PageHead, Panel, PaymentPill, Seg, useApi, useSubmitKey, useToast } from '../components/ui';
import { uuid } from '../lib/uuid';

const MODE: Record<string, string> = { cash: 'Cash', cheque: 'Cheque', bank_transfer: 'Bank transfer', online: 'Online' };

// paisa helpers so allocation arithmetic never uses floating point
const toP = (v: string | number) => {
  const s = String(v).trim();
  if (!s) return 0n;
  const neg = s.startsWith('-');
  const [i, f = ''] = s.replace('-', '').split('.');
  const p = BigInt(i || '0') * 100n + BigInt((f + '00').slice(0, 2));
  return neg ? -p : p;
};
const fromP = (p: bigint) => {
  const neg = p < 0n;
  const a = neg ? -p : p;
  return `${neg ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`;
};

export function Receipts() {
  const { can } = useSession();
  const toast = useToast();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const list = useApi(() => api.get(`/api/receipts${qs({ from, to })}`), [from, to]);
  const [ret, setRet] = useState<any>(null);
  const [charges, setCharges] = useState('0');
  return (
    <>
      <PageHead kicker="Accounts" title="Receipts" sub="Money received from customers. A returned cheque reverses its receipt and the OGs it paid become unpaid again.">
        {can('receipt.create') && <Link className="btn btn-primary" to="/receipts/new">New receipt</Link>}
      </PageHead>
      <div className="row" style={{ marginBottom: 12 }}>
        <Field label="From"><input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To"><input type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>
      <Panel pad={false}>
        {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : !list.data.length ? <Empty>No receipts in this period.</Empty> : (
          <div className="table-wrap">
            <table className="t">
              <thead><tr><th>Receipt</th><th>Date</th><th>Customer</th><th>Mode</th><th>Into</th><th className="num">Amount</th><th className="num">Unallocated</th><th>Status</th><th /></tr></thead>
              <tbody>
                {list.data.map((r: any) => (
                  <tr key={r.id}>
                    <td>{r.receipt_no}<div className="small muted">{r.entry_no}</div></td>
                    <td>{d(r.business_date)}<div className="small muted">{r.created_by_name}</div></td>
                    <td><Link to={`/customers/${r.party_id}`}>{r.party_name}</Link></td>
                    <td>{MODE[r.mode] ?? r.mode}{r.instrument_no && <div className="small muted">{r.instrument_no}{r.drawer_bank ? ` · ${r.drawer_bank}` : ''}</div>}</td>
                    <td className="small">{r.account_name}</td>
                    <td className="num">{rs(r.amount)}</td>
                    <td className="num">{Number(r.unallocated) > 0 ? <span style={{ color: 'var(--amber-tx)' }}>{rs(r.unallocated)}</span> : <span className="muted">—</span>}</td>
                    <td>{r.status === 'returned' ? <span className="chip chip-red">Cheque returned</span> : <span className="chip chip-green">Posted</span>}</td>
                    <td>{r.mode === 'cheque' && r.status === 'posted' && can('cheque.return') && <button className="btn btn-sm" onClick={() => { setCharges('0'); setRet(r); }}>Cheque returned</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      {ret && (
        <Confirm
          title={`Cheque ${ret.instrument_no} returned?`}
          danger
          confirmLabel="Record return"
          needComment="Reason the bank gave (required)"
          body={
            <div className="stack">
              <div>This reverses {ret.receipt_no} for {rs(ret.amount)} from {ret.party_name}. Any OGs it paid become unpaid again. This cannot be undone.</div>
              <Field label="Bank charges passed to the customer (Rs)"><input className="input num" value={charges} onChange={(e) => setCharges(e.target.value.replace(/[^\d.]/g, ''))} /></Field>
            </div>
          }
          onClose={() => setRet(null)}
          onConfirm={async (reason) => {
            const r = await api.post(`/api/receipts/${ret.id}/return`, { reason, bankCharges: charges || '0' }, uuid());
            toast(`${r.returnNo} recorded`);
            await list.reload();
          }}
        />
      )}
    </>
  );
}

export function NewReceipt() {
  const toast = useToast();
  const nav = useNavigate();
  const key = useSubmitKey();
  const [params] = useSearchParams();
  const [q, setQ] = useState('');
  const customers = useApi(() => api.get(`/api/parties${qs({ kind: 'customer', active: 'true', q })}`), [q]);
  const accounts = useApi(() => api.get('/api/money-accounts'), []);
  const [party, setParty] = useState<any>(null);
  const [mode, setMode] = useState<'cash' | 'cheque' | 'bank_transfer' | 'online'>('cheque');
  const [accountId, setAccount] = useState<number | ''>('');
  const [amount, setAmount] = useState('');
  const [instrumentNo, setInstr] = useState('');
  const [drawerBank, setBank] = useState('');
  const [note, setNote] = useState('');
  const [alloc, setAlloc] = useState<Record<string, string>>({});
  const [dup, setDup] = useState<any[]>([]);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<any>(null);

  // ?party=ID preselects the customer (used from an OG's "Record receipt" action)
  useEffect(() => {
    const id = params.get('party');
    if (id && !party) api.get(`/api/parties/${id}`).then(setParty).catch(() => undefined);
  }, [params, party]);

  const open = useApi(() => (party ? api.get(`/api/receipts/open-ogs?partyId=${party.id}`) : Promise.resolve(null)), [party?.id]);

  const accChoices = (accounts.data ?? []).filter((a: any) => (mode === 'cash' ? a.control === 'cash' : a.control === 'bank'));
  useEffect(() => {
    if (accountId && !accChoices.some((a: any) => a.id === accountId)) setAccount('');
    if (!accountId && accChoices.length === 1) setAccount(accChoices[0].id);
  }, [mode, accounts.data]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (mode !== 'cheque' || instrumentNo.trim().length < 3) { setDup([]); return; }
    const t = setTimeout(() => {
      api.get(`/api/receipts/check-instrument${qs({ no: instrumentNo.trim() })}`).then((r) => setDup(r.matches)).catch(() => setDup([]));
    }, 350);
    return () => clearTimeout(t);
  }, [instrumentNo, mode]);

  const allocated = useMemo(() => Object.values(alloc).reduce((s, v) => s + toP(v || '0'), 0n), [alloc]);
  const amountP = toP(amount || '0');
  const advance = amountP - allocated;

  const autoAllocate = () => {
    let left = amountP;
    const next: Record<string, string> = {};
    for (const o of open.data?.ogs ?? []) {
      if (left <= 0n) break;
      const take = left < toP(o.outstanding) ? left : toP(o.outstanding);
      next[o.id] = fromP(take);
      left -= take;
    }
    setAlloc(next);
  };

  if (done) {
    return (
      <>
        <PageHead kicker="Accounts" title={`Receipt ${done.receiptNo} posted`} />
        <Panel>
          <div className="stack">
            <div className="note note-green">{rs(amount)} received from {party.name_en}. Ledger entry {done.entryNo}.</div>
            <div>Allocated to OGs: <strong>{rs(done.allocated, { keepZero: true })}</strong>{toP(done.advance) > 0n && <> · Held as advance: <strong>{rs(done.advance)}</strong></>}</div>
            <div className="row">
              <button className="btn btn-primary" onClick={() => { setDone(null); setAmount(''); setInstr(''); setBank(''); setNote(''); setAlloc({}); void open.reload(); }}>Another receipt from {party.name_en}</button>
              <button className="btn" onClick={() => { setDone(null); setParty(null); setAmount(''); setInstr(''); setBank(''); setNote(''); setAlloc({}); }}>Different customer</button>
              <button className="btn" onClick={() => nav('/receipts')}>All receipts</button>
            </div>
          </div>
        </Panel>
      </>
    );
  }

  return (
    <>
      <PageHead kicker="Accounts" title="New receipt" sub="Record money received, then say which OGs it pays. Anything not allocated is held as an advance." />
      <div className="split">
        <Panel title="Payment">
          <div className="stack">
            {!party ? (
              <>
                <Field label="Customer"><input className="input" autoFocus placeholder="Search by name or code" value={q} onChange={(e) => setQ(e.target.value)} /></Field>
                <div className="pick-list">
                  {(customers.data ?? []).slice(0, 12).map((c: any) => (
                    <button key={c.id} className="pick" onClick={() => setParty(c)}>
                      <span>{c.name_en} <span className="muted small">{c.code} · {c.city}</span></span>
                      <span className="small">{rs(c.balance, { keepZero: true })}</span>
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <div className="row">
                <div><strong>{party.name_en}</strong> <span className="muted small">{party.code} · {party.city}</span></div>
                <span className="spacer" />
                <button className="btn btn-sm btn-ghost" onClick={() => { setParty(null); setAlloc({}); }}>Change</button>
              </div>
            )}
            <Seg value={mode} options={[['cheque', 'Cheque'], ['bank_transfer', 'Bank transfer'], ['online', 'Online'], ['cash', 'Cash']]} onChange={setMode} />
            <div className="form-grid">
              <Field label="Amount (Rs)"><input className="input num" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))} /></Field>
              <Field label={mode === 'cash' ? 'Cash account' : 'Received into bank'}>
                <select className="input" value={accountId} onChange={(e) => setAccount(e.target.value ? Number(e.target.value) : '')}>
                  <option value="">Choose…</option>
                  {accChoices.map((a: any) => <option key={a.id} value={a.id}>{a.name}{a.account_no ? ` · ${a.account_no}` : ''}</option>)}
                </select>
              </Field>
              {mode !== 'cash' && <Field label={mode === 'cheque' ? 'Cheque number' : 'Transaction reference'}><input className="input" value={instrumentNo} onChange={(e) => setInstr(e.target.value)} /></Field>}
              {mode === 'cheque' && <Field label="Drawn on bank"><input className="input" value={drawerBank} onChange={(e) => setBank(e.target.value)} placeholder="e.g. HBL Sahiwal" /></Field>}
            </div>
            {dup.length > 0 && (
              <div className="note note-amber">
                Cheque {instrumentNo} has been entered before:
                {dup.map((m, i) => <div key={i} className="small">{m.receipt_no} · {d(m.business_date)} · {m.party_name} · {m.drawer_bank} · {rs(m.amount)} · {m.status}</div>)}
                <div className="small">The same number from a different bank is allowed; from the same bank it will be refused.</div>
              </div>
            )}
            <Field label="Note"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          </div>
        </Panel>

        <Panel title="Allocate to OGs" actions={party && open.data?.ogs.length ? <button className="btn btn-sm" disabled={!amountP} onClick={autoAllocate}>Oldest first</button> : undefined}>
          {!party ? <Empty>Choose a customer to see their unpaid OGs.</Empty> : open.error ? <ErrorBox error={open.error} /> : !open.data ? <Loading /> : (
            <div className="stack">
              <div className="row small">
                <span>Balance owed <strong>{rs(open.data.balance, { keepZero: true })}</strong></span>
                {toP(open.data.unallocatedReceipts) > 0n && <span className="muted">· earlier advances {rs(open.data.unallocatedReceipts)}</span>}
              </div>
              {!open.data.ogs.length ? <Empty>No unpaid OGs. The whole amount will be held as an advance.</Empty> : (
                <table className="t">
                  <thead><tr><th>OG</th><th className="num">Outstanding</th><th className="num">Pay now</th></tr></thead>
                  <tbody>
                    {open.data.ogs.map((o: any) => (
                      <tr key={o.id}>
                        <td><Link to={`/ogs/${o.id}`}>{o.og_no}</Link> <PaymentPill s={o.payment} /><div className="small muted">{d(o.business_date)} · {o.products}{o.due_date ? ` · due ${d(o.due_date)}` : ''}</div></td>
                        <td className="num">{rs(o.outstanding)}</td>
                        <td className="num"><input className="input num" style={{ width: 120 }} value={alloc[o.id] ?? ''} onChange={(e) => setAlloc({ ...alloc, [o.id]: e.target.value.replace(/[^\d.]/g, '') })} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <div className="totals">
                <div><span>Received</span><strong>{rs(fromP(amountP), { keepZero: true })}</strong></div>
                <div><span>Allocated</span><strong>{rs(fromP(allocated), { keepZero: true })}</strong></div>
                <div><span>{advance < 0n ? 'Over-allocated' : 'Held as advance'}</span><strong style={advance < 0n ? { color: 'var(--red-tx)' } : undefined}>{rs(fromP(advance), { keepZero: true })}</strong></div>
              </div>
            </div>
          )}
        </Panel>
      </div>
      <FormError error={err} />
      <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
        <button
          className="btn btn-primary"
          disabled={busy || !party || !accountId || amountP <= 0n || advance < 0n || (mode !== 'cash' && !instrumentNo.trim()) || (mode === 'cheque' && !drawerBank.trim())}
          onClick={async () => {
            setBusy(true);
            setErr(null);
            try {
              const r = await api.post('/api/receipts', {
                partyId: party.id, mode, accountId, amount: fromP(amountP),
                instrumentNo: mode === 'cash' ? null : instrumentNo.trim(), drawerBank: mode === 'cheque' ? drawerBank.trim() : null, note: note || null,
                allocations: Object.entries(alloc).filter(([, v]) => toP(v || '0') > 0n).map(([ogId, v]) => ({ ogId: Number(ogId), amount: fromP(toP(v)) }))
              }, key.key());
              key.renew();
              toast(`${r.receiptNo} posted`);
              setDone(r);
            } catch (e) { setErr(e); } finally { setBusy(false); }
          }}
        >
          {busy ? 'Posting…' : 'Post receipt'}
        </button>
      </div>
    </>
  );
}


