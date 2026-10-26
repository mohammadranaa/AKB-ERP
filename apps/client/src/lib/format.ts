// Pakistani number formatting: lakh/crore grouping, Rs prefix, tons alongside bags.

export function groupPk(intStr: string): string {
  const neg = intStr.startsWith('-');
  const s = neg ? intStr.slice(1) : intStr;
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return (neg ? '−' : '') + (rest ? rest + ',' : '') + last3;
}

/** "1234567.5" -> "Rs 12,34,567.50". Decimals are dropped when they are .00 unless keepZero. */
export function rs(v: string | number | null | undefined, opts: { keepZero?: boolean; bare?: boolean } = {}): string {
  if (v === null || v === undefined || v === '') return '—';
  const s = typeof v === 'number' ? v.toFixed(2) : v;
  const [w, f = '00'] = s.split('.');
  const frac = (f + '00').slice(0, 2);
  const body = groupPk(w!) + (frac === '00' && !opts.keepZero ? '' : '.' + frac);
  return opts.bare ? body : 'Rs ' + body;
}

/** Compact: Rs 1.25 Cr / Rs 45.3 Lac. */
export function rsShort(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  const a = Math.abs(n);
  const sign = n < 0 ? '−' : '';
  if (a >= 1e7) return `${sign}Rs ${(a / 1e7).toFixed(2)} Cr`;
  if (a >= 1e5) return `${sign}Rs ${(a / 1e5).toFixed(1)} Lac`;
  return rs(v);
}

export const bags = (n: number | string | null | undefined) => (n === null || n === undefined ? '—' : groupPk(String(Math.round(Number(n)))));
export const tons = (bagCount: number | string, kg = 50) => `${(Math.round((Number(bagCount) * kg) / 100) / 10).toLocaleString('en-IN')} t`;

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "2026-10-12" -> "12-Oct-2026" */
export function d(v: string | null | undefined): string {
  if (!v) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (!m) return v;
  return `${m[3]}-${MON[Number(m[2]) - 1]}-${m[1]}`;
}
/** Timestamp in Pakistan time: "12-Oct-2026 15:48" */
export function dt(v: string | null | undefined): string {
  if (!v) return '—';
  const x = new Date(v);
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(x);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${g('day')}-${MON[Number(g('month')) - 1]}-${g('year')} ${g('hour')}:${g('minute')}`;
}

export const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');
