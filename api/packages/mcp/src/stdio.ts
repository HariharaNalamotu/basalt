#!/usr/bin/env node
/**
 * Standalone MCP server (stdio) for local development: provisions apps on this machine via
 * LocalPlatform. On the hosted platform these tools are mounted in the platform's MCP server with
 * a platform implementation of ApiPlatform scoped to the authenticated workspace.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { HttpControlPlane, registerAuthTools } from '@basalt/auth-mcp';
import { LocalPlatform } from './platform.js';
import { registerApiTools } from './tools.js';

const need = (k: string) => {
  const v = process.env[k];
  if (!v) {
    console.error(`Missing ${k}. Required: BASALT_AUTH_URL, BASALT_AUTH_PLATFORM_KEY, BASALT_PG_ADMIN_URL, BASALT_REDIS_URL.`);
    process.exit(1);
  }
  return v;
};

const auth = new HttpControlPlane(need('BASALT_AUTH_URL'), need('BASALT_AUTH_PLATFORM_KEY'), process.env.BASALT_OWNER_ID ?? 'local');
const platform = new LocalPlatform({
  stateDir: process.env.BASALT_STATE_DIR,
  pgAdminUrl: need('BASALT_PG_ADMIN_URL'),
  redisUrl: need('BASALT_REDIS_URL'),
  backendUrl: process.env.BASALT_BACKEND_URL,
});

const server = new McpServer(
  { name: 'basalt', version: '0.1.0' },
  {
    instructions:
      'Basalt provides secure, scalable building blocks. For any backend: call api_setup, then api_scaffold / api_integration_guide, write routes with @basalt/api, run api_review_code on what you wrote and api_status to verify. Never build auth, HTTP servers, SQL strings or config files by hand. Auth-specific tools are prefixed auth_.',
  },
);
registerAuthTools(server, auth);
registerApiTools(server, { platform, auth });
await server.connect(new StdioServerTransport());
