import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Db } from './db.js';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
// Arbitrary constant so concurrent replicas booting at once don't race on migrations.
const MIGRATION_LOCK_ID = 727_455_001;

export async function migrate(db: Db, opts: { useAdvisoryLock?: boolean } = {}): Promise<string[]> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];

  await db.transaction(async (tx) => {
    if (opts.useAdvisoryLock !== false) {
      await tx.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_ID]);
    }
    await tx.query(
      `CREATE TABLE IF NOT EXISTS auth_schema_migrations (
         name text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const done = new Set(
      (await tx.query<{ name: string }>('SELECT name FROM auth_schema_migrations')).rows.map((r) => r.name),
    );
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      await tx.query(sql);
      await tx.query('INSERT INTO auth_schema_migrations (name) VALUES ($1)', [file]);
      applied.push(file);
    }
  });
  return applied;
}
