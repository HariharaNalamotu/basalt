#!/usr/bin/env node
/**
 * basalt-dev-edge: run the local edge for an app provisioned with the api_setup MCP tool.
 *   node --env-file=.basalt/<app>.env basalt-dev-edge [--port 8080] [--backend http://localhost:3000] [--frontend http://localhost:5173]
 */
import { serveDevEdge } from './dev-edge.js';

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const need = (name: string) => {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing ${name}. Run with --env-file=.basalt/<app>.env (written by the api_setup tool).`);
    process.exit(1);
  }
  return v;
};

const port = Number(arg('port', process.env.BASALT_DEV_EDGE_PORT ?? '8080'));
serveDevEdge({
  port,
  edgeSecret: need('BASALT_EDGE_SECRET'),
  authUrl: need('BASALT_AUTH_URL'),
  projectId: need('BASALT_PROJECT_ID'),
  backendUrl: arg('backend', `http://127.0.0.1:${process.env.PORT ?? 3000}`)!,
  frontendUrl: arg('frontend', process.env.BASALT_DEV_FRONTEND_URL),
});
console.log(`Basalt dev edge on http://localhost:${port}  (open your app here, not on the backend/frontend ports)`);
