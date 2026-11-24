// Money in the browser is handled as integer paisa (BigInt), never as floating point.

/** "1,234.5" -> 123450n. Empty -> 0n. */
export function toP(v: string | number | null | undefined): bigint {
  const s = String(v ?? '').trim().replace(/,/g, '');
  if (!s || s === '-' || s === '.') return 0n;
  const neg = s.startsWith('-');
  const [i, f = ''] = s.replace('-', '').split('.');
  const p = BigInt(i || '0') * 100n + BigInt((f + '00').slice(0, 2));
  return neg ? -p : p;
}

/** 123450n -> "1234.50" */
export function fromP(p: bigint): string {
  const neg = p < 0n;
  const a = neg ? -p : p;
  return `${neg ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`;
}

/** Keep only what an amount box should accept: digits and one decimal point, at most two decimals. */
export function amountInput(v: string): string {
  const s = v.replace(/[^\d.]/g, '');
  const [i, ...rest] = s.split('.');
  return rest.length ? `${i}.${rest.join('').slice(0, 2)}` : i!;
}
