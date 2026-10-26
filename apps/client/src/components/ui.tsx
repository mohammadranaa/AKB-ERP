import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '../lib/api';

// ---------------- data loading ----------------
export function useApi<T>(load: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const reload = useCallback(async () => {
    const n = ++seq.current;
    setLoading(true);
    try {
      const d = await load();
      if (n === seq.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (n === seq.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (n === seq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, loading, reload, setData };
}

/** One idempotency key per form submission; renew it after a success. */
export function useSubmitKey() {
  const ref = useRef(crypto.randomUUID());
  return { key: () => ref.current, renew: () => (ref.current = crypto.randomUUID()) };
}

export function Loading({ what = 'Loading' }: { what?: string }) {
  return <div className="muted" style={{ padding: 20 }}>{what}…</div>;
}
export function ErrorBox({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <div className="note note-red row">
      <span>{error}</span>
      {onRetry && <button className="btn btn-sm" onClick={onRetry}>Try again</button>}
    </div>
  );
}

export function errorText(e: unknown): { message: string; details: string[] } {
  if (e instanceof ApiError) {
    const det = Array.isArray(e.details)
      ? e.details.map((x: any) => (typeof x === 'string' ? x : x.path ? `${x.path}: ${x.message}` : String(x.message ?? x)))
      : [];
    return { message: e.message, details: det };
  }
  return { message: e instanceof Error ? e.message : String(e), details: [] };
}

export function FormError({ error }: { error: unknown }) {
  if (!error) return null;
  const { message, details } = errorText(error);
  return (
    <div className="note note-red">
      <div>{message}</div>
      {details.length > 0 && <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>{details.map((d, i) => <li key={i}>{d}</li>)}</ul>}
    </div>
  );
}

// ---------------- layout ----------------
export function PageHead({ kicker, title, sub, children }: { kicker?: string; title: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        {kicker && <div className="kicker">{kicker}</div>}
        <h1>{title}</h1>
        {sub && <div className="muted small" style={{ marginTop: 4 }}>{sub}</div>}
      </div>
      <div className="spacer" />
      <div className="row no-print">{children}</div>
    </div>
  );
}

export function Panel({ title, actions, children, pad = true }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; pad?: boolean }) {
  return (
    <section className="panel">
      {title && (
        <div className="panel-head">
          {typeof title === 'string' ? <h3>{title}</h3> : title}
          <div className="spacer" />
          {actions}
        </div>
      )}
      <div className={pad ? 'panel-body' : ''}>{children}</div>
    </section>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <span className="small">{hint}</span>}
    </label>
  );
}

export function Seg<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="seg" role="group">
      {options.map(([v, l]) => (
        <button type="button" key={v} className={v === value ? 'on' : ''} onClick={() => onChange(v)} aria-pressed={v === value}>
          {l}
        </button>
      ))}
    </div>
  );
}

// ---------------- status ----------------
export function FulfilmentPill({ s }: { s: string }) {
  const muted = ['Draft', 'Cancelled', 'Rejected'].includes(s);
  return <span className={`pill pill-out${muted ? ' muted' : ''}`} title="Fulfilment">{s}</span>;
}
export function PaymentPill({ s }: { s: string }) {
  const cls = s === 'Partly paid' ? 'Partly' : s;
  return <span className={`pill pill-${cls}`} title="Payment">{s}</span>;
}

// ---------------- dialog & toast ----------------
export function Dialog({ title, children, onClose, wide }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="backdrop" onMouseDown={onClose}>
      <div className={`dialog${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} onMouseDown={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
}

/** A confirm step that states the consequence and optionally requires a comment. */
export function Confirm({
  title, body, confirmLabel, danger, needComment, onConfirm, onClose, list
}: {
  title: string; body: ReactNode; confirmLabel: string; danger?: boolean; needComment?: boolean | string; list?: string[];
  onConfirm: (comment: string) => Promise<void>; onClose: () => void;
}) {
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <Dialog title={title} onClose={onClose}>
      <div>{body}</div>
      {list && list.length > 0 && <ul style={{ margin: 0, paddingLeft: 18 }}>{list.map((l, i) => <li key={i}>{l}</li>)}</ul>}
      {needComment && (
        <Field label={typeof needComment === 'string' ? needComment : 'Comment (required)'}>
          <textarea className="input" value={comment} onChange={(e) => setComment(e.target.value)} autoFocus />
        </Field>
      )}
      <FormError error={error} />
      <div className="dialog-actions">
        <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button
          className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
          disabled={busy || (!!needComment && !comment.trim())}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await onConfirm(comment.trim());
              onClose();
            } catch (e) {
              setError(e);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Working…' : confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}

const ToastCtx = createContext<(m: string) => void>(() => undefined);
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<string | null>(null);
  const t = useRef<number | undefined>(undefined);
  const show = useCallback((m: string) => {
    setMsg(m);
    window.clearTimeout(t.current);
    t.current = window.setTimeout(() => setMsg(null), 4000);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {msg && <div className="toast" role="status">{msg}</div>}
    </ToastCtx.Provider>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="muted" style={{ padding: '18px 4px' }}>{children}</div>;
}
