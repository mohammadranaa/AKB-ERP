import { useState } from 'react';
import { api, qs } from '../lib/api';
import { dt, rs } from '../lib/format';
import { useSession } from '../lib/session';
import { Confirm, Dialog, Empty, ErrorBox, Field, FormError, Loading, PageHead, Panel, Seg, useApi, useSubmitKey, useToast } from '../components/ui';
import { uuid } from '../lib/uuid';
import { useInfo } from '../lib/info';

// ---------------- Users ----------------
export function Users() {
  const users = useApi(() => api.get('/api/admin/users'), []);
  const roles = useApi(() => api.get('/api/admin/roles'), []);
  const branches = useApi(() => api.get('/api/branches'), []);
  const [edit, setEdit] = useState<any>(null);
  const [reset, setReset] = useState<any>(null);
  const [temp, setTemp] = useState<{ who: string; pw: string } | null>(null);
  const toast = useToast();
  const branchCode = (id: number) => (branches.data ?? []).find((b: any) => b.id === id)?.code ?? id;
  return (
    <>
      <PageHead kicker="Administration" title="Users" sub="Each person has one role. New users and password resets get a one-time password; they must set their own and enable an authenticator at first sign-in.">
        <button className="btn btn-primary" onClick={() => setEdit({})}>Add user</button>
      </PageHead>
      <Panel pad={false}>
        {users.loading && !users.data ? <Loading /> : users.error ? <ErrorBox error={users.error} onRetry={users.reload} /> : (
          <div className="table-wrap">
            <table className="t">
              <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Branches</th><th>Security</th><th>Last seen</th><th /></tr></thead>
              <tbody>
                {users.data.map((u: any) => (
                  <tr key={u.id} className={u.active ? '' : 'muted'}>
                    <td>{u.full_name}{!u.active && <div className="small">Deactivated</div>}</td>
                    <td className="small">{u.username}</td>
                    <td>{u.role_name}</td>
                    <td className="small">{u.branch_ids ? u.branch_ids.map(branchCode).join(', ') : 'All'}</td>
                    <td className="small">
                      {u.totp_enabled ? <span className="chip chip-green">Authenticator on</span> : <span className="chip chip-amber">No authenticator</span>}
                      {u.must_change_pw && <div className="muted">must set password</div>}
                      {u.locked_until && new Date(u.locked_until) > new Date() && <div style={{ color: 'var(--red-tx)' }}>locked until {dt(u.locked_until)}</div>}
                    </td>
                    <td className="small">{u.last_seen ? dt(u.last_seen) : 'never'}</td>
                    <td><div className="row">
                      <button className="btn btn-sm" onClick={() => setEdit(u)}>Edit</button>
                      <button className="btn btn-sm" onClick={() => setReset(u)}>Reset access</button>
                    </div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <TrialReset />
      {edit && (
        <UserForm user={edit} roles={roles.data?.roles ?? []} branches={(branches.data ?? []).filter((b: any) => b.active)} onClose={() => setEdit(null)}
          onSaved={(pw) => { if (pw) setTemp({ who: pw.who, pw: pw.pw }); void users.reload(); }} />
      )}
      {reset && (
        <ResetForm user={reset} onClose={() => setReset(null)} onDone={(pw) => { if (pw) setTemp({ who: reset.full_name, pw }); else toast('Access reset'); void users.reload(); }} />
      )}
      {temp && (
        <Dialog title="One-time password" onClose={() => setTemp(null)}>
          <div>Give this to <strong>{temp.who}</strong> in person or by phone. It is shown only once and must be changed at first sign-in.</div>
          <div className="mono" style={{ fontSize: 18, padding: 12, border: '1px solid var(--divider)', userSelect: 'all' }}>{temp.pw}</div>
          <div className="dialog-actions">
            <button className="btn" onClick={() => { void navigator.clipboard?.writeText(temp.pw); toast('Copied'); }}>Copy</button>
            <button className="btn btn-primary" onClick={() => setTemp(null)}>Done</button>
          </div>
        </Dialog>
      )}
    </>
  );
}

function UserForm({ user, roles, branches, onClose, onSaved }: { user: any; roles: any[]; branches: any[]; onClose: () => void; onSaved: (pw: { who: string; pw: string } | null) => void }) {
  const { me } = useSession();
  const key = useSubmitKey();
  const isNew = !user.id;
  const [username, setUsername] = useState(user.username ?? '');
  const [fullName, setFullName] = useState(user.full_name ?? '');
  const [role, setRole] = useState(user.role_code ?? '');
  const [allBranches, setAll] = useState(!user.branch_ids);
  const [branchIds, setBranchIds] = useState<number[]>(user.branch_ids ?? []);
  const [active, setActive] = useState(user.active ?? true);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const self = user.id === me!.id;
  return (
    <Dialog title={isNew ? 'Add user' : `Edit ${user.full_name}`} onClose={onClose}>
      <div className="form-grid">
        <Field label="Full name"><input className="input" value={fullName} onChange={(e) => setFullName(e.target.value)} /></Field>
        <Field label="Username"><input className="input" value={username} onChange={(e) => setUsername(e.target.value.toLowerCase())} /></Field>
        <Field label="Role">
          <select className="input" value={role} disabled={self} onChange={(e) => setRole(e.target.value)}>
            <option value="">Choose…</option>
            {roles.map((r: any) => <option key={r.code} value={r.code}>{r.name}</option>)}
          </select>
        </Field>
        <Field label="Status">
          <select className="input" value={active ? 'y' : 'n'} disabled={self} onChange={(e) => setActive(e.target.value === 'y')}>
            <option value="y">Active</option><option value="n">Deactivated (signs out everywhere)</option>
          </select>
        </Field>
      </div>
      <Field label="Branches this person can work in">
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <label className="row small"><input type="checkbox" checked={allBranches} onChange={(e) => setAll(e.target.checked)} /> All branches</label>
          {!allBranches && branches.map((b: any) => (
            <label key={b.id} className="row small">
              <input type="checkbox" checked={branchIds.includes(b.id)} onChange={(e) => setBranchIds(e.target.checked ? [...branchIds, b.id] : branchIds.filter((x) => x !== b.id))} /> {b.code}
            </label>
          ))}
        </div>
      </Field>
      {self && <div className="small muted">You cannot change your own role or deactivate yourself.</div>}
      <FormError error={err} />
      <div className="dialog-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !fullName || !username || !role || (!allBranches && !branchIds.length)} onClick={async () => {
          setBusy(true);
          setErr(null);
          try {
            const body = { username, fullName, role, branchIds: allBranches ? null : branchIds, active };
            const r = isNew ? await api.post('/api/admin/users', body, key.key()) : await api.put(`/api/admin/users/${user.id}`, body);
            key.renew();
            onSaved(isNew ? { who: fullName, pw: r.temporaryPassword } : null);
            onClose();
          } catch (e) { setErr(e); } finally { setBusy(false); }
        }}>{isNew ? 'Create user' : 'Save'}</button>
      </div>
    </Dialog>
  );
}

function ResetForm({ user, onClose, onDone }: { user: any; onClose: () => void; onDone: (pw: string | null) => void }) {
  const [password, setPassword] = useState(true);
  const [totp, setTotp] = useState(false);
  return (
    <Confirm
      title={`Reset access for ${user.full_name}?`}
      body={
        <div className="stack">
          <div>They are signed out on every device. Use this when someone forgets their password or loses their phone.</div>
          <label className="row"><input type="checkbox" checked={password} onChange={(e) => setPassword(e.target.checked)} /> Issue a new one-time password</label>
          <label className="row"><input type="checkbox" checked={totp} onChange={(e) => setTotp(e.target.checked)} /> Remove their authenticator (they set it up again)</label>
        </div>
      }
      confirmLabel="Reset"
      danger
      onClose={onClose}
      onConfirm={async () => {
        const r = await api.post(`/api/admin/users/${user.id}/reset`, { password, totp }, uuid());
        onDone(r.temporaryPassword);
      }}
    />
  );
}

// ---------------- Masters ----------------
type Tab = 'products' | 'customer' | 'supplier' | 'transporter' | 'other';

export function Masters() {
  const [tab, setTab] = useState<Tab>('products');
  return (
    <>
      <PageHead kicker="Administration" title="Products & parties" sub="Every change is recorded in the audit log with the before and after values." />
      <div style={{ marginBottom: 12 }}>
        <Seg value={tab} options={[['products', 'Products'], ['customer', 'Customers'], ['supplier', 'Suppliers'], ['transporter', 'Transporters'], ['other', 'Others']]} onChange={setTab} />
      </div>
      {tab === 'products' ? <Products /> : <Parties kind={tab} />}
    </>
  );
}

function Products() {
  const list = useApi(() => api.get('/api/products'), []);
  const [edit, setEdit] = useState<any>(null);
  return (
    <Panel title="Products" actions={<button className="btn btn-sm btn-primary" onClick={() => setEdit({})}>Add product</button>} pad={false}>
      {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} /> : (
        <table className="t">
          <thead><tr><th>Code</th><th>Product</th><th>Manufacturer</th><th>Nutrient</th><th className="num">Bag</th><th className="num">Floor price</th><th /></tr></thead>
          <tbody>
            {list.data.map((p: any) => (
              <tr key={p.id} className={p.active ? '' : 'muted'}>
                <td>{p.code}</td><td>{p.name_en}{p.name_ur && <div className="urdu">{p.name_ur}</div>}</td><td>{p.manufacturer}</td><td>{p.nutrient ?? '—'}</td>
                <td className="num">{Number(p.bag_kg)} kg</td><td className="num">{p.floor_price ? rs(p.floor_price) : '—'}</td>
                <td><button className="btn btn-sm" onClick={() => setEdit(p)}>Edit</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {edit && <ProductForm p={edit} onClose={() => setEdit(null)} onSaved={list.reload} />}
    </Panel>
  );
}

function ProductForm({ p, onClose, onSaved }: { p: any; onClose: () => void; onSaved: () => void }) {
  const key = useSubmitKey();
  const [f, setF] = useState({
    code: p.code ?? '', nameEn: p.name_en ?? '', nameUr: p.name_ur ?? '', manufacturer: p.manufacturer ?? '', nutrient: p.nutrient ?? '',
    bagKg: String(p.bag_kg ?? 50), floorPrice: p.floor_price ?? '', active: p.active ?? true
  });
  const [err, setErr] = useState<unknown>(null);
  const s = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Dialog title={p.id ? `Edit ${p.name_en}` : 'Add product'} onClose={onClose}>
      <div className="form-grid">
        <Field label="Code"><input className="input" value={f.code} onChange={s('code')} /></Field>
        <Field label="Manufacturer"><input className="input" value={f.manufacturer} onChange={s('manufacturer')} /></Field>
        <Field label="Name (English)"><input className="input" value={f.nameEn} onChange={s('nameEn')} /></Field>
        <Field label="Name (Urdu)"><input className="input urdu" dir="rtl" value={f.nameUr} onChange={s('nameUr')} /></Field>
        <Field label="Nutrient"><input className="input" value={f.nutrient} onChange={s('nutrient')} placeholder="e.g. N 46%" /></Field>
        <Field label="Bag weight (kg)"><input className="input num" value={f.bagKg} onChange={(e) => setF({ ...f, bagKg: e.target.value.replace(/[^\d.]/g, '') })} /></Field>
        <Field label="Floor price per bag (Rs)" hint="Selling below this needs approval"><input className="input num" value={f.floorPrice} onChange={(e) => setF({ ...f, floorPrice: e.target.value.replace(/[^\d.]/g, '') })} /></Field>
        <Field label="Status"><select className="input" value={f.active ? 'y' : 'n'} onChange={(e) => setF({ ...f, active: e.target.value === 'y' })}><option value="y">Active</option><option value="n">Inactive</option></select></Field>
      </div>
      <FormError error={err} />
      <div className="dialog-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!f.code || !f.nameEn || !f.manufacturer} onClick={async () => {
          try {
            const body = { ...f, nameUr: f.nameUr || null, nutrient: f.nutrient || null, bagKg: Number(f.bagKg), floorPrice: f.floorPrice || null };
            if (p.id) await api.put(`/api/products/${p.id}`, body); else await api.post('/api/products', body, key.key());
            key.renew();
            onSaved();
            onClose();
          } catch (e) { setErr(e); }
        }}>Save</button>
      </div>
    </Dialog>
  );
}

function Parties({ kind }: { kind: Exclude<Tab, 'products'> }) {
  const [q, setQ] = useState('');
  const list = useApi(() => api.get(`/api/parties${qs({ kind: kind === 'other' ? undefined : kind, q })}`), [kind, q]);
  const [edit, setEdit] = useState<any>(null);
  const rows = (list.data ?? []).filter((p: any) => kind !== 'other' || !['customer', 'supplier', 'transporter'].includes(p.kind));
  return (
    <Panel title={<input className="input" style={{ maxWidth: 300 }} placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />}
      actions={<button className="btn btn-sm btn-primary" onClick={() => setEdit({ kind: kind === 'other' ? 'tenant' : kind })}>Add</button>} pad={false}>
      {list.loading && !list.data ? <Loading /> : list.error ? <ErrorBox error={list.error} /> : !rows.length ? <Empty>None yet.</Empty> : (
        <div className="table-wrap">
          <table className="t">
            <thead><tr><th>Code</th><th>Name</th><th>Kind</th><th>City</th><th>Phone</th>{kind === 'customer' && <><th>Rep</th><th className="num">Credit limit</th><th>Days</th></>}<th /></tr></thead>
            <tbody>
              {rows.map((p: any) => (
                <tr key={p.id} className={p.active ? '' : 'muted'}>
                  <td>{p.code}</td><td>{p.name_en}{p.name_ur && <div className="urdu">{p.name_ur}</div>}</td><td className="small">{p.kind}</td><td>{p.city ?? '—'}</td><td className="small">{p.phone ?? '—'}</td>
                  {kind === 'customer' && <><td className="small">{p.rep_name ?? '—'}</td><td className="num">{Number(p.credit_limit) > 0 ? rs(p.credit_limit) : 'Cash first'}</td><td>{p.credit_days}</td></>}
                  <td><button className="btn btn-sm" onClick={() => setEdit(p)}>Edit</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {edit && <PartyForm p={edit} onClose={() => setEdit(null)} onSaved={list.reload} />}
    </Panel>
  );
}

function PartyForm({ p, onClose, onSaved }: { p: any; onClose: () => void; onSaved: () => void }) {
  const key = useSubmitKey();
  const reps = useApi(() => api.get('/api/users/reps'), []);
  const [f, setF] = useState({
    code: p.code ?? '', kind: p.kind ?? 'customer', nameEn: p.name_en ?? '', nameUr: p.name_ur ?? '', city: p.city ?? '', phone: p.phone ?? '',
    taxNo: p.tax_no ?? '', creditLimit: p.credit_limit ?? '0', creditDays: String(p.credit_days ?? 30), repUserId: p.rep_user_id ?? '', active: p.active ?? true
  });
  const [err, setErr] = useState<unknown>(null);
  const s = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const isCustomer = f.kind === 'customer';
  return (
    <Dialog title={p.id ? `Edit ${p.name_en}` : 'Add party'} onClose={onClose}>
      <div className="form-grid">
        <Field label="Code"><input className="input" value={f.code} onChange={s('code')} /></Field>
        <Field label="Kind">
          <select className="input" value={f.kind} onChange={s('kind')}>
            {['customer', 'supplier', 'transporter', 'tenant', 'employee', 'other'].map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </Field>
        <Field label="Name (English)"><input className="input" value={f.nameEn} onChange={s('nameEn')} /></Field>
        <Field label="Name (Urdu)"><input className="input urdu" dir="rtl" value={f.nameUr} onChange={s('nameUr')} /></Field>
        <Field label="City"><input className="input" value={f.city} onChange={s('city')} /></Field>
        <Field label="Phone"><input className="input" value={f.phone} onChange={s('phone')} /></Field>
        <Field label="NTN / CNIC"><input className="input" value={f.taxNo} onChange={s('taxNo')} /></Field>
        {isCustomer && (
          <>
            <Field label="Sales rep">
              <select className="input" value={f.repUserId} onChange={(e) => setF({ ...f, repUserId: e.target.value ? Number(e.target.value) : '' })}>
                <option value="">—</option>
                {(reps.data ?? []).map((r: any) => <option key={r.id} value={r.id}>{r.full_name}</option>)}
              </select>
            </Field>
            <Field label="Credit limit (Rs)" hint="0 means cash before delivery"><input className="input num" value={f.creditLimit} onChange={(e) => setF({ ...f, creditLimit: e.target.value.replace(/[^\d.]/g, '') })} /></Field>
            <Field label="Credit days"><input className="input num" value={f.creditDays} onChange={(e) => setF({ ...f, creditDays: e.target.value.replace(/\D/g, '') })} /></Field>
          </>
        )}
        <Field label="Status"><select className="input" value={f.active ? 'y' : 'n'} onChange={(e) => setF({ ...f, active: e.target.value === 'y' })}><option value="y">Active</option><option value="n">Inactive</option></select></Field>
      </div>
      <FormError error={err} />
      <div className="dialog-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!f.code || !f.nameEn} onClick={async () => {
          try {
            const body = {
              code: f.code, kind: f.kind, nameEn: f.nameEn, nameUr: f.nameUr || null, city: f.city || null, phone: f.phone || null, taxNo: f.taxNo || null,
              creditLimit: isCustomer ? (f.creditLimit || '0') : '0', creditDays: Number(f.creditDays) || 0, repUserId: isCustomer && f.repUserId ? Number(f.repUserId) : null, active: f.active
            };
            if (p.id) await api.put(`/api/parties/${p.id}`, body); else await api.post('/api/parties', body, key.key());
            key.renew();
            onSaved();
            onClose();
          } catch (e) { setErr(e); }
        }}>Save</button>
      </div>
    </Dialog>
  );
}

// ---------------- Audit log ----------------
export function AuditLog() {
  const [entity, setEntity] = useState('');
  const [entityId, setEntityId] = useState('');
  const log = useApi(() => api.get(`/api/admin/audit${qs({ entity, entityId, limit: 300 })}`), [entity, entityId]);
  const [check, setCheck] = useState<any>(null);
  const [open, setOpen] = useState<number | null>(null);
  return (
    <>
      <PageHead kicker="Administration" title="Audit log" sub="Every action, who did it and when. Each record is chained to the one before it, so a changed or deleted record is detected.">
        <button className="btn" onClick={async () => setCheck(await api.get('/api/admin/audit/verify'))}>Check the chain</button>
      </PageHead>
      {check && (
        <div className={`note ${check.intact ? 'note-green' : 'note-red'}`} style={{ marginBottom: 12 }}>
          {check.intact ? `Intact: all ${check.entries} records verified.` : `Broken at record ${check.firstBrokenId}. Records have been altered outside the system. Report this to the owner.`}
        </div>
      )}
      <div className="row" style={{ marginBottom: 12 }}>
        <Field label="What">
          <select className="input" value={entity} onChange={(e) => setEntity(e.target.value)}>
            <option value="">Everything</option>
            {['og', 'receipt', 'journal', 'business_day', 'user', 'party', 'product', 'transfer', 'adjustment', 'session'].map((x) => <option key={x} value={x}>{x.replace('_', ' ')}</option>)}
          </select>
        </Field>
        <Field label="Reference"><input className="input" value={entityId} onChange={(e) => setEntityId(e.target.value)} placeholder="ID or number" /></Field>
      </div>
      <Panel pad={false}>
        {log.loading && !log.data ? <Loading /> : log.error ? <ErrorBox error={log.error} /> : !log.data.length ? <Empty>Nothing recorded.</Empty> : (
          <div className="table-wrap">
            <table className="t">
              <thead><tr><th>When</th><th>Who</th><th>Action</th><th>On</th><th>Details</th></tr></thead>
              <tbody>
                {log.data.map((r: any) => (
                  <tr key={r.id}>
                    <td className="small">{dt(r.at)}</td>
                    <td>{r.user_name ?? 'system'}</td>
                    <td>{r.action.replace(/_/g, ' ')}</td>
                    <td className="small">{r.entity} {r.entity_id}</td>
                    <td className="small">
                      {r.detail && (open === r.id
                        ? <pre className="mono" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{JSON.stringify(r.detail, null, 2)}</pre>
                        : <button className="btn btn-sm btn-ghost" onClick={() => setOpen(r.id)}>Show</button>)}
                    </td>
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


/** Practice system only: wipe everything back to the starting demo data. */
function TrialReset() {
  const info = useInfo();
  const { signOut } = useSession();
  const [ask, setAsk] = useState(false);
  if (!info?.trial) return null;
  return (
    <div style={{ marginTop: 16 }}>
      <Panel title="Trial data">
        <div className="stack">
          <div>This is a practice system. Resetting deletes every OG, receipt, entry and user added during the trial and starts again from the demo data. Everyone is signed out.</div>
          <div><button className="btn btn-danger" onClick={() => setAsk(true)}>Reset trial data</button></div>
        </div>
      </Panel>
      {ask && (
        <Confirm
          title="Reset all trial data?"
          body="Everything entered during the trial is deleted and the demo data is loaded again. This cannot be undone."
          confirmLabel="Reset"
          danger
          needComment="Type RESET to confirm"
          onClose={() => setAsk(false)}
          onConfirm={async (typed) => {
            await api.post('/api/trial/reset', { confirm: typed.trim() }, uuid());
            await signOut();
          }}
        />
      )}
    </div>
  );
}
