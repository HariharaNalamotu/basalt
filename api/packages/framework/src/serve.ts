import { serve as nodeServe } from '@hono/node-server';
import type { Server } from 'node:http';
import type { Api } from './api.js';

/**
 * Runs the API on Node with production-safe server settings and graceful shutdown:
 * - keep-alive longer than the edge's idle timeout (avoids 502s from races on reused sockets)
 * - bounded header/request timeouts (slowloris protection)
 * - SIGTERM: stop accepting, finish in-flight requests, close pools, exit
 */
export function serve(api: Api, opts: { port?: number; hostname?: string; onListen?: (port: number) => void } = {}) {
  const port = opts.port ?? Number(process.env.PORT ?? 3000);
  const server = nodeServe(
    { fetch: api.fetch, port, hostname: opts.hostname ?? '0.0.0.0', serverOptions: { maxHeaderSize: 16 * 1024 } },
    (info) => (opts.onListen ?? ((p) => process.stdout.write(`${JSON.stringify({ level: 'info', msg: 'listening', port: p })}\n`)))(info.port),
  ) as Server;
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.requestTimeout = 60_000;

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    process.stdout.write(`${JSON.stringify({ level: 'info', msg: 'shutting_down', signal })}\n`);
    server.close(async () => {
      await api.close().catch(() => {});
      process.exit(0);
    });
    server.closeIdleConnections?.();
    setTimeout(() => process.exit(1), 25_000).unref();
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
  return server;
}
