import { BasaltError } from './errors.ts';

// The contract is the app's data map: its tables, their fields and the rules on
// each field. The AI writes it. Everything else is generated from it by plain code,
// so it's treated as untrusted input and checked strictly here.

export type FieldType = 'text' | 'integer' | 'number' | 'boolean' | 'timestamp';

export interface FieldSpec {
  type: FieldType;
  required: boolean;
  maxLength: number;
  pattern?: string;
  min?: number;
  max?: number;
  private: boolean;
}

export interface TableSpec {
  name: string;
  fields: Map<string, FieldSpec>;
}

export interface Contract {
  tables: Map<string, TableSpec>;
}

export const SYSTEM_COLUMNS = ['id', 'owner_id', 'created_at', 'updated_at'] as const;

const NAME = /^[a-z][a-z0-9_]{0,40}$/;
const TYPES: readonly FieldType[] = ['text', 'integer', 'number', 'boolean', 'timestamp'];
const MAX_TABLES = 50;
const MAX_FIELDS = 60;
const DEFAULT_MAX_LENGTH = 1000;
const MAX_TEXT_LENGTH = 10000;
const MAX_PATTERN_LENGTH = 200;
const INT_MIN = -2147483648;
const INT_MAX = 2147483647;
const RESERVED = new Set<string>([...SYSTEM_COLUMNS, 'select', 'from', 'where', 'table', 'user', 'order', 'group']);

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

  const allowed = new Set(['type', 'required', 'maxLength', 'pattern', 'min', 'max', 'private']);
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
    // Private by default. Only an explicit false makes a field non-private.
    private: raw.private !== false,
  };

  if (raw.maxLength !== undefined) {
    if (spec.type !== 'text') fail(`Field ${table}.${name}: maxLength only applies to text.`);
    if (!Number.isInteger(raw.maxLength) || (raw.maxLength as number) < 1 || (raw.maxLength as number) > MAX_TEXT_LENGTH) {
      fail(`Field ${table}.${name}: maxLength must be a whole number from 1 to ${MAX_TEXT_LENGTH}.`);
    }
    spec.maxLength = raw.maxLength as number;
  }

  if (raw.pattern !== undefined) {
    if (spec.type !== 'text') fail(`Field ${table}.${name}: pattern only applies to text.`);
    if (typeof raw.pattern !== 'string' || raw.pattern.length === 0 || raw.pattern.length > MAX_PATTERN_LENGTH) {
      fail(`Field ${table}.${name}: pattern must be a string up to ${MAX_PATTERN_LENGTH} characters.`);
    }
    if (!raw.pattern.startsWith('^') || !raw.pattern.endsWith('$')) {
      fail(`Field ${table}.${name}: pattern must start with ^ and end with $ so it checks the whole value.`);
    }
    try {
      new RegExp(raw.pattern, 'u');
    } catch {
      fail(`Field ${table}.${name}: pattern is not a valid regular expression.`);
    }
    // Block nested repeats like (a+)+ that can hang the server on crafted input.
    if (/\([^)]*[+*}][^)]*\)\s*[+*{]/.test(raw.pattern) || /\\[1-9]/.test(raw.pattern)) {
      fail(`Field ${table}.${name}: pattern has nested repeats or backreferences, which can be abused to slow the server down.`);
    }
    spec.pattern = raw.pattern;
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

    const fieldEntries = Object.entries(tableRaw.fields);
    if (fieldEntries.length === 0) fail(`Table ${tableName} has no fields.`);
    if (fieldEntries.length > MAX_FIELDS) fail(`Table ${tableName} has more than ${MAX_FIELDS} fields.`);

    const fields = new Map<string, FieldSpec>();
    for (const [fieldName, fieldRaw] of fieldEntries) {
      fields.set(fieldName, parseField(tableName, fieldName, fieldRaw));
    }
    tables.set(tableName, { name: tableName, fields });
  }

  return { tables };
}

export function getTable(contract: Contract, name: unknown): TableSpec {
  if (typeof name !== 'string') throw new BasaltError('invalid_input', 'Table name must be a string.');
  const table = contract.tables.get(name);
  if (!table) throw new BasaltError('invalid_input', `There's no table called "${name.slice(0, 50)}" in this app's contract.`);
  return table;
}
