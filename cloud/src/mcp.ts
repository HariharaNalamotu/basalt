// The Basalt MCP server. Claude Code runs this and uses its tools to give the
// app a safe hosted database, so the person building never has to set up or
// read anything technical. Speaks MCP over stdio (one JSON message per line).
//
// Add it to Claude Code with:
//   claude mcp add basalt -e BASALT_URL=<basalt cloud url> -- node <path>/cloud/src/mcp.ts

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const BASALT_URL = (process.env.BASALT_URL ?? 'http://127.0.0.1:8790').replace(/\/+$/, '');
const DIR = process.env.BASALT_PROJECT_DIR ?? process.cwd();
const CONFIG = join(DIR, '.basalt', 'project.json');

interface Saved {
  id: string;
  name: string;
  adminKey: string;
  dataUrl: string;
}

function load(): Saved | null {
  try {
    return JSON.parse(readFileSync(CONFIG, 'utf8'));
  } catch {
    return null;
  }
}

function save(s: Saved): void {
  mkdirSync(join(DIR, '.basalt'), { recursive: true });
  writeFileSync(CONFIG, JSON.stringify(s, null, 2), { mode: 0o600 });
  // The key must never end up in git.
  const gi = join(DIR, '.gitignore');
  const has = existsSync(gi) && readFileSync(gi, 'utf8').split('\n').some((l) => l.trim() === '.basalt/');
  if (!has) appendFileSync(gi, `${existsSync(gi) ? '\n' : ''}.basalt/\n`);
}

async function api(method: string, path: string, body?: unknown, key?: string): Promise<any> {
  const res = await fetch(`${BASALT_URL}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch(() => {
    throw new Error(`Couldn't reach Basalt at ${BASALT_URL}. Check the internet connection and try again.`);
  });
  const json = await res.json().catch(() => null);
  if (!json?.ok) throw new Error(json?.error?.message ?? `Basalt answered ${res.status}.`);
  return json;
}

function need(): Saved {
  const s = load();
  if (!s) throw new Error('This folder has no Basalt app yet. Call basalt_start first.');
  return s;
}

const CONTRACT_HELP = `The rules are a JSON object: { "tables": { "<table>": { "fields": { "<field>": { "type": ..., ... } }, "shareWith": "<field>"? } } }.
Names: lowercase letters, numbers and underscores, starting with a letter (like "bookings", "starts_at").
Field types: "text" (maxLength 1 to 10000, default 1000; optional "format": "email" | "phone" | "url" | "postal_code" | "slug"), "integer" and "number" (optional "min", "max"), "boolean", "timestamp" (ISO date and time) and "user" (another person's user id).
Add "required": true for fields that must always be filled in.
Every row automatically gets id, owner_id (who added it), created_at and updated_at. Don't add those.
Each person only ever sees and changes the rows they added. To let one other person read a row (like the staff member assigned to a booking), add a "user" field and set "shareWith" to its name. They can read it but never change it.
Example: { "tables": { "bookings": { "fields": { "service": { "type": "text", "maxLength": 100, "required": true }, "starts_at": { "type": "timestamp", "required": true }, "phone": { "type": "text", "format": "phone" }, "staff_id": { "type": "user" } }, "shareWith": "staff_id" } } }
Later you can add new optional fields or new tables. Removing a field, making one required or changing its rules isn't allowed.`;

function clientCode(dataUrl: string): string {
  return `// basalt.js: the only way this app reads or saves data. Don't store app data anywhere else.
const BASALT_URL = ${JSON.stringify(dataUrl)};

// getToken returns the signed in person's login token.
export function basalt(getToken) {
  async function call(op, body) {
    const res = await fetch(\`\${BASALT_URL}/v1/data/\${op}\`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: \`Bearer \${await getToken()}\` },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!json.ok) {
      const err = new Error(json.error.message);
      err.code = json.error.code; // invalid_input, not_found, denied, rate_limited or unavailable
      throw err;
    }
    return json.data;
  }
  return {
    get: (table, id) => call('get', { table, id }),
    // Newest first. Pass { after: page.next } to get the next page.
    list: (table, options = {}) => call('list', { table, ...options }),
    // Pass { key } (for example an order number) so a retry never saves twice.
    create: (table, input, options = {}) => call('create', { table, input, ...options }),
    update: (table, id, input) => call('update', { table, id, input }),
  };
}
`;
}

const TOOLS = [
  {
    name: 'basalt_start',
    description:
      'Gives this app a safe hosted database. Call this once, the first time the app needs to save anything (bookings, orders, profiles, notes...). Then, before writing any data code, ask the person a few short plain-English questions in your own words, one at a time: what the app keeps track of, what each thing needs to remember, whether one other person (like a staff member) should be able to see a given entry, and which details are must-haves. Never ask about databases, tables or code. Then call basalt_set_rules.',
    inputSchema: {
      type: 'object',
      properties: { app_name: { type: 'string', description: "The app's name in plain words, like \"Maria's Salon bookings\"." } },
      required: ['app_name'],
    },
  },
  {
    name: 'basalt_set_rules',
    description: `Sets what the app saves and who can see it, based on the person's answers. If the rules let anyone see more than before, Basalt returns a link: show it to the person and ask them to open it and approve. Nothing changes until they do. ${CONTRACT_HELP}`,
    inputSchema: { type: 'object', properties: { rules: { type: 'object', description: 'The rules JSON described above.' } }, required: ['rules'] },
  },
  {
    name: 'basalt_status',
    description: "Shows whether the app's rules are live or still waiting for the person's approval, and the rules in plain English.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'basalt_connect_app',
    description:
      "Returns the code the app uses to read and save data (a small basalt.js file), plus how to use it. Use it for every read and save. Never store app data in localStorage, files, another database or anywhere else, and never write SQL. Every call needs the signed in person's login token. Until the app has real sign in, use basalt_test_login tokens to try it.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'basalt_test_login',
    description: 'Gives a login token for a pretend person, so you can try the app as them. Use two different names to check that one person can never see the other\'s data. Tokens last one hour.',
    inputSchema: { type: 'object', properties: { who: { type: 'string', description: 'A name for the pretend person, like "maria" or "customer two".' } }, required: ['who'] },
  },
];

async function callTool(name: string, args: Record<string, any>): Promise<string> {
  switch (name) {
    case 'basalt_start': {
      const existing = load();
      if (existing) return `This app already has a Basalt database (${existing.name}). Use basalt_status to see its rules.`;
      const out = await api('POST', '/api/projects', { name: String(args.app_name ?? 'My app') });
      save({ id: out.project.id, name: out.project.name, adminKey: out.adminKey, dataUrl: out.project.dataUrl });
      return `Done: "${out.project.name}" has its own locked down database. Its key is saved in .basalt/ (already kept out of git).\nNext: ask the person the plain questions described in basalt_start, then call basalt_set_rules.`;
    }
    case 'basalt_set_rules': {
      const s = need();
      const out = await api('PUT', '/api/projects/me/rules', { contract: args.rules }, s.adminKey);
      if (out.status === 'waiting_for_owner') {
        return `The person needs to approve this first. Show them this link and ask them to open it and tap "Yes":\n${out.approveUrl}\n\nWhy: ${out.why.join(' ')}\n\nWhat they'll see:\n${out.summary}\n\nAfter they approve, call basalt_status to confirm, then basalt_connect_app.`;
      }
      return `These rules are live now:\n${out.summary}\n\nNext: call basalt_connect_app.`;
    }
    case 'basalt_status': {
      const s = need();
      const out = await api('GET', '/api/projects/me', undefined, s.adminKey);
      const p = out.project;
      if (p.status === 'live') return `Live. Rules in plain English:\n${p.rules}${p.waitingForOwner ? '\n\nA newer change is still waiting for the person to approve it.' : ''}`;
      if (p.status === 'waiting_for_owner') return 'Waiting for the person to open the approval link and tap "Yes". If they lost it, call basalt_set_rules again for a fresh link.';
      return 'No rules yet. Ask the person the plain questions, then call basalt_set_rules.';
    }
    case 'basalt_connect_app': {
      const s = need();
      const out = await api('GET', '/api/projects/me', undefined, s.adminKey);
      if (out.project.status !== 'live') return 'The rules aren\'t live yet. Finish basalt_set_rules (and the person\'s approval) first.';
      return `Save this as basalt.js in the app and use it for all data:\n\n${clientCode(s.dataUrl)}\nUse it like:\n  import { basalt } from './basalt.js';\n  const db = basalt(() => currentUserToken);\n  const booking = await db.create('bookings', { service: 'Haircut', starts_at: '2026-10-25T15:00:00Z' });\n  const page = await db.list('bookings', { limit: 20 });\n\nThe rules in plain English:\n${out.project.rules}\n\nIf a call fails, err.message says why in plain words and err.code says what kind of problem it is.`;
    }
    case 'basalt_test_login': {
      const s = need();
      const out = await api('POST', '/api/projects/me/test-login', { who: String(args.who ?? 'test person') }, s.adminKey);
      return `Test login for "${out.who}" (user id ${out.userId}), good for one hour:\n${out.token}`;
    }
  }
  throw new Error(`Unknown tool ${name}.`);
}

function reply(id: unknown, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function replyError(id: unknown, code: number, message: string): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}

const rl = createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return replyError(null, -32700, 'Parse error');
  }
  const { id, method, params } = msg;
  if (id === undefined) return; // notifications need no answer
  try {
    switch (method) {
      case 'initialize':
        return reply(id, {
          protocolVersion: params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'basalt', version: '0.1.0' },
          instructions:
            'Basalt gives this app a hosted database where each person can only ever see their own data. Use it for anything the app saves. The person building may have no coding experience: talk to them in plain words and never ask them to run commands.',
        });
      case 'ping':
        return reply(id, {});
      case 'tools/list':
        return reply(id, { tools: TOOLS });
      case 'tools/call':
        try {
          const text = await callTool(params?.name, params?.arguments ?? {});
          return reply(id, { content: [{ type: 'text', text }] });
        } catch (err) {
          return reply(id, { content: [{ type: 'text', text: (err as Error).message }], isError: true });
        }
      default:
        return replyError(id, -32601, `Unknown method ${method}`);
    }
  } catch (err) {
    return replyError(id, -32603, (err as Error).message);
  }
});
