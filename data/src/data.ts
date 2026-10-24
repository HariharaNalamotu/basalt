import pg from 'pg';
import { getTable, SYSTEM_COLUMNS, type Contract, type TableSpec } from './contract.ts';
import { BasaltError } from './errors.ts';
import { quoteIdent } from './schema.ts';
import { checkId, checkWrite } from './validate.ts';

// The Data block core. This is the only way to touch an app's database:
// get, list, create and update. There is no raw SQL method and no delete.
//
// It runs inside the Data service (server.ts), never inside app code, so the
// app never holds a database login. Every call runs as the login token's user.
// Postgres checks the token signature itself (basalt.uid()), so this code never
// needs the signing secret and can't pretend to be anyone.

export interface BasaltDataOptions {
  connectionString: string;
  contract: Contract;
  poolSize?: number;
}

export interface ListOptions {
  limit?: number;
  after?: string;
}

export type Row = Record<string, unknown>;

const MAX_PAGE = 100;
const DEFAULT_PAGE = 20;
// Exact base64url JWT shape. The database checks it again.
const TOKEN = /^[A-Za-z0-9_-]{2,1024}\.[A-Za-z0-9_-]{2,3000}\.[A-Za-z0-9_-]{43}$/;
const TIMESTAMPTZ_OID = 1184;
// basalt.charge() returns a sealed note like <uid>|<exp>|<hmac>, or this.
const OVER_LIMIT = 'over_limit';
const NOTE = /^[0-9a-f-]{36}\|[0-9]{1,12}\|[0-9a-f]{64}$/;
// Timestamps as Postgres prints them, like 2026-10-24 08:55:20.123456+00.
const CURSOR_TIME = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)$/;

// Keep full microsecond timestamps as text so list cursors stay exact.
const types = {
  getTypeParser(oid: number, format?: 'text' | 'binary') {
    if (oid === TIMESTAMPTZ_OID) return (v: string) => v;
    return pg.types.getTypeParser(oid, format);
  },
};

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

// Map database errors to plain messages without leaking anything from them.
function translate(err: unknown): BasaltError {
  if (err instanceof BasaltError) return err;
  const code = (err as { code?: string })?.code ?? '';
  if (code === '42501') return new BasaltError('denied', "You don't have access to do that.");
  if (code === '23502' && (err as { column?: string }).column === 'owner_id') {
    return new BasaltError('denied', 'You need to be logged in to do that.');
  }
  if (code === '23514' || code === '23502' || code.startsWith('22')) {
    return new BasaltError('invalid_input', "That value isn't allowed.");
  }
  if (code === '57014' || code === '25P04' || code === '55P03') {
    return new BasaltError('unavailable', 'That took too long and was stopped. Try again.');
  }
  return new BasaltError('unavailable', 'The database is unavailable right now. Try again.');
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
      types,
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
    const rowId = checkId(id);
    return this.#asUser(token, 1, 0, async (client) => {
      const res = await client.query(`select ${this.#columns(spec)} from app.${quoteIdent(spec.name)} where "id" = $1`, [rowId]);
      // Someone else's row and a missing row look exactly the same.
      if (res.rowCount === 0) throw new BasaltError('not_found', `No ${spec.name} with that id.`);
      return res.rows[0];
    });
  }

  async list(token: string, table: string, options: ListOptions = {}): Promise<{ rows: Row[]; next: string | null }> {
    const spec = getTable(this.#contract, table);
    const limit = options.limit ?? DEFAULT_PAGE;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) {
      throw new BasaltError('invalid_input', `limit must be a whole number from 1 to ${MAX_PAGE}.`);
    }
    const after = options.after === undefined || options.after === null ? null : decodeCursor(options.after);

    return this.#asUser(token, limit, 0, async (client) => {
      const params: unknown[] = [limit + 1];
      let where = '';
      if (after) {
        params.push(after[0], after[1]);
        where = `where ("created_at", "id") < ($2::timestamptz, $3::uuid)`;
      }
      const res = await client.query(
        `select ${this.#columns(spec)} from app.${quoteIdent(spec.name)} ${where} order by "created_at" desc, "id" desc limit $1`,
        params,
      );
      const rows = res.rows.slice(0, limit);
      return { rows, next: res.rows.length > limit ? encodeCursor(rows[rows.length - 1]) : null };
    });
  }

  async create(token: string, table: string, input: unknown): Promise<Row> {
    const spec = getTable(this.#contract, table);
    const { columns, values } = checkWrite(spec, input, 'create');
    return this.#asUser(token, 0, 1, async (client) => {
      const cols = columns.map(quoteIdent).join(', ');
      const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
      const sql = columns.length
        ? `insert into app.${quoteIdent(spec.name)} (${cols}) values (${placeholders}) returning ${this.#columns(spec)}`
        : `insert into app.${quoteIdent(spec.name)} default values returning ${this.#columns(spec)}`;
      const res = await client.query(sql, values);
      return res.rows[0];
    });
  }

  async update(token: string, table: string, id: string, input: unknown): Promise<Row> {
    const spec = getTable(this.#contract, table);
    const rowId = checkId(id);
    const { columns, values } = checkWrite(spec, input, 'update');
    return this.#asUser(token, 0, 1, async (client) => {
      const sets = columns.map((c, i) => `${quoteIdent(c)} = $${i + 2}`).join(', ');
      const res = await client.query(
        `update app.${quoteIdent(spec.name)} set ${sets} where "id" = $1 returning ${this.#columns(spec)}`,
        [rowId, ...values],
      );
      if (res.rowCount === 0) throw new BasaltError('not_found', `No ${spec.name} with that id.`);
      return res.rows[0];
    });
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }

  #columns(spec: TableSpec): string {
    return [...SYSTEM_COLUMNS, ...spec.fields.keys()].map(quoteIdent).join(', ');
  }

  // Charges the user's damage limits, then runs fn inside one transaction as
  // the token's user.
  async #asUser<T>(token: string, readCost: number, writeCost: number, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    if (typeof token !== 'string' || !TOKEN.test(token)) {
      throw new BasaltError('denied', 'Your login is missing, expired or not valid. Log in again.');
    }

    // Step 1, its own statement: verify the login and charge the limits. It
    // commits on its own, so a request that later fails still pays, and the
    // counter row isn't locked while the request runs.
    let note: string | null | undefined;
    try {
      const charged = await this.#pool.query<{ note: string | null }>('select basalt.charge($1, $2, $3) as note', [token, readCost, writeCost]);
      note = charged.rows[0]?.note;
    } catch (err) {
      throw translate(err);
    }
    if (note === OVER_LIMIT) throw new BasaltError('rate_limited', 'Too much activity in the last minute. Slow down.');
    if (!note || !NOTE.test(note)) throw new BasaltError('denied', 'Your login is missing, expired or not valid. Log in again.');

    let client: pg.PoolClient;
    try {
      client = await this.#pool.connect();
    } catch (err) {
      throw translate(err);
    }

    let broken: Error | undefined;
    try {
      // Step 2: start the transaction and set the token plus the sealed note in
      // one round trip, so the database doesn't redo the full check. Inlining is
      // safe only because TOKEN and NOTE above allow no quotes or backslashes.
      // Both settings are local to this transaction, so they can't leak into the
      // next request on this connection (also safe with PgBouncer transaction pooling).
      await client.query(`begin; select set_config('basalt.jwt', '${token}', true), set_config('basalt.verified', '${note}', true)`);
      const result = await fn(client);
      await client.query('commit');
      return result;
    } catch (err) {
      try {
        await client.query('rollback');
      } catch (rollbackErr) {
        // Don't hand a connection in an unknown state to the next request.
        broken = rollbackErr as Error;
      }
      throw translate(err);
    } finally {
      client.release(broken);
    }
  }
}
