import { BasaltError } from './errors.ts';

// The contract is the app's data map: its tables, their fields and the rules on
// each field. The AI writes it. Everything else is generated from it by plain code,
// so it's treated as untrusted input and checked strictly here.

// 'user' holds another user's id, for sharing a row with them (see shareWith).
// 'file' holds the id of an uploaded file (see sql/05_files.sql).
export type FieldType = 'text' | 'integer' | 'number' | 'boolean' | 'timestamp' | 'user' | 'file';

// Free-form regexes from the contract could be crafted to hang the server, so
// text fields pick from a fixed set of formats instead. Each pattern runs in
// linear time and uses syntax that means the same thing in JavaScript and Postgres.
// Postgres caps repeat counts at 255, so longer limits come from maxLength.
export const FORMATS = {
  email: '^[^@\\s]{1,64}@[^@\\s]{1,255}$',
  phone: '^\\+?[0-9 ()-]{7,20}$',
  url: '^https?://[^\\s]+$',
  postal_code: '^[A-Za-z0-9 -]{3,10}$',
  slug: '^[a-z0-9]{1,80}(-[a-z0-9]{1,80}){0,20}$',
} as const;
export type TextFormat = keyof typeof FORMATS;

export interface FieldSpec {
  type: FieldType;
  required: boolean;
  maxLength: number;
  format?: TextFormat;
  min?: number;
  max?: number;
}

export interface TableSpec {
  name: string;
  fields: Map<string, FieldSpec>;
  // A 'user' field. The user named there can read the row but not change it.
  shareWith?: string;
  // Groups of required fields no two active rows may share, across everyone (like two bookings
  // at the same time). Archived rows don't count, so cancelling frees the value.
  unique?: string[][];
}

export interface Contract {
  tables: Map<string, TableSpec>;
}

export const SYSTEM_COLUMNS = ['id', 'owner_id', 'created_at', 'updated_at', 'archived_at'] as const;
// Set by the API for idempotent creates. Never returned or writable.
export const HIDDEN_COLUMNS = ['request_key'] as const;

const NAME = /^[a-z][a-z0-9_]{0,40}$/;
const TYPES: readonly FieldType[] = ['text', 'integer', 'number', 'boolean', 'timestamp', 'user', 'file'];
const MAX_TABLES = 50;
const MAX_FIELDS = 60;
const DEFAULT_MAX_LENGTH = 1000;
const MAX_TEXT_LENGTH = 10000;
const INT_MIN = -2147483648;
const INT_MAX = 2147483647;
const RESERVED = new Set<string>([...SYSTEM_COLUMNS, ...HIDDEN_COLUMNS, 'select', 'from', 'where', 'table', 'user', 'order', 'group']);

function fail(message: string): never {
  throw new BasaltError('contract', message);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}

function checkName(kind: string, name: string): void {
  if (!NAME.test(name)) fail(`${kind} name "${name}" must be lowercase letters, numbers and underscores, starting with a letter.`);
  if (RESERVED.has(name)) fail(`${kind} name "${name}" is reserved.`);
}

function parseField(table: string, name: string, raw: unknown): FieldSpec {
  checkName('Field', name);
  if (!isPlainObject(raw)) fail(`Field ${table}.${name} must be an object.`);

  const allowed = new Set(['type', 'required', 'maxLength', 'format', 'min', 'max']);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) fail(`Field ${table}.${name} has an unknown setting "${key}".`);
  }

  const type = raw.type;
  if (typeof type !== 'string' || !TYPES.includes(type as FieldType)) {
    fail(`Field ${table}.${name} needs a type: ${TYPES.join(', ')}.`);
  }

  const spec: FieldSpec = {
    type: type as FieldType,
    required: raw.required === true,
    maxLength: DEFAULT_MAX_LENGTH,
  };

  if (raw.maxLength !== undefined) {
    if (spec.type !== 'text') fail(`Field ${table}.${name}: maxLength only applies to text.`);
    if (!Number.isInteger(raw.maxLength) || (raw.maxLength as number) < 1 || (raw.maxLength as number) > MAX_TEXT_LENGTH) {
      fail(`Field ${table}.${name}: maxLength must be a whole number from 1 to ${MAX_TEXT_LENGTH}.`);
    }
    spec.maxLength = raw.maxLength as number;
  }

  if (raw.format !== undefined) {
    if (spec.type !== 'text') fail(`Field ${table}.${name}: format only applies to text.`);
    if (typeof raw.format !== 'string' || !Object.hasOwn(FORMATS, raw.format)) {
      fail(`Field ${table}.${name}: format must be one of ${Object.keys(FORMATS).join(', ')}.`);
    }
    spec.format = raw.format as TextFormat;
  }

  for (const bound of ['min', 'max'] as const) {
    const v = raw[bound];
    if (v === undefined) continue;
    if (spec.type !== 'integer' && spec.type !== 'number') fail(`Field ${table}.${name}: ${bound} only applies to numbers.`);
    if (typeof v !== 'number' || !Number.isFinite(v)) fail(`Field ${table}.${name}: ${bound} must be a number.`);
    if (spec.type === 'integer' && (!Number.isInteger(v) || v < INT_MIN || v > INT_MAX)) {
      fail(`Field ${table}.${name}: ${bound} must be a whole number in the integer range.`);
    }
    spec[bound] = v;
  }
  if (spec.min !== undefined && spec.max !== undefined && spec.min > spec.max) {
    fail(`Field ${table}.${name}: min is bigger than max.`);
  }

  return spec;
}

export function parseContract(raw: unknown): Contract {
  if (!isPlainObject(raw) || !isPlainObject(raw.tables)) fail('The contract needs a "tables" object.');

  const tableEntries = Object.entries(raw.tables);
  if (tableEntries.length === 0) fail('The contract has no tables.');
  if (tableEntries.length > MAX_TABLES) fail(`The contract has more than ${MAX_TABLES} tables.`);

  const tables = new Map<string, TableSpec>();
  for (const [tableName, tableRaw] of tableEntries) {
    checkName('Table', tableName);
    if (!isPlainObject(tableRaw) || !isPlainObject(tableRaw.fields)) fail(`Table ${tableName} needs a "fields" object.`);
    for (const key of Object.keys(tableRaw)) {
      if (key !== 'fields' && key !== 'shareWith' && key !== 'unique') fail(`Table ${tableName} has an unknown setting "${key}".`);
    }

    const fieldEntries = Object.entries(tableRaw.fields);
    if (fieldEntries.length === 0) fail(`Table ${tableName} has no fields.`);
    if (fieldEntries.length > MAX_FIELDS) fail(`Table ${tableName} has more than ${MAX_FIELDS} fields.`);

    const fields = new Map<string, FieldSpec>();
    for (const [fieldName, fieldRaw] of fieldEntries) {
      fields.set(fieldName, parseField(tableName, fieldName, fieldRaw));
    }
    const table: TableSpec = { name: tableName, fields };
    if (tableRaw.shareWith !== undefined) {
      const share = tableRaw.shareWith;
      if (typeof share !== 'string' || fields.get(share)?.type !== 'user') {
        fail(`Table ${tableName}: shareWith must name one of its fields with type "user".`);
      }
      table.shareWith = share;
    }
    if (tableRaw.unique !== undefined) {
      const groups = tableRaw.unique;
      if (!Array.isArray(groups) || groups.some((g) => !Array.isArray(g))) fail(`Table ${tableName}: unique must be a list of field groups, like [["starts_at"]].`);
      if (groups.length > 5) fail(`Table ${tableName}: unique can have up to 5 groups.`);
      table.unique = (groups as unknown[][]).map((group) => {
        if (group.length < 1 || group.length > 3) fail(`Table ${tableName}: each unique group names 1 to 3 fields.`);
        if (new Set(group).size !== group.length) fail(`Table ${tableName}: a unique group names a field twice.`);
        for (const f of group) {
          if (typeof f !== 'string' || !fields.has(f)) fail(`Table ${tableName}: unique names "${String(f)}", which isn't one of its fields.`);
          if (!fields.get(f)!.required) fail(`Table ${tableName}: unique field ${f} must be required (an empty value can't be kept unique).`);
        }
        return group as string[];
      });
    }
    tables.set(tableName, table);
  }

  return { tables };
}

export function getTable(contract: Contract, name: unknown): TableSpec {
  if (typeof name !== 'string') throw new BasaltError('invalid_input', 'Table name must be a string.');
  const table = contract.tables.get(name);
  if (!table) throw new BasaltError('invalid_input', `There's no table called "${name.slice(0, 50)}" in this app's contract.`);
  return table;
}
