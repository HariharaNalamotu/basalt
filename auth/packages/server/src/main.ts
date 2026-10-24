#!/usr/bin/env node
// Argon2 runs on libuv's threadpool; size it before anything touches the pool.
process.env.UV_THREADPOOL_SIZE ??= String(Math.max(8, (await import('node:os')).availableParallelism()));

const { serve } = await import('@hono/node-server');
const { bootstrap } = await import('./bootstrap.js');

const { app, config, shutdown, log } = await bootstrap();
const server = serve({ fetch: app.fetch, port: config.port }, (info) =>
  log.info('listening', { port: info.port, env: config.env }),
);

let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    log.info('shutting_down', { signal });
    server.close(async () => {
      await shutdown();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 15_000).unref();
  });
}
