import { FORMATS, type FieldSpec, type TableSpec, type TextFormat } from './contract.ts';
import { BasaltError } from './errors.ts';

// Checks every value against the contract before anything reaches the database.
// The database checks the same rules again (see schema.ts), so a bug here can't
// let bad data through on its own.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FORMAT_REGEX = Object.fromEntries(
  Object.entries(FORMATS).map(([k, v]) => [k, new RegExp(v, 'u')]),
) as Record<TextFormat, RegExp>;
export const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;

function bad(message: string): never {
  throw new BasaltError('invalid_input', message);
}

export function checkId(id: unknown): string {
  if (typeof id !== 'string' || !UUID.test(id)) bad('That id is not valid.');
  return id.toLowerCase();
}

export function checkValue(table: string, name: string, spec: FieldSpec, value: unknown): unknown {
  const where = `${table}.${name}`;

  if (value === null) {
    if (spec.required) bad(`${where} is required.`);
    return null;
  }

  switch (spec.type) {
    case 'text': {
      if (typeof value !== 'string') bad(`${where} must be text.`);
      // Count characters, not bytes, to match the database check.
      if ([...value].length > spec.maxLength) bad(`${where} can be at most ${spec.maxLength} characters.`);
      if (value.includes('\u0000')) bad(`${where} contains a character that isn't allowed.`);
      if (spec.format && !FORMAT_REGEX[spec.format].test(value)) bad(`${where} must be a valid ${spec.format.replace('_', ' ')}.`);
      return value;
    }
    case 'integer': {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < -2147483648 || value > 2147483647) {
        bad(`${where} must be a whole number.`);
      }
      if (spec.min !== undefined && value < spec.min) bad(`${where} must be at least ${spec.min}.`);
      if (spec.max !== undefined && value > spec.max) bad(`${where} must be at most ${spec.max}.`);
      return value;
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) bad(`${where} must be a number.`);
      if (spec.min !== undefined && value < spec.min) bad(`${where} must be at least ${spec.min}.`);
      if (spec.max !== undefined && value > spec.max) bad(`${where} must be at most ${spec.max}.`);
      return value;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') bad(`${where} must be true or false.`);
      return value;
    }
    case 'user': {
      if (typeof value !== 'string' || !UUID.test(value)) bad(`${where} must be a user id.`);
      return value.toLowerCase();
    }
    case 'timestamp': {
      if (typeof value !== 'string' || !ISO_TIMESTAMP.test(value) || Number.isNaN(Date.parse(value))) {
        bad(`${where} must be a date and time like 2026-10-24T15:00:00Z.`);
      }
      return value;
    }
  }
}

// Returns the columns and values to write, in a fixed order.
// Unknown fields are rejected, never silently dropped, so the AI hears about mistakes.
export function checkWrite(
  table: TableSpec,
  input: unknown,
  mode: 'create' | 'update',
): { columns: string[]; values: unknown[] } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) bad('Expected an object of fields.');

  const keys = Object.keys(input);
  for (const key of keys) {
    if (!table.fields.has(key)) bad(`"${key.slice(0, 50)}" is not a field you can set on ${table.name}.`);
  }

  const columns: string[] = [];
  const values: unknown[] = [];
  for (const [name, spec] of table.fields) {
    const present = Object.hasOwn(input, name);
    if (!present) {
      if (mode === 'create' && spec.required) bad(`${table.name}.${name} is required.`);
      continue;
    }
    columns.push(name);
    values.push(checkValue(table.name, name, spec, (input as Record<string, unknown>)[name]));
  }

  if (mode === 'update' && columns.length === 0) bad('Nothing to update.');
  return { columns, values };
}
