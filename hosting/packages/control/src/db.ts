import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export interface Db {
  query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number }>;
  tx<T>(fn: (q: Db['query']) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function createDb(url: string): Db {
  const pool = new pg.Pool({ connectionString: url, max: 10, statement_timeout: 15_000, application_name: 'basalt-control' });
  return {
    async query(sql, params = []) {
      const r = await pool.query(sql, params);
      return { rows: r.rows, rowCount: r.rowCount ?? 0 };
    },
    async tx(fn) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const out = await fn(async (sql, params = []) => {
          const r = await c.query(sql, params);
          return { rows: r.rows, rowCount: r.rowCount ?? 0 };
        });
        await c.query('COMMIT');
        return out;
      } catch (err) {
        await c.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        c.release();
      }
    },
    close: () => pool.end(),
  };
}

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export async function migrate(db: Db) {
  await db.tx(async (q) => {
    await q('SELECT pg_advisory_xact_lock(727455301)');
    await q('CREATE TABLE IF NOT EXISTS host_schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await q<{ name: string }>('SELECT name FROM host_schema_migrations')).rows.map((r) => r.name));
    for (const f of (await readdir(DIR)).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(f)) continue;
      await q(await readFile(path.join(DIR, f), 'utf8'));
      await q('INSERT INTO host_schema_migrations (name) VALUES ($1)', [f]);
    }
  });
}
