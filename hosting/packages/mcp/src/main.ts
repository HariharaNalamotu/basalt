#!/usr/bin/env node
/**
 * Basalt Host MCP server for coding agents. Runs next to the project:
 * - host_deploy / host_init act on local files (pack + upload, project setup)
 * - every other tool is forwarded to the Basalt Host control plane
 */
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { initProject } from './init.js';
import { packProject } from './pack.js';
import { scanFolder } from './scan.js';

const baseUrl = (process.env.BASALT_HOST_URL ?? '').replace(/\/+$/, '');
const token = process.env.BASALT_HOST_TOKEN ?? '';
if (!baseUrl || !token) {
  console.error('Set BASALT_HOST_URL and BASALT_HOST_TOKEN (from your Basalt workspace).');
  process.exit(1);
}
const rootDomain = process.env.BASALT_ROOT_DOMAIN ?? new URL(baseUrl).hostname.replace(/^host\./, '');
const registryUrl = process.env.BASALT_REGISTRY_URL || rootDomain;
const projectRoot = (dir?: string) => path.resolve(process.env.BASALT_PROJECT_DIR ?? process.cwd(), dir ?? '.');

const remote = new Client({ name: 'basalt-host-mcp', version: '0.2.0' });
await remote.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));

const LOCAL: Tool[] = [
  {
    name: 'host_deploy',
    description:
      'Deploys the local project: packs it (honoring .gitignore; never node_modules, .git, .env or build output), uploads it, builds it in CI (security scan, audit, typecheck, lint, unit tests, build), deploys a private preview and runs smoke + e2e tests. ship=true continues through staging to production when every gate passes. Returns status; continue with host_wait.',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'App name (host_create_app first).' },
        dir: { type: 'string', description: 'Project directory (default: current directory).' },
        message: { type: 'string', description: 'What changed (shown in history).' },
        ship: { type: 'boolean', description: 'Continue to staging and production if all tests pass.' },
      },
      required: ['app'],
    },
  },
  {
    name: 'host_data_check',
    description:
      "Guard, Basalt's safety check for an environment's data. Scans the local project folder for data kept outside Basalt (browser storage, other databases, data files, pasted keys; the code stays on this machine), then signs in as two real test people and a stranger and tries a dozen ways to reach data that isn't theirs. Returns problems to fix and a safety receipt link for the owner. Run it on the preview or staging after setting host_data_rules, and again after any change to how the app saves data.",
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string' },
        env: { type: 'string', description: '"staging", "production" or a preview name like "p3f9a1x".' },
        dir: { type: 'string', description: 'Project directory (default: current directory).' },
      },
      required: ['app', 'env'],
    },
  },
  {
    name: 'host_init',
    description: 'Prepares the local project for Basalt Host: .npmrc for @basalt packages, basalt.json, playwright.config.ts and an example e2e test (never overwrites existing files). Run once, then npm install.',
    inputSchema: { type: 'object', properties: { dir: { type: 'string' } } },
  },
];

const server = new Server(
  { name: 'basalt', version: '0.2.0' },
  {
    capabilities: { tools: {} },
    instructions:
      'Basalt: hosting, sign-in, backend and per-person data for this app. Call host_guide { topic: "workflow" } first, and host_guide { topic: "data" } before writing code that saves anything. You build, test, stage and ship the app yourself with these tools; never ask the person to run commands. The person may have no coding experience: explain results in plain words.',
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const { tools } = await remote.listTools();
  return { tools: [...LOCAL, ...tools.filter((t) => !LOCAL.some((l) => l.name === t.name))] };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;
  try {
    if (req.params.name === 'host_init') {
      const r = await initProject(projectRoot(args.dir as string | undefined), registryUrl);
      return { content: [{ type: 'text', text: `Written: ${r.written.join(', ') || '(nothing)'}\nKept existing: ${r.kept.join(', ') || '(none)'}\n\nNext: npm install @basalt/api @basalt/auth && npm install -D @playwright/test@~1.64.0, then host_guide { topic: "project" }.` }] };
    }
    if (req.params.name === 'host_data_check') {
      const scan = scanFolder(projectRoot(args.dir as string | undefined));
      return await remote.callTool({ name: 'host_data_check', arguments: { app: args.app, env: args.env, scan: scan.slice(0, 100) } }, undefined, { timeout: 180_000 });
    }
    if (req.params.name === 'host_deploy') {
      const app = String(args.app ?? '');
      const { tgz, files } = await packProject(projectRoot(args.dir as string | undefined));
      const up = await fetch(`${baseUrl}/v1/apps/${encodeURIComponent(app)}/sources`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/gzip' },
        body: new Uint8Array(tgz),
      });
      const body = (await up.json()) as { sourceId?: string; error?: string };
      if (!up.ok || !body.sourceId) throw new Error(body.error ?? `upload failed (${up.status})`);
      const r = await remote.callTool({ name: 'host_deploy_source', arguments: { app, sourceId: body.sourceId, message: args.message, ship: args.ship } }, undefined, { timeout: 120_000 });
      (r.content as Array<{ type: string; text?: string }>).unshift({ type: 'text', text: `Uploaded ${files} files (${Math.round(tgz.length / 1024)} KB).` });
      return r;
    }
    return await remote.callTool({ name: req.params.name, arguments: args }, undefined, { timeout: 120_000 });
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `Error: ${(err as Error).message}` }] };
  }
});

await server.connect(new StdioServerTransport());
