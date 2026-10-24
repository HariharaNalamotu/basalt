import { ApiError } from './errors.js';

/**
 * Client for the Basalt Data block, used as the signed-in user. Every call carries the user's
 * data token (issued by Basalt Auth); Postgres verifies it inside basalt.api() and only ever
 * returns or changes rows that user owns or is shared, so a bug in route code can't widen access.
 */
export type Row = Record<string, unknown>;

export interface DataClient {
  get<T = Row>(table: string, id: string): Promise<T>;
  /** Newest first. Pass { after: page.next } for the next page. */
  list<T = Row>(table: string, opts?: { limit?: number; after?: string; archived?: boolean }): Promise<{ rows: T[]; next: string | null }>;
  /** Pass { key } (e.g. an order id) so a retry never creates a second row. */
  create<T = Row>(table: string, input: Record<string, unknown>, opts?: { key?: string }): Promise<T>;
  update<T = Row>(table: string, id: string, input: Record<string, unknown>): Promise<T>;
  archive<T = Row>(table: string, id: string): Promise<T>;
  restore<T = Row>(table: string, id: string): Promise<T>;
}

const STATUS: Record<string, (message: string) => ApiError> = {
  denied: (m) => new ApiError('unauthenticated', m),
  not_found: (m) => new ApiError('not_found', m),
  invalid_input: (m) => new ApiError('validation_failed', m),
  rate_limited: (m) => new ApiError('rate_limited', m, { retryAfterSeconds: 10 }),
  unavailable: (m) => new ApiError('service_unavailable', m, { retryAfterSeconds: 2 }),
};

export function createDataClient(baseUrl: string, token: () => string, signal?: AbortSignal): DataClient {
  const base = baseUrl.replace(/\/+$/, '');
  async function call<T>(op: string, body: Record<string, unknown>): Promise<T> {
    // Resolved first so "not signed in" surfaces as 401, not as a network failure.
    const bearer = token();
    let res: Response;
    try {
      res = await fetch(`${base}/v1/data/${op}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
      });
    } catch {
      throw new ApiError('service_unavailable', 'The data service is unavailable. Please retry.', { retryAfterSeconds: 2 });
    }
    const json = (await res.json().catch(() => null)) as { ok: boolean; data?: T; error?: { code?: string; message?: string } } | null;
    if (json?.ok) return json.data as T;
    const code = json?.error?.code ?? 'unavailable';
    throw (STATUS[code] ?? STATUS.unavailable!)(json?.error?.message ?? 'The data service failed.');
  }
  return {
    get: (table, id) => call('get', { table, id }),
    list: (table, opts = {}) => call('list', { table, ...opts }),
    create: (table, input, opts = {}) => call('create', { table, input, ...opts }),
    update: (table, id, input) => call('update', { table, id, input }),
    archive: (table, id) => call('archive', { table, id }),
    restore: (table, id) => call('restore', { table, id }),
  };
}
