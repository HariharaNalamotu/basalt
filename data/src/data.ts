import pg from 'pg';
import { getTable, SYSTEM_COLUMNS, type Contract, type TableSpec } from './contract.ts';
import { BasaltError, type BasaltErrorCode } from './errors.ts';
import { checkId, checkValue, checkWrite, ISO_TIMESTAMP } from './validate.ts';

// The Data block core. This is the only way to touch an app's database:
// get, list, create, update, archive and restore. There is no raw SQL method
// and no permanent delete.
//
// It runs inside the Data service (server.ts), never inside app code, so the
// app never holds a database login. Each call is one round trip to
// basalt.api() in Postgres, which verifies the login token, charges the user's
// damage limits and runs the operation as that user. This code never has the
// signing secret and its database login can't touch a table directly.

export interface BasaltDataOptions {
  connectionString: string;
  contract: Contract;
  poolSize?: number;
}

export type FilterValue = string | number | boolean | { gte?: string | number; gt?: string | number; lte?: string | number; lt?: string | number };

export interface ListOptions {
  limit?: number;
  after?: string;
  // true lists only archived rows. By default they're left out.
  archived?: boolean;
  // { service: 'Color' } or { starts_at: { gte: '2026-11-06T00:00:00Z', lt: '2026-11-07T00:00:00Z' } }
  where?: Record<string, FilterValue>;
  // Newest first by default. Any required field, created_at or updated_at.
  sort?: { field: string; direction?: 'asc' | 'desc' };
}

export interface CreateOptions {
  // Send the same key again (for example on a retry) and you get the row
  // created the first time instead of a duplicate.
  key?: string;
}

export type Row = Record<string, unknown>;

const MAX_PAGE = 100;
const DEFAULT_PAGE = 20;
// Exact base64url JWT shape. The database checks it again.
const TOKEN = /^[A-Za-z0-9_-]{2,1024}\.[A-Za-z0-9_-]{2,3000}\.[A-Za-z0-9_-]{43}$/;
const KEY = /^[A-Za-z0-9_-]{1,200}$/;
// Timestamps as Postgres writes them in JSON, like 2026-10-24T08:55:20.123456+00:00.
const CURSOR_TIME = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)$/;
const CODES = new Set<BasaltErrorCode>(['invalid_input', 'not_found', 'denied', 'rate_limited', 'unavailable']);

// A page cursor remembers the sort field, that field's value on the last row and its id.
export function encodeCursor(row: Row, sortField = 'created_at'): string {
  return Buffer.from(JSON.stringify([sortField, row[sortField], row.id])).toString('base64url');
}

function decodeCursor(cursor: unknown, sortField: string): [unknown, string] {
  try {
    if (typeof cursor !== 'string' || cursor.length > 2000) throw new Error();
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 3 || parsed[0] !== sortField) throw new Error();
    const v = parsed[1];
    if (!['string', 'number', 'boolean'].includes(typeof v)) throw new Error();
    if ((sortField === 'created_at' || sortField === 'updated_at') && !CURSOR_TIME.test(String(v))) throw new Error();
    return [v, checkId(parsed[2])];
  } catch {
    throw new BasaltError('invalid_input', 'That page cursor is not valid for this sort.');
  }
}

const RANGE_OPS = new Set(['gte', 'gt', 'lte', 'lt']);

function checkWhere(spec: TableSpec, where: unknown): Record<string, unknown> {
  if (typeof where !== 'object' || where === null || Array.isArray(where)) {
    throw new BasaltError('invalid_input', 'where must be an object like { service: "Color" }.');
  }
  const out: Record<string, unknown> = {};
  const keys = Object.keys(where);
  if (keys.length > 10) throw new BasaltError('invalid_input', 'You can filter on up to 10 fields at once.');
  const allowed = [...spec.fields.keys(), ...SYSTEM_COLUMNS];
  for (const key of keys) {
    const field = spec.fields.get(key);
    const system = (SYSTEM_COLUMNS as readonly string[]).includes(key);
    if (!field && !system) {
      throw new BasaltError('invalid_input', `You can't filter on "${key.slice(0, 50)}". Fields you can filter on: ${allowed.join(', ')}.`);
    }
    const check = (v: unknown) => {
      if (field) return checkValue(spec.name, key, { ...field, required: true }, v);
      if (key.endsWith('_at')) {
        if (typeof v !== 'string' || !ISO_TIMESTAMP.test(v)) throw new BasaltError('invalid_input', `${key} must be a date and time.`);
        return v;
      }
      return checkId(v);
    };
    const value = (where as Record<string, unknown>)[key];
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const ops = Object.keys(value);
      if (ops.length === 0 || ops.some((o) => !RANGE_OPS.has(o))) {
        throw new BasaltError('invalid_input', `A range filter on ${key} can use gte, gt, lte and lt.`);
      }
      out[key] = Object.fromEntries(ops.map((o) => [o, check((value as Record<string, unknown>)[o])]));
    } else {
      out[key] = check(value);
    }
  }
  return out;
}

export class BasaltData {
  #pool: pg.Pool;
  #contract: Contract;

  constructor(options: BasaltDataOptions) {
    this.#contract = options.contract;
    this.#pool = new pg.Pool({
      connectionString: options.connectionString,
      max: options.poolSize ?? 10,
      // Fail fast instead of piling up requests when the database is busy.
      connectionTimeoutMillis: 2000,
      idleTimeoutMillis: 30_000,
      query_timeout: 4000,
      application_name: 'basalt-data',
    });
    // A dropped idle connection shouldn't crash the service.
    this.#pool.on('error', () => {});
  }

  get contract(): Contract {
    return this.#contract;
  }

  async get(token: string, table: string, id: string): Promise<Row> {
    const spec = getTable(this.#contract, table);
    return (await this.#call(token, 'get', spec.name, { id: checkId(id) })) as Row;
  }

  async list(token: string, table: string, options: ListOptions = {}): Promise<{ rows: Row[]; next: string | null }> {
    const spec = getTable(this.#contract, table);
    const limit = options.limit ?? DEFAULT_PAGE;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) {
      throw new BasaltError('invalid_input', `limit must be a whole number from 1 to ${MAX_PAGE}.`);
    }
    const args: Record<string, unknown> = { limit };
    let sortField = 'created_at';
    if (options.sort !== undefined) {
      const sort = options.sort as { field?: unknown; direction?: unknown };
      const sortable = ['created_at', 'updated_at', ...[...spec.fields].filter(([, f]) => f.required).map(([n]) => n)];
      if (typeof sort !== 'object' || sort === null || typeof sort.field !== 'string' || !sortable.includes(sort.field)) {
        throw new BasaltError('invalid_input', `You can sort by: ${sortable.join(', ')}.`);
      }
      if (sort.direction !== undefined && sort.direction !== 'asc' && sort.direction !== 'desc') {
        throw new BasaltError('invalid_input', 'Sort direction must be "asc" or "desc".');
      }
      sortField = sort.field;
      args.sort = { field: sort.field, direction: sort.direction ?? 'desc' };
    }
    if (options.where !== undefined) args.where = checkWhere(spec, options.where);
    if (options.archived !== undefined) {
      if (typeof options.archived !== 'boolean') throw new BasaltError('invalid_input', 'archived must be true or false.');
      args.archived = options.archived;
    }
    if (options.after !== undefined && options.after !== null) {
      const [value, id] = decodeCursor(options.after, sortField);
      args.after = { [sortField]: value };
      args.after_id = id;
    }
    // The database returns one extra row so we know whether there's a next page.
    const rows = (await this.#call(token, 'list', spec.name, args)) as Row[];
    const page = rows.slice(0, limit);
    return { rows: page, next: rows.length > limit ? encodeCursor(page[page.length - 1], sortField) : null };
  }

  async create(token: string, table: string, input: unknown, options: CreateOptions = {}): Promise<Row> {
    const spec = getTable(this.#contract, table);
    const { columns, values } = checkWrite(spec, input, 'create');
    const args: Record<string, unknown> = { input: Object.fromEntries(columns.map((c, i) => [c, values[i]])) };
    if (options.key !== undefined) {
      if (typeof options.key !== 'string' || !KEY.test(options.key)) {
        throw new BasaltError('invalid_input', 'key must be 1 to 200 letters, numbers, dashes or underscores.');
      }
      args.key = options.key;
    }
    return (await this.#call(token, 'create', spec.name, args)) as Row;
  }

  async update(token: string, table: string, id: string, input: unknown): Promise<Row> {
    const spec = getTable(this.#contract, table);
    const rowId = checkId(id);
    const { columns, values } = checkWrite(spec, input, 'update');
    return (await this.#call(token, 'update', spec.name, { id: rowId, input: Object.fromEntries(columns.map((c, i) => [c, values[i]])) })) as Row;
  }

  // Hides a row from lists without losing it. restore() brings it back.
  async archive(token: string, table: string, id: string): Promise<Row> {
    const spec = getTable(this.#contract, table);
    return (await this.#call(token, 'archive', spec.name, { id: checkId(id) })) as Row;
  }

  async restore(token: string, table: string, id: string): Promise<Row> {
    const spec = getTable(this.#contract, table);
    return (await this.#call(token, 'restore', spec.name, { id: checkId(id) })) as Row;
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }

  async #call(token: string, op: string, table: string, args: Record<string, unknown>): Promise<unknown> {
    if (typeof token !== 'string' || !TOKEN.test(token)) {
      throw new BasaltError('denied', 'Your login is missing, expired or not valid. Log in again.');
    }
    let reply: { ok: boolean; data?: unknown; code?: string; message?: string } | undefined;
    try {
      const res = await this.#pool.query('select basalt.api($1, $2, $3, $4::jsonb) as r', [token, op, table, JSON.stringify(args)]);
      reply = res.rows[0]?.r;
    } catch (err) {
      // Raw database errors never leave this function.
      const code = (err as { code?: string })?.code ?? '';
      if (code === '57014' || code === '25P04' || code === '55P03') {
        throw new BasaltError('unavailable', 'That took too long and was stopped. Try again.');
      }
      throw new BasaltError('unavailable', 'The database is unavailable right now. Try again.');
    }
    if (!reply) throw new BasaltError('unavailable', 'The database sent back something unexpected.');
    if (reply.ok) return reply.data;
    const code = CODES.has(reply.code as BasaltErrorCode) ? (reply.code as BasaltErrorCode) : 'unavailable';
    throw new BasaltError(code, typeof reply.message === 'string' ? reply.message : 'Something went wrong.');
  }
}
