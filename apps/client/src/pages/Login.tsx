import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { api, ApiError } from '../lib/api';
import { useSession } from '../lib/session';
import { Field, FormError } from '../components/ui';
import { DEMO } from '../lib/demo';

export function Login() {
  const { signIn } = useSession();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [needTotp, setNeedTotp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ token: string }>('/api/auth/login', { username, password, totp: totp || undefined });
      await signIn(r.token);
    } catch (err) {
      if (err instanceof ApiError && err.body?.needTotp) setNeedTotp(true);
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <div className="row" style={{ gap: 10 }}>
          <div className="brand-mark" style={{ color: 'var(--a800)', borderColor: 'var(--a500)' }}>A</div>
          <div>
            <div className="brand-name">AKB GROUP</div>
            <div className="small muted">Operations ERP · secure internal system</div>
          </div>
        </div>
        <Field label="Username">
          <input className="input" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus={!DEMO} required />
        </Field>
        <Field label="Password">
          <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </Field>
        {needTotp && (
          <Field label="6-digit code from your authenticator app">
            <input className="input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={totp} onChange={(e) => setTotp(e.target.value.replace(/\D/g, ''))} autoFocus />
          </Field>
        )}
        {error ? <FormError error={error} /> : null}
        <button className="btn btn-primary" disabled={busy} style={{ justifyContent: 'center' }}>{busy ? 'Signing in…' : 'Sign in'}</button>
        {DEMO && (
          <div className="stack demo-picker">
            <div className="note">
              <strong>Demo copy.</strong> Made-up data, nothing is saved. Choose a role to see what that person sees
              (password for all: <span className="mono">{DEMO.password}</span>).
            </div>
            <div className="demo-roles">
              {DEMO.users.map((u) => (
                <button type="button" key={u.username} className="btn" disabled={busy} onClick={async () => {
                  setBusy(true);
                  try {
                    const r = await api.post<{ token: string }>('/api/auth/login', { username: u.username, password: DEMO!.password });
                    await signIn(r.token);
                  } catch (err) { setError(err); } finally { setBusy(false); }
                }}>
                  <span>{u.roleLabel}</span><span className="small muted">{u.username}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </form>
    </div>
  );
}

/** First sign-in: change the temporary password, then set up the authenticator if required. */
export function AccountSetup() {
  const { me, refresh, signOut } = useSession();
  const need = me?.setupRequired;
  return (
    <div className="login">
      <div className="login-card">
        <h2>Finish setting up your account</h2>
        <p className="muted small" style={{ margin: 0 }}>Signed in as {me?.fullName}. This is needed once.</p>
        {need?.changePassword ? <ChangePassword onDone={refresh} /> : need?.enableTotp ? <EnableTotp onDone={refresh} /> : null}
        <button className="btn btn-ghost" onClick={signOut}>Sign out</button>
      </div>
    </div>
  );
}

function ChangePassword({ onDone }: { onDone: () => Promise<void> }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<unknown>(null);
  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        if (next !== again) return setError(new Error('The two new passwords do not match'));
        try {
          await api.post('/api/auth/password', { current, next });
          await onDone();
        } catch (err) {
          setError(err);
        }
      }}
    >
      <h4>1. Choose your own password</h4>
      <Field label="Temporary password"><input className="input" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} required /></Field>
      <Field label="New password" hint="At least 12 characters, with upper and lower case letters and a number"><input className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required /></Field>
      <Field label="New password again"><input className="input" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} required /></Field>
      <FormError error={error} />
      <button className="btn btn-primary">Save password</button>
    </form>
  );
}

function EnableTotp({ onDone }: { onDone: () => Promise<void> }) {
  const [secret, setSecret] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    api
      .post<{ secret: string; otpauthUri: string }>('/api/auth/totp/setup')
      .then(async (r) => {
        setSecret(r.secret);
        setQr(await QRCode.toDataURL(r.otpauthUri, { margin: 1, width: 200 }));
      })
      .catch(setError);
  }, []);
  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await api.post('/api/auth/totp/enable', { code });
          await onDone();
        } catch (err) {
          setError(err);
        }
      }}
    >
      <h4>2. Link your authenticator app</h4>
      <p className="small" style={{ margin: 0 }}>Scan with Google Authenticator or Microsoft Authenticator on your phone, then enter the 6-digit code it shows.</p>
      {qr && <img src={qr} alt="Authenticator QR code" width={200} height={200} style={{ alignSelf: 'center', background: '#fff' }} />}
      {secret && <div className="small muted" style={{ wordBreak: 'break-all' }}>Or type this key: <code>{secret}</code></div>}
      <Field label="Code"><input className="input" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} required /></Field>
      <FormError error={error} />
      <button className="btn btn-primary">Confirm</button>
    </form>
  );
}
