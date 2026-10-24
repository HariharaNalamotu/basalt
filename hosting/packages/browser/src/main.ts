#!/usr/bin/env node
import http from 'node:http';
import { createLog, safeEqual } from '@basalt/host-shared';
import { BrowserWorker, type Action } from './worker.js';

const log = createLog('browser');
const token = process.env.INTERNAL_TOKEN;
const rootDomain = process.env.ROOT_DOMAIN;
if (!token || !rootDomain) throw new Error('INTERNAL_TOKEN and ROOT_DOMAIN are required');

const worker = new BrowserWorker({
  rootDomain,
  edgeHost: process.env.EDGE_HOST ?? 'edge',
  egressProxy: process.env.EGRESS_PROXY,
  log,
});

async function readJson(req: http.IncomingMessage): Promise<any> {
  let raw = '';
  for await (const c of req) {
    raw += c;
    if (raw.length > 64 * 1024) throw new Error('body too large');
  }
  return raw ? JSON.parse(raw) : {};
}

/** Internal API, reachable only by the control plane on the platform network. */
const server = http.createServer(async (req, res) => {
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (!safeEqual(req.headers.authorization ?? '', `Bearer ${token}`)) return send(401, { error: 'unauthorized' });
  const url = new URL(req.url ?? '/', 'http://browser');
  const owner = req.headers['x-basalt-owner'];
  if (typeof owner !== 'string' || !owner) return send(400, { error: 'owner required' });
  try {
    if (url.pathname === '/sessions' && req.method === 'POST') {
      const b = await readJson(req);
      return send(
        200,
        await worker.open({
          host: String(b.host),
          accessToken: b.accessToken,
          owner,
          path: b.path,
          viewport: b.viewport === 'phone' ? 'phone' : 'desktop',
          colorScheme: b.colorScheme === 'dark' ? 'dark' : 'light',
        }),
      );
    }
    if (url.pathname === '/sessions' && req.method === 'GET') return send(200, { sessions: worker.list(owner) });
    const m = /^\/sessions\/([0-9a-f-]{36})(\/act)?$/.exec(url.pathname);
    if (m && req.method === 'POST' && m[2]) return send(200, await worker.act(m[1]!, owner, (await readJson(req)) as Action));
    if (m && req.method === 'DELETE' && !m[2]) return send(200, { closed: await worker.close(m[1]!, owner) });
    return send(404, { error: 'not found' });
  } catch (err) {
    return send(422, { error: (err as Error).message.split('\n')[0]?.slice(0, 500) });
  }
});
server.listen(Number(process.env.PORT ?? 7070), '0.0.0.0', () => log.info('listening', { port: Number(process.env.PORT ?? 7070) }));
for (const s of ['SIGTERM', 'SIGINT']) process.once(s, () => void worker.shutdown().finally(() => process.exit(0)));
