// Applies a contract to the database. This is the only code that uses the
// admin login, and it runs from the command line, never inside an app.
//
//   node --env-file=.env src/migrate.ts path/to/contract.json

import { readFileSync } from 'node:fs';
import pg from 'pg';
import { parseContract } from './contract.ts';
import { contractSql, tableFingerprint } from './schema.ts';

export async function migrate(adminUrl: string, contractJson: unknown): Promise<string[]> {
  const contract = parseContract(contractJson);
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query('begin');

    // Changing an existing table isn't supported yet. Refuse instead of leaving
    // old columns, types, checks or grants in place without anyone noticing.
    for (const table of contract.tables.values()) {
      const res = await client.query<{ fp: string | null }>(
        `select obj_description(c.oid, 'pg_class') as fp
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'app' and c.relname = $1 and c.relkind = 'r'`,
        [table.name],
      );
      if (res.rowCount === 0) continue;
      if (res.rows[0].fp !== tableFingerprint(table)) {
        throw new Error(
          `The contract changes table ${table.name} (its columns, types or rules differ from what's in the database). ` +
            'Changing an existing table needs a reviewed migration, so nothing was applied.',
        );
      }
    }

    for (const sql of contractSql(contract)) await client.query(sql);
    await client.query('commit');
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
  return [...contract.tables.keys()];
}

if (import.meta.main) {
  const file = process.argv[2];
  const adminUrl = process.env.BASALT_ADMIN_URL;
  if (!file || !adminUrl) {
    console.error('Usage: BASALT_ADMIN_URL=... node src/migrate.ts contract.json');
    process.exit(1);
  }
  const tables = await migrate(adminUrl, JSON.parse(readFileSync(file, 'utf8')));
  console.log(`basalt: contract applied (${tables.join(', ')})`);
}
