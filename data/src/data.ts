import pg from 'pg';
import { getTable, type Contract } from './contract.ts';
import { BasaltError, type BasaltErrorCode } from './errors.ts';
import { checkId, checkWrite } from './validate.ts';

// The Data block core. This is the only way to touch an app's database:
// get, list, create and update. There is no raw SQL method and no delete.
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

export interface ListOptions {
  limit?: number;
  after?: string;
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

export function encodeCursor(row: Row): string {
  return Buffer.from(JSON.stringify([row.created_at, row.id])).toString('base64url');
}

function decodeCursor(cursor: unknown): [string, string] {
  try {
    if (typeof cursor !== 'string' || cursor.length > 200) throw new Error();
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 2) throw new Error();
    if (typeof parsed[0] !== 'string' || !CURSOR_TIME.test(parsed[0])) throw new Error();
    return [parsed[0], checkId(parsed[1])];
  } catch {
    throw new BasaltError('invalid_input', 'That page cursor is not valid.');
  }
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
    if (options.after !== undefined && options.after !== null) {
      const [at, id] = decodeCursor(options.after);
      args.after_ts = at;
      args.after_id = id;
    }
    // The database returns one extra row so we know whether there's a next page.
    const rows = (await this.#call(token, 'list', spec.name, args)) as Row[];
    const page = rows.slice(0, limit);
    return { rows: page, next: rows.length > limit ? encodeCursor(page[page.length - 1]) : null };
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
