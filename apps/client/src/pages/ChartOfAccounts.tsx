// Chart of accounts as a tree: groups (headings) with the accounts under them, balances from the ledger.
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, qs } from '../lib/api';
import { rs } from '../lib/format';
import { fromP, toP } from '../lib/money';
import { useSession } from '../lib/session';
import { Dialog, ErrorBox, Field, FormError, Loading, PageHead, Panel, Seg, useApi, useSubmitKey, useToast } from '../components/ui';

const TYPE_LABEL: Record<string, string> = { asset: 'Assets', liability: 'Liabilities', equity: 'Equity', income: 'Income', expense: 'Expenses' };
const CONTROL_LABEL: Record<string, string> = { cash: 'Cash', bank: 'Bank', receivable: 'Customers (by party)', payable: 'Companies (by party)' };

export function ChartOfAccounts() {
  const { can, me } = useSession();
  const toast = useToast();
  const accounts = useApi(() => api.get('/api/accounts'), []);
  const tb = useApi(() => (can('ledger.read') ? api.get(`/api/ledger/trial-balance${qs({ asOf: me!.businessDate })}`) : Promise.resolve(null)), []);
  const [q, setQ] = useState('');
  const [showClosed, setShowClosed] = useState(false);
  const [dialog, setDialog] = useState<{ parent?: any; account?: any } | null>(null);
  const balance = useMemo(() => new Map<number, string>((tb.data?.rows ?? []).map((r: any) => [r.id, r.balance])), [tb.data]);
  const all: any[] = accounts.data ?? [];
  const kids = useMemo(() => {
    const m = new Map<number | null, any[]>();
    for (const a of all) {
      const k = a.parent_id ?? null;
      m.set(k, [...(m.get(k) ?? []), a]);
    }
    for (const v of m.values()) v.sort((x, y) => x.code.localeCompare(y.code, 'en', { numeric: true }));
    return m;
  }, [accounts.data]); // eslint-disable-line react-hooks/exhaustive-deps

  // A group's balance is the sum of everything under it.
  const sumOf = (a: any): bigint => (a.postable ? toP(balance.get(a.id) ?? '0') : (kids.get(a.id) ?? []).reduce((s, k) => s + sumOf(k), 0n));
  const term = q.trim().toLowerCase();
  const matches = (a: any): boolean => (!term || a.code.toLowerCase().startsWith(term) || a.name.toLowerCase().includes(term) || (kids.get(a.id) ?? []).some(matches));

  if (accounts.loading && !accounts.data) return <Loading />;
  if (accounts.error) return <ErrorBox error={accounts.error} onRetry={accounts.reload} />;

  const rows: { a: any; depth: number }[] = [];
  const walk = (parent: number | null, depth: number) => {
    for (const a of kids.get(parent) ?? []) {
      if (!showClosed && !a.active) continue;
      if (!matches(a)) continue;
      rows.push({ a, depth });
      walk(a.id, depth + 1);
    }
  };
  walk(null, 0);
  const manage = can('accounts.manage');

  return (
    <>
      <PageHead kicker="Ledger" title="Chart of accounts" sub="Groups hold accounts; only accounts take entries. Customers and companies are kept by party under Trade receivables and Trade payables, not as separate accounts.">
        {manage && <button className="btn btn-primary" onClick={() => setDialog({})}>Add account</button>}
      </PageHead>
      <div className="row" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
        <input className="input" style={{ maxWidth: 280 }} placeholder="Search code or name" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} /> Show closed accounts</label>
      </div>
      <Panel pad={false}>
        <div className="table-wrap">
          <table className="t">
            <thead><tr><th>Code</th><th>Name</th><th>Kind</th><th className="num">Balance</th><th /></tr></thead>
            <tbody>
              {rows.map(({ a, depth }) => {
                const b = sumOf(a);
                const signed = ['asset', 'expense'].includes(a.type) ? b : -b;
                return (
                  <tr key={a.id} className={a.active ? '' : 'muted'}>
                    <td style={{ paddingLeft: 10 + depth * 18, fontWeight: a.postable ? 400 : 600 }}>{a.code}</td>
                    <td style={{ fontWeight: a.postable ? 400 : 600 }}>
                      {a.postable && can('ledger.read') ? <Link to={`/ledger/accounts/${a.id}`}>{a.name}</Link> : a.name}
                      {a.bank_name && <div className="small muted">{a.bank_name}{a.account_no ? ` · ${a.account_no}` : ''}</div>}
                    </td>
                    <td className="small">{!a.parent_id ? TYPE_LABEL[a.type] : a.postable ? (CONTROL_LABEL[a.control] ?? 'Account') : 'Group'}{!a.active && ' · closed'}</td>
                    <td className="num">{b === 0n ? <span className="muted">—</span> : rs(fromP(signed))}</td>
                    <td>
                      <div className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
                        {manage && !a.postable && a.active && <button className="btn btn-sm" onClick={() => setDialog({ parent: a })}>Add under</button>}
                        {manage && a.parent_id && <button className="btn btn-sm btn-ghost" onClick={() => setDialog({ account: a })}>Edit</button>}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>
      {dialog && (
        <AccountForm
          all={all}
          parent={dialog.parent}
          account={dialog.account}
          onClose={() => setDialog(null)}
          onSaved={(m) => { toast(m); void accounts.reload(); }}
        />
      )}
    </>
  );
}

function AccountForm({ all, parent, account, onClose, onSaved }: { all: any[]; parent?: any; account?: any; onClose: () => void; onSaved: (msg: string) => void }) {
  const key = useSubmitKey();
  const groups = all.filter((a) => !a.postable && a.active).sort((x, y) => x.code.localeCompare(y.code, 'en', { numeric: true }));
  const [parentId, setParentId] = useState<string>(parent ? String(parent.id) : '');
  const p = all.find((a) => String(a.id) === parentId);
  const defaultControl = p?.code === '1100' ? 'cash' : p?.code === '1200' ? 'bank' : '';
  const [f, setF] = useState({
    code: '', name: account?.name ?? '', postable: true, control: defaultControl as '' | 'cash' | 'bank',
    bankName: account?.bank_name ?? '', branchName: account?.branch_name ?? '', accountTitle: account?.account_title ?? '', accountNo: account?.account_no ?? '',
    active: account?.active ?? true
  });
  const [suggest, setSuggest] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (account || !parentId) return;
    setF((x) => ({ ...x, control: (p?.code === '1100' ? 'cash' : p?.code === '1200' ? 'bank' : p?.type === 'asset' ? x.control : '') as typeof x.control }));
    api.get(`/api/accounts/next-code?parentId=${parentId}`).then((r) => setSuggest(r.code)).catch(() => setSuggest(''));
  }, [parentId]); // eslint-disable-line react-hooks/exhaustive-deps
  const isBank = account ? account.control === 'bank' : f.control === 'bank';

  return (
    <Dialog title={account ? `Edit ${account.code}` : parent ? `Add under ${parent.code} ${parent.name}` : 'Add account'} onClose={onClose}>
      {!account && (
        <div className="form-grid">
          <Field label="Under group">
            <select className="input" value={parentId} onChange={(e) => setParentId(e.target.value)}>
              <option value="">Choose…</option>
              {groups.map((g) => <option key={g.id} value={g.id}>{g.code} {g.name} ({TYPE_LABEL[g.type]})</option>)}
            </select>
          </Field>
          <div className="field" style={{ alignItems: 'flex-start' }}>
            <span>This is</span>
            <Seg value={f.postable ? 'account' : 'group'} options={[['account', 'An account (takes entries)'], ['group', 'A group (heading)']]} onChange={(v) => setF({ ...f, postable: v === 'account', control: v === 'group' ? '' : f.control })} />
          </div>
          <Field label="Code" hint={suggest ? `Leave empty for ${suggest}` : 'Digits, capital letters and dashes'}>
            <input className="input" value={f.code} placeholder={suggest} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase().replace(/[^0-9A-Z-]/g, '') })} />
          </Field>
          {f.postable && p?.type === 'asset' && (
            <div className="field" style={{ alignItems: 'flex-start' }}>
              <span>Money account</span>
              <Seg value={f.control || 'none'} options={[['none', 'No'], ['cash', 'Cash'], ['bank', 'Bank']]} onChange={(v) => setF({ ...f, control: v === 'none' ? '' : (v as 'cash' | 'bank') })} />
            </div>
          )}
        </div>
      )}
      <div className="form-grid">
        <Field label="Name"><input className="input" autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        {account && <Field label="Status"><select className="input" value={f.active ? 'y' : 'n'} onChange={(e) => setF({ ...f, active: e.target.value === 'y' })}><option value="y">Open</option><option value="n">Closed (no new entries)</option></select></Field>}
        {isBank && (
          <>
            <Field label="Bank"><input className="input" value={f.bankName} onChange={(e) => setF({ ...f, bankName: e.target.value })} placeholder="e.g. Meezan Bank" /></Field>
            <Field label="Branch"><input className="input" value={f.branchName} onChange={(e) => setF({ ...f, branchName: e.target.value })} /></Field>
            <Field label="Account title"><input className="input" value={f.accountTitle} onChange={(e) => setF({ ...f, accountTitle: e.target.value })} /></Field>
            <Field label="Account number / IBAN"><input className="input" value={f.accountNo} onChange={(e) => setF({ ...f, accountNo: e.target.value })} /></Field>
          </>
        )}
      </div>
      <FormError error={err} />
      <div className="dialog-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || f.name.trim().length < 2 || (!account && !parentId) || (isBank && !f.bankName.trim())} onClick={async () => {
          setBusy(true);
          setErr(null);
          try {
            const bank = isBank ? { bankName: f.bankName.trim(), branchName: f.branchName.trim() || null, accountTitle: f.accountTitle.trim() || null, accountNo: f.accountNo.trim() || null } : null;
            if (account) {
              await api.put(`/api/accounts/${account.id}`, { name: f.name.trim(), active: f.active, bank }, key.key());
              onSaved(`${account.code} saved`);
            } else {
              const r = await api.post('/api/accounts', { code: f.code || null, name: f.name.trim(), parentId: Number(parentId), postable: f.postable, control: f.control || null, bank }, key.key());
              onSaved(`${r.code} ${f.name.trim()} added`);
            }
            key.renew();
            onClose();
          } catch (e) { setErr(e); } finally { setBusy(false); }
        }}>Save</button>
      </div>
    </Dialog>
  );
}
