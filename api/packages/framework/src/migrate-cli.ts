#!/usr/bin/env node
/**
 * basalt-migrate: applies db/migrations/*.sql in order using DATABASE_ADMIN_URL (the migration
 * role), once each, each in its own transaction. Refuses SQL that weakens row-level security and
 * reports per-user tables that are not protected afterwards.
 *
 *   node --env-file=.basalt/<app>.env node_modules/@basalt/api/dist/migrate-cli.js [dir]
 */
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
] as const;

export async function migrate(dir: string, url: string, log: (s: string) => void = console.log) {
  const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => /^\d+.*\.sql$/.test(f)).sort();
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS basalt_schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    await client.query('SELECT pg_advisory_lock(727455101)');
    const done = new Set((await client.query<{ name: string }>('SELECT name FROM basalt_schema_migrations')).rows.map((r) => r.name));
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(dir, file), 'utf8');
      for (const [re, why] of FORBIDDEN) {
        if (re.test(sql)) throw new Error(`${file} ${why}; refusing to apply. Data ownership must stay database-enforced.`);
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO basalt_schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`${file} failed: ${(err as Error).message}`);
      }
      applied.push(file);
      log(`applied ${file}`);
    }
    const unprotected = await client
      .query<{ table_name: string; owner_like_column: string }>('SELECT * FROM basalt_auth.unprotected_tables()')
      .then((r) => r.rows, () => null);
    return { applied, unprotected };
  } finally {
    await client.query('SELECT pg_advisory_unlock(727455101)').catch(() => {});
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('migrate-cli.js')) {
  const url = process.env.DATABASE_ADMIN_URL;
  if (!url) {
    console.error('DATABASE_ADMIN_URL is not set. Run with --env-file=.basalt/<app>.env (written by the api_setup tool).');
    process.exit(1);
  }
  const dir = process.argv[2] ?? 'db/migrations';
  migrate(dir, url).then(
    ({ applied, unprotected }) => {
      if (!applied.length) console.log('database is up to date');
      if (unprotected === null) console.warn('warning: basalt_auth is not installed in this database; run the api_setup tool.');
      else if (unprotected.length) {
        console.warn('WARNING: these tables look like per-user data but are not protected:');
        for (const t of unprotected) console.warn(`  ${t.table_name} (${t.owner_like_column}) -> add: SELECT basalt_auth.protect('${t.table_name}', '${t.owner_like_column}');`);
        process.exitCode = 2;
      }
    },
    (err) => {
      console.error(String((err as Error).message));
      process.exit(1);
    },
  );
}
