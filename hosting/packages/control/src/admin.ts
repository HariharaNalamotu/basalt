#!/usr/bin/env node
/**
 * Operator CLI (run inside the control container):
 *   basalt-admin create-workspace <name>                 → workspace token + MCP config for the user's agent
 *   basalt-admin ensure-workspace <name>                 → the newest workspace with that name, made if missing (prints its id)
 *   basalt-admin connector <workspace> [mac|windows]     → a fresh token as a ready .mcp.json
 *   basalt-admin dashboard-link <workspace> [--connect] [--url-only]
 *                                                        → a link to the owner's dashboard (id or name);
 *                                                          --connect opens its "Connect Claude" page
 *   basalt-admin tokens <workspace>                      → the workspace's keys (connector files), newest first
 *   basalt-admin revoke-token <token id>                 → that key stops working right away
 *   basalt-admin under-attack on|off                     → proof-of-work challenge on every app
 */
import { Redis } from 'ioredis';
import { createLog } from '@basalt/host-shared';
import { loadConfig } from './config.js';
import { connectorCommand, connectorConfig, type ConnectorOs } from './connector.js';
import { authFactory } from './ctx.js';
import { SecretBox } from './crypto.js';
import { dashboardLink } from './dashboard.js';
import { createDb, migrate } from './db.js';
import { Docker } from './docker.js';
import { Host } from './service.js';

const [cmd, arg, ...rest] = process.argv.slice(2);
const cfg = loadConfig();
const db = createDb(cfg.DATABASE_URL);
await migrate(db);
const redis = new Redis(cfg.REDIS_ADMIN_URL, { lazyConnect: true });
const host = new Host({ cfg, db, box: new SecretBox(cfg.masterKey), docker: new Docker(cfg.DOCKER_SOCKET), redis, log: createLog('admin'), routes: { version: 0, bump() {} }, authFor: authFactory(cfg) });

/** A workspace by id or name (the newest of that name). */
async function workspace(ref: string) {
  const rows = (await db.query<{ id: string; name: string }>('SELECT id, name FROM workspaces WHERE id = $1 OR name = $1 ORDER BY created_at DESC', [ref])).rows;
  if (!rows.length) throw new Error(`No workspace "${ref}".`);
  return rows[0]!;
}

try {
  if (cmd === 'create-workspace' && arg) {
    const { workspaceId, token } = await host.createWorkspace(arg);
    console.log(`Workspace ${workspaceId} created.\n`);
    console.log("Add the Basalt connector to the user's coding agent. Claude Code, from the app's folder:\n");
    console.log(`  ${connectorCommand(cfg, token)}\n`);
    console.log('Or as .mcp.json in the project (keep it out of git; the token is a secret):\n');
    console.log(JSON.stringify(connectorConfig(cfg, token, 'mac'), null, 2));
  } else if (cmd === 'ensure-workspace' && arg) {
    const found = (await db.query<{ id: string }>('SELECT id FROM workspaces WHERE name = $1 ORDER BY created_at DESC LIMIT 1', [arg])).rows[0];
    console.log(found ? found.id : (await host.createWorkspace(arg)).workspaceId);
  } else if (cmd === 'connector' && arg) {
    const ws = await workspace(arg);
    const os: ConnectorOs = rest[0] === 'windows' ? 'windows' : rest[0] === 'linux' ? 'linux' : 'mac';
    console.log(JSON.stringify(connectorConfig(cfg, await host.createToken(ws.id, `connector (${os}, admin)`), os), null, 2));
  } else if (cmd === 'dashboard-link' && arg) {
    const ws = await workspace(arg);
    const url = dashboardLink(cfg, ws.id, rest.includes('--connect') ? 'connect' : undefined);
    console.log(rest.includes('--url-only') ? url : `Dashboard for ${ws.name} (valid 24 hours):\n\n  ${url}\n`);
  } else if (cmd === 'tokens' && arg) {
    const ws = await workspace(arg);
    const rows = (await db.query<{ id: string; name: string; created_at: Date; last_used_at: Date | null; revoked_at: Date | null }>('SELECT id, name, created_at, last_used_at, revoked_at FROM api_tokens WHERE workspace_id = $1 ORDER BY created_at DESC', [ws.id])).rows;
    for (const r of rows) console.log([r.id, r.revoked_at ? 'revoked' : 'active', r.name, `made ${r.created_at.toISOString()}`, `last used ${r.last_used_at?.toISOString() ?? 'never'}`].join('  '));
  } else if (cmd === 'revoke-token' && arg) {
    const r = await db.query(`UPDATE api_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [arg]);
    if (!r.rowCount) throw new Error(`No active key "${arg}".`);
    console.log(`Key ${arg} revoked. Connector files with it stop working now.`);
  } else if (cmd === 'under-attack' && (arg === 'on' || arg === 'off')) {
    await host.setUnderAttack(arg === 'on');
    console.log(`Global under-attack mode ${arg} (the edge applies it within a few seconds).`);
  } else {
    console.log('usage: basalt-admin create-workspace <name> | ensure-workspace <name> | connector <workspace> [mac|windows] | dashboard-link <workspace> [--connect] [--url-only] | tokens <workspace> | revoke-token <id> | under-attack on|off');
    process.exitCode = 1;
  }
} finally {
  await db.close();
  redis.disconnect();
}
