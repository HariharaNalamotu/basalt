import pg from 'pg';
import { getTable, SYSTEM_COLUMNS, type Contract, type TableSpec } from './contract.ts';
import { BasaltError } from './errors.ts';
import { quoteIdent } from './schema.ts';
import { checkId, checkWrite } from './validate.ts';

// The Data block. This is the only way an app touches its database:
// get, list, create and update. There is no raw SQL method and no delete.
//
// Every call runs as the login token's user. The token is handed to Postgres,
// which checks the signature itself (basalt.uid()), so this code never needs
// the signing secret and can't pretend to be anyone.

export interface BasaltDataOptions {
  connectionString: string;
  contract: Contract;
  poolSize?: number;
  // Damage limits, per user per minute.
  maxRowsReadPerMinute?: number;
  maxWritesPerMinute?: number;
}

export interface ListOptions {
  limit?: number;
  after?: string;
}

export type Row = Record<string, unknown>;

const MAX_PAGE = 100;
const DEFAULT_PAGE = 20;
const MAX_TOKEN_LENGTH = 4096;
const TIMESTAMPTZ_OID = 1184;

// Keep full microsecond timestamps as text so list cursors stay exact.
const types = {
  getTypeParser(oid: number, format?: 'text' | 'binary') {
    if (oid === TIMESTAMPTZ_OID) return (v: string) => v;
    return pg.types.getTypeParser(oid, format);
  },
};

class MinuteCounter {
  #limit: number;
  #counts = new Map<string, { windowStart: number; used: number }>();

  constructor(limit: number) {
    this.#limit = limit;
  }

  take(key: string, amount: number): boolean {
    const now = Date.now();
    let entry = this.#counts.get(key);
    if (!entry || now - entry.windowStart >= 60_000) {
      entry = { windowStart: now, used: 0 };
      this.#counts.set(key, entry);
    }
    if (entry.used + amount > this.#limit) return false;
    entry.used += amount;
    if (this.#counts.size > 100_000) this.#sweep(now);
    return true;
  }

  #sweep(now: number): void {
    for (const [k, v] of this.#counts) if (now - v.windowStart >= 60_000) this.#counts.delete(k);
  }
}

function encodeCursor(row: Row): string {
  return Buffer.from(JSON.stringify([row.created_at, row.id])).toString('base64url');
}

function decodeCursor(cursor: unknown): [string, string] {
  try {
    if (typeof cursor !== 'string' || cursor.length > 200) throw new Error();
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== 'string') throw new Error();
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
  if (code === '57014') return new BasaltError('unavailable', 'That took too long and was stopped.');
  return new BasaltError('unavailable', 'The database is unavailable right now. Try again.');
}

export class BasaltData {
  #pool: pg.Pool;
  #contract: Contract;
  #reads: MinuteCounter;
  #writes: MinuteCounter;

  constructor(options: BasaltDataOptions) {
    this.#contract = options.contract;
    this.#pool = new pg.Pool({
      connectionString: options.connectionString,
      max: options.poolSize ?? 10,
      types,
      application_name: 'basalt-data',
    });
    // A dropped connection shouldn't crash the app.
    this.#pool.on('error', () => {});
    this.#reads = new MinuteCounter(options.maxRowsReadPerMinute ?? 600);
    this.#writes = new MinuteCounter(options.maxWritesPerMinute ?? 60);
  }

  async get(token: string, table: string, id: string): Promise<Row> {
    const spec = getTable(this.#contract, table);
    const rowId = checkId(id);
    return this.#asUser(token, async (client, uid) => {
      this.#spendReads(uid, 1);
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
    const after = options.after === undefined ? null : decodeCursor(options.after);

    return this.#asUser(token, async (client, uid) => {
      this.#spendReads(uid, limit);
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
    return this.#asUser(token, async (client, uid) => {
      this.#spendWrite(uid);
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
    return this.#asUser(token, async (client, uid) => {
      this.#spendWrite(uid);
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

  #spendReads(uid: string, rows: number): void {
    if (!this.#reads.take(uid, rows)) throw new BasaltError('rate_limited', 'Too many reads in the last minute. Slow down.');
  }

  #spendWrite(uid: string): void {
    if (!this.#writes.take(uid, 1)) throw new BasaltError('rate_limited', 'Too many changes in the last minute. Slow down.');
  }

  // Runs fn inside one transaction as the token's user.
  async #asUser<T>(token: string, fn: (client: pg.PoolClient, uid: string) => Promise<T>): Promise<T> {
    if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
      throw new BasaltError('denied', 'You need to be logged in to do that.');
    }

    let client: pg.PoolClient;
    try {
      client = await this.#pool.connect();
    } catch (err) {
      throw translate(err);
    }

    try {
      await client.query('begin');
      // is_local = true: the token disappears when this transaction ends,
      // so it can't leak into the next request on the same connection.
      await client.query(`select set_config('basalt.jwt', $1, true)`, [token]);
      const who = await client.query<{ uid: string | null }>('select basalt.uid() as uid');
      const uid = who.rows[0]?.uid;
      if (!uid) throw new BasaltError('denied', 'Your login is missing, expired or not valid. Log in again.');

      const result = await fn(client, uid);
      await client.query('commit');
      return result;
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw translate(err);
    } finally {
      client.release();
    }
  }
}
