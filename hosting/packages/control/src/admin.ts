#!/usr/bin/env node
/**
 * Operator CLI (run inside the control container):
 *   basalt-admin create-workspace <name>     → workspace token + MCP config for the user's agent
 *   basalt-admin under-attack on|off          → proof-of-work challenge on every app
 */
import { Redis } from 'ioredis';
import { createLog } from '@basalt/host-shared';
import { loadConfig } from './config.js';
import { authFactory } from './ctx.js';
import { SecretBox } from './crypto.js';
import { createDb, migrate } from './db.js';
import { Docker } from './docker.js';
import { Host } from './service.js';

const [cmd, arg] = process.argv.slice(2);
const cfg = loadConfig();
const db = createDb(cfg.DATABASE_URL);
await migrate(db);
const redis = new Redis(cfg.REDIS_ADMIN_URL, { lazyConnect: true });
const host = new Host({ cfg, db, box: new SecretBox(cfg.masterKey), docker: new Docker(cfg.DOCKER_SOCKET), redis, log: createLog('admin'), routes: { version: 0, bump() {} }, authFor: authFactory(cfg) });

try {
  if (cmd === 'create-workspace' && arg) {
    const { workspaceId, token } = await host.createWorkspace(arg);
    const env = { BASALT_HOST_URL: cfg.hostPublicUrl, BASALT_HOST_TOKEN: token, BASALT_ROOT_DOMAIN: cfg.ROOT_DOMAIN, BASALT_REGISTRY_URL: cfg.registryPublicUrl };
    const args = ['-y', '--registry', cfg.registryPublicUrl, '@basalt/host-mcp'];
    console.log(`Workspace ${workspaceId} created.\n`);
    console.log("Add the Basalt connector to the user's coding agent. Claude Code, from the app's folder:\n");
    console.log(`  claude mcp add basalt ${Object.entries(env).map(([k, v]) => `-e ${k}=${v}`).join(' ')} -- npx ${args.join(' ')}\n`);
    console.log('Or as .mcp.json in the project (keep it out of git; the token is a secret):\n');
    console.log(JSON.stringify({ mcpServers: { basalt: { command: 'npx', args, env } } }, null, 2));
  } else if (cmd === 'under-attack' && (arg === 'on' || arg === 'off')) {
    await host.setUnderAttack(arg === 'on');
    console.log(`Global under-attack mode ${arg} (the edge applies it within a few seconds).`);
  } else {
    console.log('usage: basalt-admin create-workspace <name> | under-attack on|off');
    process.exitCode = 1;
  }
} finally {
  await db.close();
  redis.disconnect();
}
