import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { bags, d, dt, rs } from '../lib/format';
import { useSession } from '../lib/session';
import { Confirm, ErrorBox, Field, Loading, PageHead, Panel, useApi, useToast } from '../components/ui';

export function DayClose() {
  const { me, can } = useSession();
  const toast = useToast();
  const [date, setDate] = useState(me!.businessDate);
  const day = useApi(() => api.get(`/api/days/${date}`), [date]);
  const [counts, setCounts] = useState<Record<number, string>>({});
  const [note, setNote] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [sha, setSha] = useState<string | null>(null);

  if (day.loading && !day.data) return <Loading />;
  if (day.error) return <ErrorBox error={day.error} onRetry={day.reload} />;
  const x = day.data;
  const locked = x.status === 'locked';
  const active = (a: any) => Number(a.closing) !== 0 || Number(a.receipts) !== 0 || Number(a.payments) !== 0;
  const diff = (a: any) => (counts[a.account_id] === undefined || counts[a.account_id] === '' ? null : Math.round((Number(counts[a.account_id]) - Number(a.closing)) * 100) / 100);
  const missing = x.accounts.filter((a: any) => active(a) && diff(a) === null);
  const mismatched = x.accounts.filter((a: any) => diff(a) !== null && diff(a) !== 0);
  const ready = !locked && !missing.length && !mismatched.length && !x.pendingApprovals.length;

  const download = async (format: 'xlsx' | 'csv') => {
    try {
      const s = await api.download(`/api/days/${date}/daybook?format=${format}`, `AKB-daybook-${date}.${format}`);
      setSha(s);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Download failed');
    }
  };

  return (
    <>
      <PageHead kicker="Accounts" title="Day close" sub="Count the cash, match each bank to its statement, then lock the day. Once locked nothing can be posted to it, and the day book is saved with a checksum.">
        <Field label="Business date"><input type="date" className="input" value={date} max={me!.businessDate} onChange={(e) => { setDate(e.target.value); setCounts({}); setSha(null); }} /></Field>
      </PageHead>

      {x.earlierOpenDays.length > 0 && (
        <div className="note note-amber" style={{ marginBottom: 12 }}>
          Earlier days with entries are still open: {x.earlierOpenDays.map((r: any) => (
            <button key={r.business_date} className="btn btn-sm btn-ghost" onClick={() => setDate(r.business_date)}>{d(r.business_date)}</button>
          ))}
        </div>
      )}

      <div className="grid4" style={{ marginBottom: 16 }}>
        <div className="kpi"><div className="label">Status</div><div className="value">{locked ? 'Locked' : 'Open'}</div><div className="sub">{locked ? `by ${x.day.locked_by_name} · ${dt(x.day.locked_at)}` : d(date)}</div></div>
        <div className="kpi"><div className="label">Entries posted</div><div className="value">{x.counts.entries}</div><div className="sub">{x.counts.receipts} receipts · {x.counts.ogs} OGs</div></div>
        <div className="kpi"><div className="label">Dispatched</div><div className="value">{bags(x.counts.bags_dispatched)} bags</div><div className="sub">{x.counts.dispatches} trucks</div></div>
        <div className="kpi"><div className="label">Received</div><div className="value">{bags(x.counts.bags_received)} bags</div><div className="sub">into godowns</div></div>
      </div>

      <div className="stack">
        <Panel title="Cash and bank" pad={false}>
          <div className="table-wrap">
            <table className="t">
              <thead><tr><th>Account</th><th className="num">Opening</th><th className="num">Received</th><th className="num">Paid out</th><th className="num">System closing</th><th className="num">{locked ? 'Counted' : 'Counted / statement'}</th><th className="num">Difference</th></tr></thead>
              <tbody>
                {x.accounts.map((a: any) => {
                  const lockedRow = locked ? x.day.checklist?.accounts?.find((c: any) => c.accountId === a.account_id) : null;
                  const df = locked ? (lockedRow ? Number(lockedRow.difference) : null) : diff(a);
                  return (
                    <tr key={a.account_id} className={active(a) ? '' : 'muted'}>
                      <td><Link to={`/ledger/accounts/${a.account_id}`}>{a.code}</Link> {a.name}<div className="small muted">{a.control === 'cash' ? 'count the cash' : 'match to bank statement'}</div></td>
                      <td className="num">{rs(a.opening, { keepZero: true })}</td>
                      <td className="num">{rs(a.receipts, { keepZero: true })}</td>
                      <td className="num">{rs(a.payments, { keepZero: true })}</td>
                      <td className="num"><strong>{rs(a.closing, { keepZero: true })}</strong></td>
                      <td className="num">
                        {locked ? (lockedRow ? rs(lockedRow.counted, { keepZero: true }) : '—') : (
                          <input className="input num" style={{ width: 140 }} inputMode="decimal" value={counts[a.account_id] ?? ''} placeholder={active(a) ? 'required' : ''}
                            onChange={(e) => setCounts({ ...counts, [a.account_id]: e.target.value.replace(/[^\d.-]/g, '') })} />
                        )}
                      </td>
                      <td className="num">{df === null ? '' : df === 0 ? <span style={{ color: 'var(--green)' }}>Matches</span> : <span style={{ color: 'var(--red-tx)' }}>{rs(String(df))}</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Panel>

        {!locked && (x.pendingApprovals.length > 0 || x.unallocatedReceipts.length > 0) && (
          <Panel title="Before you lock">
            <div className="stack">
              {x.pendingApprovals.length > 0 && (
                <div className="note note-red">
                  {x.pendingApprovals.length} journal{x.pendingApprovals.length === 1 ? '' : 's'} on this date still waiting for approval. They must be approved or sent back first.
                  {x.pendingApprovals.map((p: any) => <div key={p.id} className="small"><Link to={`/ledger/journals/${p.id}`}>{p.narration}</Link></div>)}
                </div>
              )}
              {x.unallocatedReceipts.length > 0 && (
                <div className="note note-amber">
                  Receipts not fully allocated to OGs (held as advances; this does not stop the lock):
                  {x.unallocatedReceipts.map((r: any) => <div key={r.id} className="small">{r.receipt_no} · {r.party_name} · {rs(r.unallocated)}</div>)}
                </div>
              )}
            </div>
          </Panel>
        )}

        {locked ? (
          <Panel title="Day book">
            <div className="stack">
              <div>The day book was generated when the day was locked. Downloads return exactly that file, and every download is logged.</div>
              <div className="small">Excel checksum (SHA-256): <span className="mono">{x.day.export_sha256}</span></div>
              <div className="small">CSV checksum (SHA-256): <span className="mono">{x.day.csv_sha256}</span></div>
              {can('daybook.export') && (
                <div className="row">
                  <button className="btn btn-primary" onClick={() => download('xlsx')}>Download Excel</button>
                  <button className="btn" onClick={() => download('csv')}>Download CSV</button>
                </div>
              )}
              {sha && <div className="note note-green small">Downloaded. Checksum <span className="mono">{sha}</span>. Keep it with the file; if the file is ever changed, its checksum will not match.</div>}
            </div>
          </Panel>
        ) : can('day.close') && (
          <Panel>
            <div className="stack">
              <Field label="Note (optional)"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
              {missing.length > 0 && <div className="small muted">Still to enter: {missing.map((a: any) => a.name).join(', ')}</div>}
              {mismatched.length > 0 && <div className="small" style={{ color: 'var(--red-tx)' }}>Find the difference before locking: {mismatched.map((a: any) => a.name).join(', ')}</div>}
              <div className="row" style={{ justifyContent: 'flex-end' }}>
                <button className="btn btn-primary" disabled={!ready} onClick={() => setConfirm(true)}>Lock {d(date)}</button>
              </div>
            </div>
          </Panel>
        )}
      </div>

      {confirm && (
        <Confirm
          title={`Lock ${d(date)}?`}
          body="After locking, nothing can be posted to this date by anyone. Corrections go on a later date as reversals. The day book is saved now."
          confirmLabel="Lock the day"
          onClose={() => setConfirm(false)}
          onConfirm={async () => {
            await api.post(`/api/days/${date}/lock`, {
              counts: Object.entries(counts).filter(([, v]) => v !== '').map(([accountId, amount]) => ({ accountId: Number(accountId), amount: Number(amount).toFixed(2) })),
              note: note || null
            }, crypto.randomUUID());
            toast(`${d(date)} locked`);
            await day.reload();
          }}
        />
      )}
    </>
  );
}
