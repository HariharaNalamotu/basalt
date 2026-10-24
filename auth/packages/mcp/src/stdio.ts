#!/usr/bin/env node
/**
 * Standalone MCP server over stdio, for local development against a self-hosted auth service.
 * On the Basalt platform the tools are mounted in the platform's own MCP server instead, which
 * authenticates the workspace and never hands the platform key to the agent.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { HttpControlPlane } from './control-plane.js';
import { registerAuthTools } from './tools.js';

const url = process.env.BASALT_AUTH_URL;
const key = process.env.BASALT_AUTH_PLATFORM_KEY;
const owner = process.env.BASALT_OWNER_ID ?? 'local';
if (!url || !key) {
  console.error('Set BASALT_AUTH_URL and BASALT_AUTH_PLATFORM_KEY (and optionally BASALT_OWNER_ID).');
  process.exit(1);
}

const server = new McpServer(
  { name: 'basalt-auth', version: '0.1.0' },
  {
    instructions:
      'Basalt Auth provides secure, ready-made authentication. Never implement sign-up, sign-in, sessions, password hashing or tokens yourself. Call auth_integration_guide before writing auth code and auth_review_code on the result.',
  },
);
registerAuthTools(server, new HttpControlPlane(url, key, owner));
await server.connect(new StdioServerTransport());
