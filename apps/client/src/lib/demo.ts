// Demo copy: when the page carries recorded data (window.__AKB_DEMO__), every API call is answered
// from that recording instead of a server. It is read-only: nothing can be saved.
// The real system never includes this data; it is added only by tools/build-demo.mjs.

export interface DemoUser { username: string; fullName: string; role: string; roleLabel: string }
export interface DemoData {
  builtAt: string;
  users: DemoUser[];
  password: string;
  /** 'memory' for a hosted page that cannot use the address bar; hash routing otherwise */
  router?: 'hash' | 'memory';
  /** per username: request path (with query) → response body */
  gets: Record<string, Record<string, unknown>>;
}

export const DEMO: DemoData | null = (typeof window !== 'undefined' && (window as unknown as { __AKB_DEMO__?: DemoData }).__AKB_DEMO__) || null;

export const DEMO_READ_ONLY = 'This is a demo copy, so nothing is saved. In the real system this would be recorded.';

function splitPath(path: string): { base: string; params: URLSearchParams } {
  const i = path.indexOf('?');
  return i < 0 ? { base: path, params: new URLSearchParams() } : { base: path.slice(0, i), params: new URLSearchParams(path.slice(i + 1)) };
}

const keyOf = (base: string, params: URLSearchParams) => {
  const p = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
  return p.length ? `${base}?${p.map(([k, v]) => `${k}=${v}`).join('&')}` : base;
};

/** Find the recorded answer for a request, relaxing filters the recording did not cover. */
export function demoGet(username: string, path: string): { found: boolean; body: unknown } {
  const store = DEMO?.gets[username] ?? {};
  const { base, params } = splitPath(path);
  const exact = keyOf(base, params);
  if (exact in store) return { found: true, body: store[exact] };
  // Search text: answer from the unfiltered list and filter here.
  const q = params.get('q');
  if (q !== null) params.delete('q');
  const tries = [keyOf(base, params)];
  // Date filters and the like: fall back to the unfiltered list.
  for (const k of ['from', 'to', 'status', 'source', 'asOf', 'limit', 'entity', 'entityId']) {
    if (params.has(k)) { params.delete(k); tries.push(keyOf(base, params)); }
  }
  tries.push(base);
  for (const t of tries) {
    if (t in store) {
      let body = store[t];
      if (q && Array.isArray(body)) {
        const needle = q.toLowerCase();
        body = body.filter((row) => Object.values(row as Record<string, unknown>).some((v) => typeof v === 'string' && v.toLowerCase().includes(needle)));
      }
      return { found: true, body };
    }
  }
  return { found: false, body: null };
}
