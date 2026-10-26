// Money is handled as integer paisa (BigInt) in TypeScript and NUMERIC(18,2) in Postgres.
// Never as floating point.

import { z } from 'zod';

const MONEY_RE = /^-?\d{1,16}(\.\d{1,2})?$/;

export function toPaisa(value: string | number | bigint): bigint {
  if (typeof value === 'bigint') return value * 100n;
  const s = typeof value === 'number' ? numberToString(value) : value.trim().replace(/,/g, '');
  if (!MONEY_RE.test(s)) throw new Error(`Not a valid amount: ${value}`);
  const neg = s.startsWith('-');
  const [whole, frac = ''] = (neg ? s.slice(1) : s).split('.');
  const p = BigInt(whole!) * 100n + BigInt((frac + '00').slice(0, 2));
  return neg ? -p : p;
}

export function fromPaisa(p: bigint): string {
  const neg = p < 0n;
  const a = neg ? -p : p;
  const s = `${a / 100n}.${(a % 100n).toString().padStart(2, '0')}`;
  return neg ? `-${s}` : s;
}

function numberToString(n: number): string {
  if (!Number.isFinite(n)) throw new Error('Not a valid amount');
  // Round to 2 decimals via string to avoid binary artefacts like 0.1 + 0.2.
  return n.toFixed(2);
}

/** Zod schema: a positive amount with at most two decimals, given as number or string. Output: "1234.50". */
export const Amount = z
  .union([z.string(), z.number()])
  .transform((v, ctx) => {
    try {
      const p = toPaisa(v);
      if (p <= 0n) {
        ctx.addIssue({ code: 'custom', message: 'Amount must be greater than zero' });
        return z.NEVER;
      }
      return fromPaisa(p);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Amount must be a number with at most two decimals' });
      return z.NEVER;
    }
  });

/** Like Amount but allows zero. */
export const AmountOrZero = z
  .union([z.string(), z.number()])
  .transform((v, ctx) => {
    try {
      const p = toPaisa(v);
      if (p < 0n) {
        ctx.addIssue({ code: 'custom', message: 'Amount cannot be negative' });
        return z.NEVER;
      }
      return fromPaisa(p);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Amount must be a number with at most two decimals' });
      return z.NEVER;
    }
  });

/** Pakistani grouping, e.g. 12500000 -> "1,25,00,000.00". */
export function formatPkr(value: string | bigint): string {
  const p = typeof value === 'bigint' ? value : toPaisa(value);
  const neg = p < 0n;
  const s = fromPaisa(neg ? -p : p);
  const [whole, frac] = s.split('.');
  const w = whole!;
  const last3 = w.slice(-3);
  const rest = w.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${rest ? rest + ',' : ''}${last3}.${frac}`;
}
