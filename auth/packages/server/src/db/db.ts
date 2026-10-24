import pg from 'pg';

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

/**
 * Minimal database interface. All SQL in this service goes through `query` with
 * positional parameters ($1, $2, ...). String interpolation into SQL is never used.
 */
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  /** Runs `fn` inside a transaction. The callback receives a Db bound to the transaction. */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface PgOptions {
  connectionString: string;
  maxConnections?: number;
  statementTimeoutMs?: number;
}

export function createPgDb(opts: PgOptions): Db {
  const pool = new pg.Pool({
    connectionString: opts.connectionString,
    max: opts.maxConnections ?? 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: opts.statementTimeoutMs ?? 5_000,
    application_name: 'basalt-auth',
  });

  const wrap = (client: pg.PoolClient | pg.Pool): Omit<Db, 'transaction' | 'close'> => ({
    async query<T>(sql: string, params: unknown[] = []) {
      const res = await client.query(sql, params);
      return { rows: res.rows as T[], rowCount: res.rowCount ?? 0 };
    },
  });

  const db: Db = {
    ...wrap(pool),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const tx: Db = {
          ...wrap(client),
          transaction: (inner) => inner(tx),
          close: async () => {},
        };
        const result = await fn(tx);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
  return db;
}
