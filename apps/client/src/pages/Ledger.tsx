import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, qs } from '../lib/api';
import { d, dt, rs } from '../lib/format';
import { useSession } from '../lib/session';
import { Confirm, Empty, ErrorBox, Field, FormError, Loading, PageHead, Panel, useApi, useSubmitKey, useToast } from '../components/ui';

const SOURCE: Record<string, string> = {
  manual: 'Manual journal', receipt: 'Receipt', dispatch: 'Dispatch', reversal: 'Reversal', opening: 'Opening balance', import_opening: 'Opening balance', import_cashbook: 'Cash book import',
  cheque_return_charges: 'Cheque return charges', freight: 'Freight'
};
const STATUS: Record<string, [string, string]> = {
  posted: ['Posted', 'chip-green'], pending_approval: ['Waiting for approval', 'chip-amber'], draft: ['Sent back', 'chip'], rejected: ['Rejected', 'chip-red']
};

const toP = (v: string) => {
  const s = v.trim();
  if (!s) return 0n;
  const [i, f = ''] = s.split('.');
  return BigInt(i || '0') * 100n + BigInt((f + '00').slice(0, 2));
};
const fromP = (p: bigint) => `${p / 100n}.${String(p % 100n).padStart(2, '0')}`;

export function Journals() {
  const { can } = useSession();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [status, setStatus] = useState('');
  const [source, setSource] = useState('');
  const list = useApi(() => api.get(`/api/ledger/journals${qs({ from, to, status, source })}`), [from, to, status, source]);
  return (
    <>
      <PageHead kicker="Ledger" title="Journal entries" sub="Every rupee that moves is recorded here as a balanced entry. Posted entries cannot be edited; they are corrected by a reversal.">
        {can('journal.create') && <Link className="btn btn-primary" to="/ledger/journals/new">New journal</Link>}
      </PageHead>
      <div className="row" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
        <Field label="From"><input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To"><input type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        <Field label="Status">
          <select className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            {Object.entries(STATUS).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </Field>
        <Field label="Source">
          <select className="input" value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="">All</option>
            {Object.entries(SOURCE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </Field>
      </div>
      <Panel pad={false}>
        {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : !list.data.length ? <Empty>No entries match.</Empty> : (
          <div className="table-wrap">
            <table className="t">
              <thead><tr><th>Entry</th><th>Date</th><th>Narration</th><th>Source</th><th className="num">Amount</th><th>Status</th><th>By</th></tr></thead>
              <tbody>
                {list.data.map((e: any) => {
                  const [label, cls] = STATUS[e.status] ?? [e.status, 'chip'];
                  return (
                    <tr key={e.id}>
                      <td><Link to={`/ledger/journals/${e.id}`}>{e.entry_no ?? '(unnumbered)'}</Link></td>
                      <td>{d(e.business_date)}</td>
                      <td>{e.narration}{(e.reversal_of || e.reversed_by) && <div className="small muted">{e.reversal_of ? 'Reversal entry' : 'Reversed'}</div>}</td>
                      <td className="small">{SOURCE[e.source_type] ?? e.source_type}{e.source_id && <div className="muted">{e.source_id}</div>}</td>
                      <td className="num">{rs(e.amount)}</td>
                      <td><span className={`chip ${cls}`}>{label}</span></td>
                      <td className="small">{e.created_by_name}{e.approved_by_name && <div className="muted">approved {e.approved_by_name}</div>}</td>
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

export function JournalDetail() {
  const { id } = useParams();
  const { can, me } = useSession();
  const toast = useToast();
  const e = useApi(() => api.get(`/api/ledger/journals/${id}`), [id]);
  const [ask, setAsk] = useState<'reverse' | 'approve' | 'reject' | null>(null);
  if (e.loading && !e.data) return <Loading />;
  if (e.error) return <ErrorBox error={e.error} />;
  const j = e.data;
  const [label, cls] = STATUS[j.status] ?? [j.status, 'chip'];
  const td = j.lines.reduce((s: bigint, l: any) => s + toP(l.debit), 0n);
  const tc = j.lines.reduce((s: bigint, l: any) => s + toP(l.credit), 0n);
  const reversible = j.status === 'posted' && !j.reversed_by && !j.reversal_of && !['receipt', 'dispatch'].includes(j.source_type);
  return (
    <>
      <PageHead kicker="Journal entry" title={j.entry_no ?? 'Unnumbered entry'} sub={<>{d(j.business_date)} · {SOURCE[j.source_type] ?? j.source_type}{j.source_id ? ` ${j.source_id}` : ''} · <span className={`chip ${cls}`}>{label}</span></>}>
        {j.status === 'pending_approval' && can('journal.approve') && j.created_by !== me!.id && (
          <>
            <button className="btn" onClick={() => setAsk('reject')}>Send back</button>
            <button className="btn btn-primary" onClick={() => setAsk('approve')}>Approve and post</button>
          </>
        )}
        {reversible && can('reversal.request') && <button className="btn" onClick={() => setAsk('reverse')}>Request reversal</button>}
      </PageHead>
      <div className="stack">
        <Panel>
          <div className="stack">
            <div>{j.narration}</div>
            <div className="small muted">
              Entered by {j.created_by_name} at {dt(j.created_at)}
              {j.approved_by_name && <> · approved by {j.approved_by_name} at {dt(j.approved_at)}</>}
            </div>
            {j.reversal_of_no && <div className="note">This entry reverses <Link to={`/ledger/journals/${j.reversal_of}`}>{j.reversal_of_no}</Link>.</div>}
            {j.reversed_by_no && <div className="note note-amber">This entry was reversed by <Link to={`/ledger/journals/${j.reversed_by}`}>{j.reversed_by_no}</Link>.</div>}
          </div>
        </Panel>
        <Panel pad={false}>
          <table className="t">
            <thead><tr><th>#</th><th>Account</th><th>Party</th><th>Branch</th><th>Memo</th><th className="num">Debit</th><th className="num">Credit</th></tr></thead>
            <tbody>
              {j.lines.map((l: any) => (
                <tr key={l.line_no}>
                  <td className="small muted">{l.line_no}</td>
                  <td><Link to={`/ledger/accounts/${l.account_id}`}>{l.account_code}</Link> {l.account_name}</td>
                  <td className="small">{l.party_name ?? ''}</td>
                  <td className="small">{l.branch_code ?? ''}</td>
                  <td className="small">{l.memo ?? ''}</td>
                  <td className="num">{toP(l.debit) ? rs(l.debit) : ''}</td>
                  <td className="num">{toP(l.credit) ? rs(l.credit) : ''}</td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr><td colSpan={5}>Total</td><td className="num">{rs(fromP(td))}</td><td className="num">{rs(fromP(tc))}</td></tr></tfoot>
          </table>
        </Panel>
      </div>
      {ask === 'reverse' && (
        <Confirm
          title={`Request reversal of ${j.entry_no}?`}
          body="A second person must approve. When approved, an opposite entry is posted on the date it is approved; this entry stays in the books."
          confirmLabel="Send request"
          needComment="Reason (required, at least 5 characters)"
          onClose={() => setAsk(null)}
          onConfirm={async (reason) => {
            await api.post(`/api/ledger/journals/${j.id}/reversal-requests`, { reason });
            toast('Reversal request sent for approval');
          }}
        />
      )}
      {(ask === 'approve' || ask === 'reject') && (
        <Confirm
          title={ask === 'approve' ? 'Approve and post this journal?' : 'Send this journal back?'}
          body={ask === 'approve' ? 'It is posted to the ledger with a number and cannot be edited afterwards.' : 'It returns to the person who entered it. Nothing is posted.'}
          confirmLabel={ask === 'approve' ? 'Approve' : 'Send back'}
          danger={ask === 'reject'}
          needComment
          onClose={() => setAsk(null)}
          onConfirm={async (comment) => {
            await api.post(`/api/ledger/journals/${j.id}/${ask}`, { comment });
            toast(ask === 'approve' ? 'Posted' : 'Sent back');
            await e.reload();
          }}
        />
      )}
    </>
  );
}

interface Line { accountId: number | ''; partyId: number | ''; costCentreId: number | ''; debit: string; credit: string; memo: string }
const blank = (): Line => ({ accountId: '', partyId: '', costCentreId: '', debit: '', credit: '', memo: '' });

export function NewJournal() {
  const nav = useNavigate();
  const toast = useToast();
  const key = useSubmitKey();
  const { me } = useSession();
  const accounts = useApi(() => api.get('/api/accounts'), []);
  const parties = useApi(() => api.get('/api/parties?active=true'), []);
  const centres = useApi(() => api.get('/api/cost-centres'), []);
  const [date, setDate] = useState(me!.businessDate);
  const [narration, setNarration] = useState('');
  const [lines, setLines] = useState<Line[]>([blank(), blank()]);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const postable = (accounts.data ?? []).filter((a: any) => a.postable && a.active);
  const accById = useMemo(() => new Map(postable.map((a: any) => [a.id, a])), [accounts.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const td = lines.reduce((s, l) => s + toP(l.debit), 0n);
  const tc = lines.reduce((s, l) => s + toP(l.credit), 0n);
  const set = (i: number, patch: Partial<Line>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const lineProblem = lines.some((l) => {
    if (!l.accountId) return true;
    const both = toP(l.debit) > 0n && toP(l.credit) > 0n;
    const none = toP(l.debit) === 0n && toP(l.credit) === 0n;
    const a: any = accById.get(l.accountId);
    return both || none || (a && ['receivable', 'payable'].includes(a.control) && !l.partyId);
  });
  const num = (v: string) => v.replace(/[^\d.]/g, '');
  return (
    <>
      <PageHead kicker="Ledger" title="New manual journal" sub="For corrections, accruals and transfers not covered by a screen. A second person must approve before it is posted." />
      <Panel>
        <div className="stack">
          <div className="form-grid">
            <Field label="Date"><input type="date" className="input" value={date} max={me!.businessDate} onChange={(e) => setDate(e.target.value)} /></Field>
            <Field label="Narration"><input className="input" value={narration} onChange={(e) => setNarration(e.target.value)} placeholder="What this entry is for" /></Field>
          </div>
          <div className="table-wrap">
            <table className="t">
              <thead><tr><th>Account</th><th>Party</th><th>Cost centre</th><th>Memo</th><th className="num">Debit</th><th className="num">Credit</th><th /></tr></thead>
              <tbody>
                {lines.map((l, i) => {
                  const a: any = l.accountId ? accById.get(l.accountId) : null;
                  const needsParty = a && ['receivable', 'payable'].includes(a.control);
                  return (
                    <tr key={i}>
                      <td style={{ minWidth: 220 }}>
                        <select className="input" value={l.accountId} onChange={(e) => set(i, { accountId: e.target.value ? Number(e.target.value) : '' })}>
                          <option value="">Choose…</option>
                          {postable.map((x: any) => <option key={x.id} value={x.id}>{x.code} {x.name}</option>)}
                        </select>
                      </td>
                      <td style={{ minWidth: 180 }}>
                        <select className="input" value={l.partyId} onChange={(e) => set(i, { partyId: e.target.value ? Number(e.target.value) : '' })} style={needsParty && !l.partyId ? { borderColor: 'var(--red)' } : undefined}>
                          <option value="">{needsParty ? 'Required…' : '—'}</option>
                          {(parties.data ?? []).map((p: any) => <option key={p.id} value={p.id}>{p.name_en} ({p.kind})</option>)}
                        </select>
                      </td>
                      <td>
                        <select className="input" value={l.costCentreId} onChange={(e) => set(i, { costCentreId: e.target.value ? Number(e.target.value) : '' })}>
                          <option value="">—</option>
                          {(centres.data ?? []).map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </select>
                      </td>
                      <td><input className="input" value={l.memo} onChange={(e) => set(i, { memo: e.target.value })} /></td>
                      <td><input className="input num" style={{ width: 120 }} value={l.debit} onChange={(e) => set(i, { debit: num(e.target.value), credit: num(e.target.value) ? '' : l.credit })} /></td>
                      <td><input className="input num" style={{ width: 120 }} value={l.credit} onChange={(e) => set(i, { credit: num(e.target.value), debit: num(e.target.value) ? '' : l.debit })} /></td>
                      <td>{lines.length > 2 && <button className="btn btn-sm btn-ghost" onClick={() => setLines(lines.filter((_, j) => j !== i))}>Remove</button>}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={4}><button className="btn btn-sm" onClick={() => setLines([...lines, blank()])}>Add line</button></td>
                  <td className="num">{rs(fromP(td), { keepZero: true })}</td>
                  <td className="num">{rs(fromP(tc), { keepZero: true })}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
          {td !== tc && <div className="note note-amber">Debits and credits differ by {rs(fromP(td > tc ? td - tc : tc - td))}.</div>}
          <FormError error={err} />
          <div className="dialog-actions">
            <button className="btn" onClick={() => nav('/ledger/journals')}>Cancel</button>
            <button
              className="btn btn-primary"
              disabled={busy || td === 0n || td !== tc || lineProblem || narration.trim().length < 3}
              onClick={async () => {
                setBusy(true);
                setErr(null);
                try {
                  const r = await api.post('/api/ledger/journals', {
                    businessDate: date, narration,
                    lines: lines.map((l) => ({
                      accountId: Number(l.accountId), partyId: l.partyId || null, costCentreId: l.costCentreId || null,
                      debit: fromP(toP(l.debit)), credit: fromP(toP(l.credit)), memo: l.memo || null
                    }))
                  }, key.key());
                  key.renew();
                  toast('Sent for approval');
                  nav(`/ledger/journals/${r.id}`);
                } catch (e) { setErr(e); } finally { setBusy(false); }
              }}
            >
              Send for approval
            </button>
          </div>
        </div>
      </Panel>
    </>
  );
}

const TYPE_LABEL: Record<string, string> = { asset: 'Assets', liability: 'Liabilities', equity: 'Equity', income: 'Income', expense: 'Expenses' };

export function TrialBalance() {
  const { me } = useSession();
  const [asOf, setAsOf] = useState(me!.businessDate);
  const tb = useApi(() => api.get(`/api/ledger/trial-balance${qs({ asOf })}`), [asOf]);
  return (
    <>
      <PageHead kicker="Ledger" title="Trial balance" sub="Total debits and credits of every account up to the date chosen. They must always be equal.">
        <Field label="As of"><input type="date" className="input" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></Field>
        <button className="btn" onClick={() => window.print()}>Print</button>
      </PageHead>
      {tb.loading && !tb.data ? <Loading /> : tb.error ? <ErrorBox error={tb.error} onRetry={tb.reload} /> : (
        <>
          <div className={`note ${tb.data.totals.balanced ? 'note-green' : 'note-red'}`} style={{ marginBottom: 12 }}>
            {tb.data.totals.balanced ? `Balanced at ${rs(tb.data.totals.debit, { keepZero: true })} on each side.` : 'Debits and credits do not agree. Contact the administrator immediately.'}
          </div>
          <Panel pad={false}>
            <table className="t">
              <thead><tr><th>Code</th><th>Account</th><th className="num">Debit</th><th className="num">Credit</th><th className="num">Balance</th></tr></thead>
              <tbody>
                {Object.keys(TYPE_LABEL).flatMap((type) => {
                  const rows = tb.data.rows.filter((r: any) => r.type === type);
                  if (!rows.length) return [];
                  return [
                    <tr key={type}><td colSpan={5}><strong>{TYPE_LABEL[type]}</strong></td></tr>,
                    ...rows.map((r: any) => (
                      <tr key={r.id}>
                        <td><Link to={`/ledger/accounts/${r.id}`}>{r.code}</Link></td>
                        <td>{r.name}</td>
                        <td className="num">{rs(r.debit, { keepZero: true })}</td>
                        <td className="num">{rs(r.credit, { keepZero: true })}</td>
                        <td className="num">{Number(r.balance) < 0 ? `(${rs(String(-Number(r.balance)))}) Cr` : `${rs(r.balance, { keepZero: true })} Dr`}</td>
                      </tr>
                    ))
                  ];
                })}
              </tbody>
              <tfoot><tr><td colSpan={2}>Total</td><td className="num">{rs(tb.data.totals.debit, { keepZero: true })}</td><td className="num">{rs(tb.data.totals.credit, { keepZero: true })}</td><td /></tr></tfoot>
            </table>
          </Panel>
        </>
      )}
    </>
  );
}

export function AccountLedger() {
  const { id } = useParams();
  const { me } = useSession();
  const [from, setFrom] = useState(() => me!.businessDate.slice(0, 8) + '01');
  const [to, setTo] = useState(me!.businessDate);
  const l = useApi(() => api.get(`/api/ledger/accounts/${id}/ledger${qs({ from, to })}`), [id, from, to]);
  if (l.loading && !l.data) return <Loading />;
  if (l.error) return <ErrorBox error={l.error} />;
  const x = l.data;
  return (
    <>
      <PageHead kicker="Account ledger" title={`${x.account.code} ${x.account.name}`}>
        <Field label="From"><input type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To"><input type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        <button className="btn" onClick={() => window.print()}>Print</button>
      </PageHead>
      <Panel pad={false}>
        <div className="table-wrap">
          <table className="t">
            <thead><tr><th>Date</th><th>Entry</th><th>Narration</th><th>Party</th><th className="num">Debit</th><th className="num">Credit</th><th className="num">Balance</th></tr></thead>
            <tbody>
              <tr><td colSpan={6} className="muted">Opening balance on {d(x.from)}</td><td className="num">{rs(x.opening, { keepZero: true })}</td></tr>
              {x.lines.map((r: any, i: number) => (
                <tr key={i}>
                  <td>{d(r.business_date)}</td>
                  <td className="small"><Link to={`/ledger/journals/${r.entry_id}`}>{r.entry_no}</Link></td>
                  <td>{r.narration}{r.memo && <div className="small muted">{r.memo}</div>}</td>
                  <td className="small">{r.party_name ?? ''}</td>
                  <td className="num">{Number(r.debit) ? rs(r.debit) : ''}</td>
                  <td className="num">{Number(r.credit) ? rs(r.credit) : ''}</td>
                  <td className="num"><strong>{rs(r.running, { keepZero: true })}</strong></td>
                </tr>
              ))}
              {!x.lines.length && <tr><td colSpan={7} className="muted">No entries in this period.</td></tr>}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}
