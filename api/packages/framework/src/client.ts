/**
 * Browser client for your Basalt API.
 *
 *   import { createApiClient } from '@basalt/api/client';
 *   import { auth } from './auth';                    // createAuthClient()
 *   export const api = createApiClient({ auth });
 *
 *   const todos = await api.get<Todo[]>('/todos', { query: { limit: 20 } });
 *   const todo = await api.post<Todo>('/todos', { title });   // retried safely with an Idempotency-Key
 *
 * Errors throw ApiRequestError with `status`, `code`, `message` (safe to show) and `details`.
 */
export interface ApiClientOptions {
  /** Default '/api'. */
  baseUrl?: string;
  /** Pass your auth client so expired sessions refresh transparently. */
  auth?: { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
  fetch?: typeof fetch;
}

export class ApiRequestError extends Error {
  override readonly name = 'ApiRequestError';
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
    readonly details?: unknown,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

type Query = Record<string, string | number | boolean | undefined | null | Array<string | number>>;

export interface ApiClient {
  get<T>(path: string, opts?: { query?: Query; signal?: AbortSignal }): Promise<T>;
  post<T>(path: string, body?: unknown, opts?: { idempotencyKey?: string; signal?: AbortSignal }): Promise<T>;
  put<T>(path: string, body?: unknown, opts?: { signal?: AbortSignal }): Promise<T>;
  patch<T>(path: string, body?: unknown, opts?: { idempotencyKey?: string; signal?: AbortSignal }): Promise<T>;
  delete<T = void>(path: string, opts?: { signal?: AbortSignal }): Promise<T>;
}

const RETRYABLE = new Set([502, 503, 504]);

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const base = (options.baseUrl ?? '/api').replace(/\/+$/, '');
  const send = options.auth
    ? (i: RequestInfo | URL, init?: RequestInit) => options.auth!.fetch(i, init)
    : options.fetch ?? ((i: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(i, init));

  async function request<T>(method: string, path: string, body: unknown, opts: { query?: Query; idempotencyKey?: string; signal?: AbortSignal } = {}): Promise<T> {
    if (!path.startsWith('/') || path.startsWith('//')) throw new Error('API paths must start with a single "/".');
    let url = base + path;
    if (opts.query) {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(opts.query)) {
        if (v === undefined || v === null) continue;
        if (Array.isArray(v)) v.forEach((x) => q.append(k, String(x)));
        else q.set(k, String(v));
      }
      const s = q.toString();
      if (s) url += `?${s}`;
    }
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    // Writes carry an Idempotency-Key so a retry after a dropped connection can't apply twice.
    const idempotent = method === 'GET' || method === 'PUT' || method === 'DELETE';
    if (method === 'POST' || method === 'PATCH') headers['idempotency-key'] = opts.idempotencyKey ?? globalThis.crypto.randomUUID();
    const canRetry = idempotent || 'idempotency-key' in headers;

    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await send(url, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          credentials: 'same-origin',
          signal: opts.signal,
        });
      } catch (err) {
        if (canRetry && attempt < 2 && !(opts.signal?.aborted)) {
          await sleep(300 * 2 ** attempt);
          continue;
        }
        throw new ApiRequestError(0, 'network_error', 'Could not reach the server. Check your connection.');
      }
      if (res.ok) {
        if (res.status === 204) return undefined as T;
        return (await res.json()) as T;
      }
      const retryAfter = Number(res.headers.get('retry-after'));
      if (canRetry && RETRYABLE.has(res.status) && attempt < 2) {
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 10) * 1000 : 300 * 2 ** attempt);
        continue;
      }
      let err: { code?: string; message?: string; requestId?: string; details?: unknown } = {};
      try {
        err = ((await res.json()) as { error?: typeof err }).error ?? {};
      } catch {
        /* non-JSON */
      }
      throw new ApiRequestError(
        res.status,
        err.code ?? 'http_error',
        err.message ?? `Request failed (${res.status}).`,
        err.requestId ?? res.headers.get('x-request-id') ?? undefined,
        err.details,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
      );
    }
  }

  return {
    get: (path, opts) => request('GET', path, undefined, opts),
    post: (path, body = {}, opts) => request('POST', path, body, opts),
    put: (path, body = {}, opts) => request('PUT', path, body, opts),
    patch: (path, body = {}, opts) => request('PATCH', path, body, opts),
    delete: (path, opts) => request('DELETE', path, undefined, opts),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
