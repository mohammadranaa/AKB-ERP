// Thin client for the AKB API. The session token is kept in memory and in sessionStorage
// (cleared when the window closes); the desktop app will keep it in the OS keychain instead.

import { DEMO, DEMO_READ_ONLY, demoGet } from './demo';
import { uuid } from './uuid';

const KEY = 'akb.session';
let token: string | null = null;
try {
  token = sessionStorage.getItem(KEY);
} catch {
  token = null;
}

const listeners = new Set<() => void>();
export const onAuthLost = (fn: () => void) => {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
};

export function setToken(t: string | null) {
  token = t;
  try {
    if (t) sessionStorage.setItem(KEY, t);
    else sessionStorage.removeItem(KEY);
  } catch {
    /* storage unavailable: keep in memory only */
  }
}
export const hasToken = () => !!token;

export class ApiError extends Error {
  constructor(public status: number, message: string, public details?: unknown, public body?: any) {
    super(message);
  }
}

const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? '';

/** Demo copy: answer from the recording; refuse every write. */
async function demoRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  await new Promise((r) => setTimeout(r, 120)); // feel like a network call
  const user = token?.startsWith('demo:') ? token.slice(5) : null;
  if (path === '/api/auth/login') {
    const b = (body ?? {}) as { username?: string; password?: string };
    const u = DEMO!.users.find((x) => x.username === b.username?.trim().toLowerCase());
    if (!u || b.password !== DEMO!.password) throw new ApiError(401, `Wrong username or password. In this demo every user's password is ${DEMO!.password}.`);
    return { ok: true, token: `demo:${u.username}`, setupRequired: null } as T;
  }
  if (path === '/api/auth/logout') return { ok: true } as T;
  if (!user) {
    listeners.forEach((l) => l());
    throw new ApiError(401, 'Please sign in');
  }
  if (method !== 'GET') throw new ApiError(403, DEMO_READ_ONLY);
  const r = demoGet(user, path);
  if (!r.found) throw new ApiError(404, 'This view is not included in the demo copy.');
  return structuredClone(r.body) as T;
}

async function request<T>(method: string, path: string, body?: unknown, opts: { key?: string } = {}): Promise<T> {
  if (DEMO) return demoRequest<T>(method, path, body);
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  // Every write carries an idempotency key. Forms pass the same key when retrying, so it posts once.
  if (method !== 'GET') headers['idempotency-key'] = opts.key ?? uuid();
  let res: Response;
  try {
    res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, 'Cannot reach the server. Check the connection (VPN) and try again.');
  }
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    if (res.status === 401 && path !== '/api/auth/login') {
      setToken(null);
      listeners.forEach((l) => l());
    }
    throw new ApiError(res.status, data?.message ?? `Request failed (${res.status})`, data?.details, data);
  }
  return data as T;
}

export const api = {
  get: <T = any>(p: string) => request<T>('GET', p),
  post: <T = any>(p: string, b?: unknown, key?: string) => request<T>('POST', p, b ?? {}, { key }),
  put: <T = any>(p: string, b?: unknown, key?: string) => request<T>('PUT', p, b ?? {}, { key }),
  async download(p: string, filename: string) {
    if (DEMO) throw new ApiError(403, 'Downloads are switched off in the demo copy.');
    const res = await fetch(BASE + p, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    if (!res.ok) {
      const d = await res.json().catch(() => null);
      throw new ApiError(res.status, d?.message ?? 'Download failed');
    }
    const blob = await res.blob();
    const sha = res.headers.get('x-content-sha256');
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return sha;
  }
};

export const qs = (o: Record<string, string | number | undefined | null>) => {
  const p = Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return p.length ? '?' + p.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&') : '';
};
