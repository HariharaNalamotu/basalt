// Applies a contract to the database. This is the only code that uses the
// superuser login, and it runs from the command line, never inside an app.
//
//   node --env-file=.env src/migrate.ts path/to/contract.json

import { readFileSync } from 'node:fs';
import pg from 'pg';
import { parseContract } from './contract.ts';
import { contractSql } from './schema.ts';

export async function migrate(adminUrl: string, contractJson: unknown): Promise<string[]> {
  const contract = parseContract(contractJson);
  const statements = contractSql(contract);
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query('begin');
    for (const sql of statements) await client.query(sql);
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
