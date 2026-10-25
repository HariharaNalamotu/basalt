// The Data service. App code talks to this over HTTP and never gets a database
// login, so whatever the AI writes in the app can only use these calls.
//
//   POST /v1/data/get     { table, id }
//   POST /v1/data/list    { table, limit?, after?, archived?, where?, sort? }
//   POST /v1/data/create  { table, input, key? }
//   POST /v1/data/update  { table, id, input }
//   POST /v1/data/archive { table, id }
//   POST /v1/data/restore { table, id }
//   POST /v1/files        raw file body, content-type and x-file-name headers
//   POST /v1/files/link   { id } -> a download path good for 5 minutes
//   GET  /v1/files/download/<ticket>
//   GET  /healthz         (never touches the database)
//
// Every request needs the user's login token, either
//   Authorization: Bearer <data token>        (servers, native apps, other tools), or
//   the Basalt Auth session cookie            (browsers on the app's own origin: the token
//                                              never has to be readable by page scripts).
//
//   node --env-file=.env src/server.ts contract.json

import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { parseContract } from './contract.ts';
import { BasaltData, encodeCursor, type ListOptions, type Row } from './data.ts';
import { BasaltError, type BasaltErrorCode } from './errors.ts';

export interface DataServerOptions {
  data: BasaltData;
  maxBodyBytes?: number;
  maxInFlight?: number;
  // List pages are trimmed to fit, and the next cursor picks up where they stop.
  maxListBytes?: number;
  bodyTimeoutMs?: number;
  maxFileBytes?: number;
}

const STATUS: Record<BasaltErrorCode, number> = {
  invalid_input: 400,
  denied: 401,
  not_found: 404,
  rate_limited: 429,
  conflict: 409,
  unavailable: 503,
  contract: 500,
};

const OPS = new Set(['get', 'list', 'create', 'update', 'archive', 'restore']);

// Bearer logins travel in the Authorization header, so any site may call with
// one: a page can only act as a user whose token it already holds. Cookie logins
// are separately limited to the app's own origin (see fromSessionCookie), and
// "*" never allows credentials, so other sites can't use a visitor's cookie.
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, GET, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, x-file-name',
  'access-control-max-age': '600',
};
const TOKEN = /^[A-Za-z0-9_-]{2,1024}\.[A-Za-z0-9_-]{2,3000}\.[A-Za-z0-9_-]{43}$/;

function send(res: ServerResponse, status: number, body: unknown, json = JSON.stringify(body)): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...CORS,
  });
  res.end(json);
}

function fail(res: ServerResponse, err: BasaltError): void {
  send(res, STATUS[err.code], { ok: false, error: { code: err.code, message: err.message } });
}

async function readJson(req: IncomingMessage, maxBytes: number, timeoutMs: number): Promise<Record<string, unknown>> {
  if (!/^application\/json(;|$)/i.test(req.headers['content-type'] ?? '')) {
    throw new BasaltError('invalid_input', 'Send JSON with content-type application/json.');
  }
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > maxBytes) throw new BasaltError('invalid_input', `Request body is over ${maxBytes} bytes.`);

  const chunks: Buffer[] = [];
  let size = 0;
  // A client that sends its body slowly gets cut off instead of holding a slot.
  const timer = setTimeout(() => req.destroy(), timeoutMs);
  try {
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > maxBytes) throw new BasaltError('invalid_input', `Request body is over ${maxBytes} bytes.`);
      chunks.push(chunk as Buffer);
    }
  } catch (err) {
    if (err instanceof BasaltError) throw err;
    throw new BasaltError('invalid_input', 'The request body took too long or was cut off.');
  } finally {
    clearTimeout(timer);
  }
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new BasaltError('invalid_input', 'Request body is not valid JSON.');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BasaltError('invalid_input', 'Request body must be a JSON object.');
  }
  return body as Record<string, unknown>;
}

async function readRaw(req: IncomingMessage, maxBytes: number, timeoutMs: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > maxBytes) throw new BasaltError('invalid_input', `Files can be up to ${Math.floor(maxBytes / 1048576)} MB.`);
  const chunks: Buffer[] = [];
  let size = 0;
  const timer = setTimeout(() => req.destroy(), timeoutMs * 6);
  try {
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > maxBytes) throw new BasaltError('invalid_input', `Files can be up to ${Math.floor(maxBytes / 1048576)} MB.`);
      chunks.push(chunk as Buffer);
    }
  } catch (err) {
    if (err instanceof BasaltError) throw err;
    throw new BasaltError('invalid_input', 'The upload took too long or was cut off.');
  } finally {
    clearTimeout(timer);
  }
  return Buffer.concat(chunks);
}

const DENIED = 'Your login is missing, expired or not valid. Log in again.';
// Basalt Auth's HttpOnly access cookie (secure and plain-http development names).
const SESSION_COOKIES = ['__Host-basalt_at', 'basalt_at'];

function bearer(req: IncomingMessage): string {
  const header = req.headers.authorization;
  if (header === undefined) return fromSessionCookie(req);
  const match = /^Bearer (\S{1,4096})$/.exec(header);
  // Check the token's shape before reading any body. The database checks the signature.
  if (!match || !TOKEN.test(match[1])) throw new BasaltError('denied', DENIED);
  return match[1];
}

/**
 * Browsers on the app's own origin send Basalt Auth's HttpOnly session cookie instead of a token.
 * The data token rides inside it (claim "bdg"); it's taken out as is and the database verifies it,
 * so this service still never needs a secret. Cookies are sent automatically by browsers, so they
 * are only honored for same-origin requests (blocks cross-site request forgery).
 */
function fromSessionCookie(req: IncomingMessage): string {
  const raw = req.headers.cookie;
  if (!raw) throw new BasaltError('denied', DENIED);
  const origin = req.headers.origin;
  const host = (req.headers['x-forwarded-host'] as string | undefined)?.split(',')[0]?.trim() ?? req.headers.host;
  let sameOrigin = false;
  try {
    // Compared without the port: cookies don't separate sites by port, and the edge forwards the
    // site's name without one (a local demo serves on :8080).
    sameOrigin = typeof origin === 'string' && Boolean(host) && new URL(origin).hostname === host!.replace(/:\d+$/, '');
  } catch {
    sameOrigin = false;
  }
  if (!sameOrigin) throw new BasaltError('denied', 'Cookie logins only work from the app\'s own site.');
  const found: Record<string, string[]> = {};
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    const name = part.slice(0, i).trim();
    if (i > 0 && SESSION_COOKIES.includes(name)) (found[name] ??= []).push(part.slice(i + 1).trim());
  }
  // __Host-basalt_at can only be set by this exact site, so it always wins. The plain name is only
  // used by plain-http setups; on https it can only have been planted by another site under the
  // same parent domain. Two of the same name means one was planted: refuse rather than guess.
  const secure = found['__Host-basalt_at'];
  const plain = found['basalt_at'];
  const pick = secure ?? (origin!.startsWith('http://') ? plain : undefined);
  if (pick && pick.length > 1) throw new BasaltError('denied', DENIED);
  const cookie = pick?.[0];
  const segments = cookie?.split('.');
  if (!segments || segments.length !== 3 || segments[1].length > 8000) throw new BasaltError('denied', DENIED);
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
  } catch {
    throw new BasaltError('denied', DENIED);
  }
  const token = (claims as { bdg?: unknown } | null)?.bdg;
  if (typeof token !== 'string' || !TOKEN.test(token)) throw new BasaltError('denied', DENIED);
  return token;
}

// Drops rows from the end of a page until it fits, and points next at the
// last row kept so the caller just keeps paging.
function fitPage(page: { rows: Row[]; next: string | null }, maxBytes: number, sortField = 'created_at'): { rows: Row[]; next: string | null } {
  const rows = [...page.rows];
  let size = Buffer.byteLength(JSON.stringify(rows));
  while (rows.length > 1 && size > maxBytes) {
    size -= Buffer.byteLength(JSON.stringify(rows.pop())) + 1;
  }
  return { rows, next: encodeCursor(rows[rows.length - 1], sortField) };
}

export type DataHandler = (req: IncomingMessage, res: ServerResponse, path: string) => Promise<void>;

// Handles one request whose path is already stripped down to /v1/data/<op>.
// Basalt Cloud mounts one of these per app.
export function createDataHandler(options: DataServerOptions): DataHandler {
  const { data } = options;
  const maxBodyBytes = options.maxBodyBytes ?? 64 * 1024;
  const maxInFlight = options.maxInFlight ?? 256;
  const maxListBytes = options.maxListBytes ?? 1024 * 1024;
  const bodyTimeoutMs = options.bodyTimeoutMs ?? 5000;
  // A little over the database's own 5 MB default, so the database gives the clear message.
  const maxFileBytes = options.maxFileBytes ?? 6 * 1024 * 1024;
  let inFlight = 0;

  return async (req, res, path) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS);
      return void res.end();
    }
    if (req.method === 'GET' && path === '/healthz') return send(res, 200, { ok: true });

    // Downloads: the ticket in the link is the proof, so no login header is
    // needed, which lets an <img> tag show it.
    const dl = /^\/v1\/files\/download\/([0-9a-f]{64})$/.exec(path);
    if (req.method === 'GET' && (dl || path.startsWith('/v1/files/download/'))) {
      const file = dl ? await data.fetchFile(dl[1]).catch(() => null) : null;
      if (!file) return send(res, 404, { ok: false, error: { code: 'not_found', message: 'That link is wrong or has expired.' } });
      const inline = file.content_type.startsWith('image/') || file.content_type === 'application/pdf';
      res.writeHead(200, {
        'content-type': file.content_type,
        'content-length': file.data.length,
        'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${file.name.replace(/[^A-Za-z0-9 ._-]/g, '_')}"`,
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
        'cache-control': 'private, no-store',
        ...CORS,
      });
      return void res.end(file.data);
    }

    if (req.method === 'POST' && path === '/v1/files') {
      if (inFlight >= maxInFlight) {
        res.setHeader('retry-after', '1');
        return fail(res, new BasaltError('unavailable', 'The service is busy. Try again in a moment.'));
      }
      inFlight++;
      res.once('close', () => inFlight--);
      try {
        const token = bearer(req);
        const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
        let name = 'file';
        try {
          name = decodeURIComponent(String(req.headers['x-file-name'] ?? 'file')).slice(0, 300);
        } catch {}
        const body = await readRaw(req, maxFileBytes, bodyTimeoutMs);
        return send(res, 200, { ok: true, data: await data.uploadFile(token, name, type, body) });
      } catch (err) {
        if (res.destroyed) return;
        return fail(res, err instanceof BasaltError ? err : new BasaltError('unavailable', 'Something went wrong. Try again.'));
      }
    }

    if (req.method === 'POST' && path === '/v1/files/link') {
      try {
        const token = bearer(req);
        const body = await readJson(req, maxBodyBytes, bodyTimeoutMs);
        const link = await data.fileLink(token, body.id as string);
        return send(res, 200, { ok: true, data: { path: `/v1/files/download/${link.ticket}`, expires_in: link.expires_in } });
      } catch (err) {
        if (res.destroyed) return;
        return fail(res, err instanceof BasaltError ? err : new BasaltError('unavailable', 'Something went wrong. Try again.'));
      }
    }

    const match = /^\/v1\/data\/([a-z]+)$/.exec(path);
    if (req.method !== 'POST' || !match || !OPS.has(match[1])) {
      return send(res, 404, { ok: false, error: { code: 'not_found', message: 'Unknown route.' } });
    }

    // Shed load instead of queueing forever.
    if (inFlight >= maxInFlight) {
      res.setHeader('retry-after', '1');
      return fail(res, new BasaltError('unavailable', 'The service is busy. Try again in a moment.'));
    }
    // The slot is held until the response is fully sent or the client goes
    // away, so slow readers can't pile up buffered responses.
    inFlight++;
    res.once('close', () => inFlight--);
    try {
      const token = bearer(req);
      const body = await readJson(req, maxBodyBytes, bodyTimeoutMs);
      const table = body.table as string;
      let result: unknown;
      switch (match[1]) {
        case 'get':
          result = await data.get(token, table, body.id as string);
          break;
        case 'list':
          result = await data.list(token, table, {
            limit: body.limit as number | undefined,
            after: body.after as string | undefined,
            archived: body.archived as boolean | undefined,
            where: body.where as ListOptions['where'],
            sort: body.sort as ListOptions['sort'],
          });
          break;
        case 'create':
          result = await data.create(token, table, body.input, body.key === undefined ? {} : { key: body.key as string });
          break;
        case 'update':
          result = await data.update(token, table, body.id as string, body.input);
          break;
        case 'archive':
          result = await data.archive(token, table, body.id as string);
          break;
        case 'restore':
          result = await data.restore(token, table, body.id as string);
          break;
      }
      let json = JSON.stringify({ ok: true, data: result });
      // Serialize once; only trim a list page in the rare case it's too big.
      if (match[1] === 'list' && Buffer.byteLength(json) > maxListBytes) {
        json = JSON.stringify({ ok: true, data: fitPage(result as { rows: Row[]; next: string | null }, maxListBytes, (body.sort as { field?: string } | undefined)?.field) });
      }
      send(res, 200, null, json);
    } catch (err) {
      if (res.destroyed) return;
      fail(res, err instanceof BasaltError ? err : new BasaltError('unavailable', 'Something went wrong. Try again.'));
    }
  };
}

export function setServerLimits(server: Server): Server {
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 50;
  return server;
}

export function createDataServer(options: DataServerOptions): Server {
  const handle = createDataHandler(options);
  return setServerLimits(createServer((req, res) => handle(req, res, (req.url ?? '').split('?')[0])));
}

if (import.meta.main) {
  const contractFile = process.argv[2];
  const connectionString = process.env.BASALT_DATA_URL;
  if (!contractFile || !connectionString) {
    console.error('Usage: BASALT_DATA_URL=... node src/server.ts contract.json');
    process.exit(1);
  }
  const contract = parseContract(JSON.parse(readFileSync(contractFile, 'utf8')));
  const data = new BasaltData({ connectionString, contract, poolSize: Number(process.env.BASALT_POOL_SIZE ?? 10) });
  const host = process.env.HOST ?? '127.0.0.1';
  const port = Number(process.env.PORT ?? 8787);
  createDataServer({ data }).listen(port, host, () => console.log(`basalt: data service on http://${host}:${port}`));
}
