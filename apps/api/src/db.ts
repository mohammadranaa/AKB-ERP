import pg from 'pg';

// Keep dates as 'YYYY-MM-DD' strings (no time-zone shifts) and NUMERIC as strings (no float rounding).
pg.types.setTypeParser(1082, (v) => v); // date
pg.types.setTypeParser(1700, (v) => v); // numeric
pg.types.setTypeParser(20, (v) => v); // int8 stays string; convert explicitly where a count is needed

export type Db = pg.PoolClient;

export interface DbContext {
  userId: number;
  role: string;
}

export class Database {
  readonly pool: pg.Pool;

  constructor(
    connectionString: string,
    private timeZone = 'Asia/Karachi'
  ) {
    this.pool = new pg.Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000 });
  }

  /**
   * Run fn inside one transaction with the user's identity set for row-level security.
   * Every request goes through here, reads included, so RLS always applies.
   */
  async tx<T>(ctx: DbContext | null, fn: (c: Db) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('begin');
      // current_date in SQL (used for overdue checks) follows the business time zone.
      await c.query("select set_config('TimeZone', $1, true)", [this.timeZone]);
      if (ctx) {
        await c.query("select set_config('app.user_id', $1, true), set_config('app.role', $2, true)", [
          String(ctx.userId),
          ctx.role
        ]);
      } else {
        // Unauthenticated work (login) runs as a system context that can read users only.
        await c.query("select set_config('app.role', 'system', true)");
      }
      const result = await fn(c);
      await c.query('commit');
      return result;
    } catch (err) {
      await c.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export async function one<T = Record<string, unknown>>(c: Db, sql: string, params: unknown[] = []): Promise<T> {
  const r = await c.query(sql, params);
  if (r.rowCount !== 1) throw new Error(`Expected one row, got ${r.rowCount}`);
  return r.rows[0] as T;
}

export async function maybeOne<T = Record<string, unknown>>(
  c: Db,
  sql: string,
  params: unknown[] = []
): Promise<T | null> {
  const r = await c.query(sql, params);
  return (r.rows[0] as T) ?? null;
}

export async function many<T = Record<string, unknown>>(c: Db, sql: string, params: unknown[] = []): Promise<T[]> {
  const r = await c.query(sql, params);
  return r.rows as T[];
}
