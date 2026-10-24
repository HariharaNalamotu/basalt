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
    console.log(`Workspace ${workspaceId} created.\n\nGive the user's coding agent this MCP server (e.g. in .mcp.json):\n`);
    console.log(
      JSON.stringify(
        { mcpServers: { basalt: { command: 'npx', args: ['-y', '--registry', `https://registry.${cfg.ROOT_DOMAIN}/`, '@basalt/host-mcp'], env: { BASALT_HOST_URL: `https://host.${cfg.ROOT_DOMAIN}`, BASALT_HOST_TOKEN: token } } } },
        null,
        2,
      ),
    );
  } else if (cmd === 'under-attack' && (arg === 'on' || arg === 'off')) {
    await host.setUnderAttack(arg === 'on');
    console.log(`Global under-attack mode ${arg}.`);
  } else {
    console.log('usage: basalt-admin create-workspace <name> | under-attack on|off');
    process.exitCode = 1;
  }
} finally {
  await db.close();
  redis.disconnect();
}
