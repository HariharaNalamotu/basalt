// What app code imports. It holds a URL and the user's login token, never a
// database login, so the only things it can do are these four calls.
//
//   const basalt = createBasalt({ url: 'http://127.0.0.1:8787', token: () => session.token });
//   const booking = await basalt.data.get('bookings', id);

import { BasaltError, type BasaltErrorCode } from './errors.ts';
import type { ListOptions, Row } from './data.ts';

export interface BasaltClientOptions {
  url: string;
  token: string | (() => string | Promise<string>);
  timeoutMs?: number;
}

export function createBasalt(options: BasaltClientOptions) {
  const base = options.url.replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? 10_000;

  async function call<T>(op: string, body: Record<string, unknown>): Promise<T> {
    const token = typeof options.token === 'function' ? await options.token() : options.token;
    let res: Response;
    try {
      res = await fetch(`${base}/v1/data/${op}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new BasaltError('unavailable', "Couldn't reach Basalt. Try again.");
    }
    const json = (await res.json().catch(() => null)) as
      | { ok: true; data: T }
      | { ok: false; error: { code: BasaltErrorCode; message: string } }
      | null;
    if (!json) throw new BasaltError('unavailable', 'Basalt sent back something unexpected.');
    if (!json.ok) throw new BasaltError(json.error.code, json.error.message);
    return json.data;
  }

  return {
    data: {
      get: (table: string, id: string) => call<Row>('get', { table, id }),
      list: (table: string, opts: ListOptions = {}) => call<{ rows: Row[]; next: string | null }>('list', { table, ...opts }),
      create: (table: string, input: Record<string, unknown>) => call<Row>('create', { table, input }),
      update: (table: string, id: string, input: Record<string, unknown>) => call<Row>('update', { table, id, input }),
    },
  };
}
