// Applies a contract to the database. This is the only code that uses the
// admin login, and it runs from the command line, never inside an app.
//
//   node --env-file=.env src/migrate.ts path/to/contract.json
//
// New tables are created. On an existing table the only change allowed is
// adding new optional fields. Anything else (removing a field, changing its
// type or loosening a rule) is refused, because it needs a reviewed migration.

import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import pg from 'pg';
import { parseContract, type TableSpec } from './contract.ts';
import { addColumnSql, tableSpecJson, tableSql } from './schema.ts';

type StoredSpec = { fields: Record<string, unknown>; shareWith?: string };

// Returns the fields to add, or throws if the change isn't allowed.
function plan(table: TableSpec, before: StoredSpec): string[] {
  const after = tableSpecJson(table);
  const refuse = (why: string): never => {
    throw new Error(`The contract changes table ${table.name}: ${why}. Changing that needs a reviewed migration, so nothing was applied.`);
  };

  if (before.shareWith !== after.shareWith) refuse('who it is shared with changed');
  for (const [name, spec] of Object.entries(before.fields)) {
    if (!Object.hasOwn(after.fields, name)) refuse(`field ${name} was removed`);
    if (!isDeepStrictEqual(spec, after.fields[name])) refuse(`the rules for field ${name} changed`);
  }
  const added = Object.keys(after.fields).filter((name) => !Object.hasOwn(before.fields, name));
  for (const name of added) {
    if (table.fields.get(name)!.required) refuse(`new field ${name} is required, and existing rows have no value for it`);
  }
  return added;
}

export async function migrate(adminUrl: string, contractJson: unknown): Promise<{ tables: string[]; added: string[] }> {
  const contract = parseContract(contractJson);
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  const added: string[] = [];
  try {
    await client.query('begin');

    for (const table of contract.tables.values()) {
      const exists = await client.query(`select to_regclass($1) is not null as yes`, [`app.${table.name}`]);
      const stored = await client.query<{ spec: StoredSpec }>(`select spec from basalt.registry where table_name = $1`, [table.name]);

      if (exists.rows[0].yes && stored.rowCount === 0) {
        throw new Error(`Table app.${table.name} already exists but wasn't made by Basalt, so nothing was applied.`);
      }
      if (stored.rowCount) {
        for (const name of plan(table, stored.rows[0].spec)) {
          await client.query(addColumnSql(table, name));
          added.push(`${table.name}.${name}`);
        }
      }
      for (const sql of tableSql(table)) await client.query(sql);
    }

    await client.query('select basalt.ensure_audit_partitions()');
    await client.query('commit');
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
  return { tables: [...contract.tables.keys()], added };
}

if (import.meta.main) {
  const file = process.argv[2];
  const adminUrl = process.env.BASALT_ADMIN_URL;
  if (!file || !adminUrl) {
    console.error('Usage: BASALT_ADMIN_URL=... node src/migrate.ts contract.json');
    process.exit(1);
  }
  const result = await migrate(adminUrl, JSON.parse(readFileSync(file, 'utf8')));
  console.log(`basalt: contract applied (${result.tables.join(', ')})${result.added.length ? `, added ${result.added.join(', ')}` : ''}`);
}
