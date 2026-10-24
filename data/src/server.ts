// The Data service. App code talks to this over HTTP and never gets a database
// login, so whatever the AI writes in the app can only use these four calls.
//
//   POST /v1/data/get     { table, id }
//   POST /v1/data/list    { table, limit?, after? }
//   POST /v1/data/create  { table, input, key? }
//   POST /v1/data/update  { table, id, input }
//   GET  /healthz         (never touches the database)
//
// Every request needs  Authorization: Bearer <user login token>.
//
//   node --env-file=.env src/server.ts contract.json

import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { parseContract } from './contract.ts';
import { BasaltData, encodeCursor, type Row } from './data.ts';
import { BasaltError, type BasaltErrorCode } from './errors.ts';

export interface DataServerOptions {
  data: BasaltData;
  maxBodyBytes?: number;
  maxInFlight?: number;
  // List pages are trimmed to fit, and the next cursor picks up where they stop.
  maxListBytes?: number;
  bodyTimeoutMs?: number;
}

const STATUS: Record<BasaltErrorCode, number> = {
  invalid_input: 400,
  denied: 401,
  not_found: 404,
  rate_limited: 429,
  unavailable: 503,
  contract: 500,
};

const OPS = new Set(['get', 'list', 'create', 'update']);
const TOKEN = /^[A-Za-z0-9_-]{2,1024}\.[A-Za-z0-9_-]{2,3000}\.[A-Za-z0-9_-]{43}$/;

function send(res: ServerResponse, status: number, body: unknown, json = JSON.stringify(body)): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
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

function bearer(req: IncomingMessage): string {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer (\S{1,4096})$/.exec(header);
  // Check the token's shape before reading any body. The database checks the signature.
  if (!match || !TOKEN.test(match[1])) throw new BasaltError('denied', 'Your login is missing, expired or not valid. Log in again.');
  return match[1];
}

// Drops rows from the end of a page until it fits, and points next at the
// last row kept so the caller just keeps paging.
function fitPage(page: { rows: Row[]; next: string | null }, maxBytes: number): { rows: Row[]; next: string | null } {
  const rows = [...page.rows];
  let size = Buffer.byteLength(JSON.stringify(rows));
  while (rows.length > 1 && size > maxBytes) {
    size -= Buffer.byteLength(JSON.stringify(rows.pop())) + 1;
  }
  return { rows, next: encodeCursor(rows[rows.length - 1]) };
}

export function createDataServer(options: DataServerOptions): Server {
  const { data } = options;
  const maxBodyBytes = options.maxBodyBytes ?? 64 * 1024;
  const maxInFlight = options.maxInFlight ?? 256;
  const maxListBytes = options.maxListBytes ?? 1024 * 1024;
  const bodyTimeoutMs = options.bodyTimeoutMs ?? 5000;
  let inFlight = 0;

  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') return send(res, 200, { ok: true });

    const match = /^\/v1\/data\/([a-z]+)$/.exec(req.url ?? '');
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
          result = await data.list(token, table, { limit: body.limit as number | undefined, after: body.after as string | undefined });
          break;
        case 'create':
          result = await data.create(token, table, body.input, body.key === undefined ? {} : { key: body.key as string });
          break;
        case 'update':
          result = await data.update(token, table, body.id as string, body.input);
          break;
      }
      let json = JSON.stringify({ ok: true, data: result });
      // Serialize once; only trim a list page in the rare case it's too big.
      if (match[1] === 'list' && Buffer.byteLength(json) > maxListBytes) {
        json = JSON.stringify({ ok: true, data: fitPage(result as { rows: Row[]; next: string | null }, maxListBytes) });
      }
      send(res, 200, null, json);
    } catch (err) {
      if (res.destroyed) return;
      fail(res, err instanceof BasaltError ? err : new BasaltError('unavailable', 'Something went wrong. Try again.'));
    }
  });

  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 50;
  return server;
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
