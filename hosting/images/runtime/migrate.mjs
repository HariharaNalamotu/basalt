// Applies /app/db/migrations/*.sql (once each, in order, each in a transaction) with the
// environment's admin role. Refuses SQL that weakens row-level security. Exit 2 = applied with
// warnings (unprotected per-user tables).
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

const FORBIDDEN = [
  [/DISABLE\s+ROW\s+LEVEL\s+SECURITY/i, 'disables row-level security'],
  [/NO\s+FORCE\s+ROW\s+LEVEL\s+SECURITY/i, 'stops forcing row-level security'],
  [/\bBYPASSRLS\b/i, 'grants BYPASSRLS'],
  [/DROP\s+POLICY[^;]*basalt_owner/i, 'drops the Basalt ownership policy'],
  [/\bbasalt_auth\.keys\b/i, 'touches the data-grant key table'],
  [/\bSUPERUSER\b/i, 'grants superuser'],
];
const dir = process.argv[2] ?? '/app/db/migrations';
const files = (await readdir(dir).catch(() => [])).filter((f) => /^\d+.*\.sql$/.test(f)).sort();
const client = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
await client.connect();
try {
  await client.query('CREATE TABLE IF NOT EXISTS basalt_schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  await client.query('SELECT pg_advisory_lock(727455101)');
  const done = new Set((await client.query('SELECT name FROM basalt_schema_migrations')).rows.map((r) => r.name));
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = await readFile(path.join(dir, f), 'utf8');
    for (const [re, why] of FORBIDDEN) if (re.test(sql)) throw new Error(`${f} ${why}; refusing to apply.`);
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO basalt_schema_migrations (name) VALUES ($1)', [f]);
      await client.query('COMMIT');
      console.log(`applied ${f}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`${f} failed: ${err.message}`);
    }
  }
  const unprotected = (await client.query('SELECT * FROM basalt_auth.unprotected_tables()').catch(() => ({ rows: [] }))).rows;
  if (unprotected.length) {
    console.log(`WARNING unprotected per-user tables: ${unprotected.map((t) => `${t.table_name}(${t.owner_like_column})`).join(', ')}`);
    process.exitCode = 2;
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
