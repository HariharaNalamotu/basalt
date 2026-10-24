import type { Contract, FieldSpec, TableSpec } from './contract.ts';

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
      if (spec.pattern) checks.push(`${col} ~ ${quoteLiteral(spec.pattern)}`);
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
      break;
  }

  if (spec.min !== undefined) checks.push(`${col} >= ${Number(spec.min)}`);
  if (spec.max !== undefined) checks.push(`${col} <= ${Number(spec.max)}`);

  const parts = [col, type];
  if (spec.required) parts.push('not null');
  for (const c of checks) parts.push(`check (${c})`);
  return parts.join(' ');
}

export function tableSql(table: TableSpec): string[] {
  const t = `app.${quoteIdent(table.name)}`;
  const writable = [...table.fields.keys()].map(quoteIdent).join(', ');
  const owner = '(select basalt.uid())';

  return [
    `create table if not exists ${t} (
  "id" uuid primary key default gen_random_uuid(),
  "owner_id" uuid not null default basalt.uid(),
  ${[...table.fields].map(([n, s]) => columnSql(n, s)).join(',\n  ')},
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now()
)`,
    `alter table ${t} owner to basalt_owner`,
    `alter table ${t} enable row level security`,
    `alter table ${t} force row level security`,
    `revoke all on ${t} from public`,

    // Keeps "my rows, newest first" fast at any table size.
    `create index if not exists ${quoteIdent(`${table.name}_owner_recent`)} on ${t} ("owner_id", "created_at" desc, "id" desc)`,

    // Each user only ever sees and changes their own rows.
    `drop policy if exists basalt_select on ${t}`,
    `create policy basalt_select on ${t} for select to basalt_data using ("owner_id" = ${owner})`,
    `drop policy if exists basalt_insert on ${t}`,
    `create policy basalt_insert on ${t} for insert to basalt_data with check ("owner_id" = ${owner})`,
    `drop policy if exists basalt_update on ${t}`,
    `create policy basalt_update on ${t} for update to basalt_data using ("owner_id" = ${owner}) with check ("owner_id" = ${owner})`,

    // The Data block can read rows and write only the contract's fields.
    // id, owner_id and the timestamps are set by the database. No delete at all.
    `grant select on ${t} to basalt_data`,
    `grant insert (${writable}) on ${t} to basalt_data`,
    `grant update (${writable}) on ${t} to basalt_data`,

    `drop trigger if exists basalt_touch on ${t}`,
    `create trigger basalt_touch before update on ${t} for each row execute function basalt.touch_updated_at()`,
    `drop trigger if exists basalt_audit on ${t}`,
    `create trigger basalt_audit after insert or update on ${t} for each row execute function basalt.audit_row()`,
  ];
}

export function contractSql(contract: Contract): string[] {
  return [...contract.tables.values()].flatMap(tableSql);
}
