import { createHash } from 'node:crypto';
import { FORMATS, type Contract, type FieldSpec, type TableSpec } from './contract.ts';

// Turns the contract into SQL with plain code. No AI is involved, so the same
// contract always gives the same database. Names are already checked by
// contract.ts. Literals still go through quoteLiteral as a second guard.

export function quoteIdent(name: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(name)) throw new Error(`Refusing unsafe identifier: ${name}`);
  return `"${name}"`;
}

export function quoteLiteral(value: string): string {
  if (value.includes('\u0000')) throw new Error('Refusing literal with a null byte');
  return `'${value.replaceAll("'", "''")}'`;
}

function columnSql(name: string, spec: FieldSpec): string {
  const col = quoteIdent(name);
  const checks: string[] = [];
  let type: string;

  switch (spec.type) {
    case 'text':
      type = 'text';
      checks.push(`char_length(${col}) <= ${spec.maxLength}`);
      if (spec.format) checks.push(`${col} ~ ${quoteLiteral(FORMATS[spec.format])}`);
      break;
    case 'integer':
      type = 'integer';
      break;
    case 'number':
      type = 'double precision';
      checks.push(`${col} <> 'NaN'::double precision`, `${col} not in ('Infinity'::double precision, '-Infinity'::double precision)`);
      break;
    case 'boolean':
      type = 'boolean';
      break;
    case 'timestamp':
      type = 'timestamptz';
      checks.push(`isfinite(${col})`);
      break;
  }

  if (spec.min !== undefined) checks.push(`${col} >= ${Number(spec.min)}`);
  if (spec.max !== undefined) checks.push(`${col} <= ${Number(spec.max)}`);

  const parts = [col, type];
  if (spec.required) parts.push('not null');
  for (const c of checks) parts.push(`check (${c})`);
  return parts.join(' ');
}

function createTableSql(table: TableSpec): string {
  return `create table if not exists app.${quoteIdent(table.name)} (
  "id" uuid primary key default gen_random_uuid(),
  "owner_id" uuid not null default basalt.uid(),
  ${[...table.fields].map(([n, s]) => columnSql(n, s)).join(',\n  ')},
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now()
)`;
}

// A fingerprint of everything about a table's columns: names, types, required
// flags, lengths, formats and bounds. Stored on the table so migrate can tell
// when a contract would change a table that already exists.
export function tableFingerprint(table: TableSpec): string {
  return `basalt:${createHash('sha256').update(createTableSql(table)).digest('hex')}`;
}

export function tableSql(table: TableSpec): string[] {
  const t = `app.${quoteIdent(table.name)}`;
  const writable = [...table.fields.keys()].map(quoteIdent).join(', ');
  const owner = '(select basalt.uid())';

  return [
    createTableSql(table),
    `comment on table ${t} is ${quoteLiteral(tableFingerprint(table))}`,
    `alter table ${t} owner to basalt_owner`,
    `alter table ${t} enable row level security`,
    `alter table ${t} force row level security`,
    `revoke all on ${t} from public`,
    // Start from nothing on every run so a stale grant or policy can't survive.
    `revoke all on ${t} from basalt_data`,
    `do $basalt$ declare p record; begin
  for p in select policyname from pg_policies where schemaname = 'app' and tablename = ${quoteLiteral(table.name)} loop
    execute format('drop policy %I on app.%I', p.policyname, ${quoteLiteral(table.name)});
  end loop;
end $basalt$`,

    // Keeps "my rows, newest first" fast at any table size.
    `create index if not exists ${quoteIdent(`${table.name}_owner_recent`)} on ${t} ("owner_id", "created_at" desc, "id" desc)`,

    // Each user only ever sees and changes their own rows.
    `create policy basalt_select on ${t} for select to basalt_data using ("owner_id" = ${owner})`,
    `create policy basalt_insert on ${t} for insert to basalt_data with check ("owner_id" = ${owner})`,
    `create policy basalt_update on ${t} for update to basalt_data using ("owner_id" = ${owner}) with check ("owner_id" = ${owner})`,

    // The Data block can read rows and write only the contract's fields.
    // id, owner_id and the timestamps are set by the database. No delete at all.
    `grant select on ${t} to basalt_data`,
    `grant insert (${writable}) on ${t} to basalt_data`,
    `grant update (${writable}) on ${t} to basalt_data`,

    // Updates that change nothing don't bump updated_at or write to the audit log.
    `drop trigger if exists basalt_touch on ${t}`,
    `create trigger basalt_touch before update on ${t} for each row when (old.* is distinct from new.*) execute function basalt.touch_updated_at()`,
    `drop trigger if exists basalt_audit on ${t}`,
    `drop trigger if exists basalt_audit_insert on ${t}`,
    `create trigger basalt_audit_insert after insert on ${t} for each row execute function basalt.audit_row()`,
    `drop trigger if exists basalt_audit_update on ${t}`,
    `create trigger basalt_audit_update after update on ${t} for each row when (old.* is distinct from new.*) execute function basalt.audit_row()`,
  ];
}

export function contractSql(contract: Contract): string[] {
  return [...contract.tables.values()].flatMap(tableSql);
}
