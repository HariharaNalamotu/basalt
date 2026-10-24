// Basalt Cloud. Hosts a locked down database for every app and the pages and
// API that the Basalt MCP server (what Claude Code talks to) uses.
//
//   POST /api/projects                 { name }      -> a new app with its own database
//   GET  /api/projects/me              (admin key)   -> status, rules summary, approval link
//   PUT  /api/projects/me/rules        { contract }  -> live now, or waiting for the owner's yes
//   POST /api/projects/me/test-login   { who }       -> a login token for a test person
//   POST /api/projects/me/admins       { who | userId } -> asks the owner to make someone an admin
//   POST /api/projects/me/check        { scan? }     -> Guard's safety check, with a receipt link
//   GET  /approve/<id>?t=<token>                     -> the owner's approval page
//   GET  /owner/<project id>?k=<key>                  -> the owner's data map
//   GET  /owner/<project id>/check?k=<key>            -> the owner's safety receipt
//   POST /p/<project id>/v1/data/<op>                -> that app's data API
//
//   node --env-file=.env src/server.ts

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { BasaltData, BasaltError, createDataHandler, parseContract, setServerLimits, type Contract, type DataHandler } from '../../data/src/index.ts';
import { ConflictError, Projects, type Project } from './projects.ts';
import { resign, runChecks } from './guard.ts';
import { renderReceipt } from './receipt.ts';
import type { ScanFinding } from './scan.ts';
import { sha256 } from './secrets.ts';
import { esc, page } from './html.ts';
import { renderMap } from './map.ts';
import type { AuthLink } from './auth.ts';
import { loosens, summarize } from './summary.ts';

export interface CloudServerOptions {
  projects: Projects;
  auth: AuthLink;
  // Lets the hosting platform make databases bound to its environments' Auth projects and
  // apply rules to non-production environments. Unset: the platform API is disabled.
  platformKey?: string;
  publicUrl: string;
  maxProjects?: number;
  projectsPerIpPerHour?: number;
  trustProxy?: boolean;
  // Where this server reaches itself directly (Guard's checks), like http://127.0.0.1:8790.
  // Default: publicUrl. Set it when publicUrl goes through the edge.
  selfUrl?: string;
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(json);
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'",
  });
  res.end(html);
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new HttpError(413, `Request body is over ${maxBytes} bytes.`);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = JSON.parse((await readBody(req, 256 * 1024)) || '{}');
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, 'The request body is not valid JSON.');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new HttpError(400, 'Send a JSON object.');
  return body as Record<string, unknown>;
}

// Code scan findings come from the person's own machine, so they're cut down
// to known fields and sizes before being stored or shown.
function cleanFindings(raw: unknown): ScanFinding[] | null {
  if (!Array.isArray(raw)) return null;
  const str = (v: unknown, n: number) => (typeof v === 'string' ? v.slice(0, n) : '');
  return raw.slice(0, 100).map((f) => ({
    rule: str(f?.rule, 40),
    file: str(f?.file, 300),
    line: Number.isSafeInteger(f?.line) && f.line > 0 ? f.line : 0,
    problem: str(f?.problem, 300),
    fix: str(f?.fix, 300),
  }));
}

function summaryHtml(contract: Contract): string {
  return summarize(contract)
    .tables.map(
      (t) => `<div class="card"><h2>${esc(t.name[0].toUpperCase() + t.name.slice(1))}</h2><ul>${t.rules.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
<p class="muted">What's saved: ${esc(t.fields.join('; '))}.</p></div>`,
    )
    .join('');
}

export function createCloudServer(options: CloudServerOptions) {
  const { projects } = options;
  const base = options.publicUrl.replace(/\/+$/, '');
  const maxProjects = options.maxProjects ?? 500;
  const perIp = options.projectsPerIpPerHour ?? 10;
  const created = new Map<string, number[]>();
  let projectCount = 0;
  const handlers = new Map<string, { handler: DataHandler; data: BasaltData; hosted: boolean }>();
  const publicHost = new URL(base).host;
  // Guard runs one check per app at a time, and a few across all apps.
  const checking = new Set<string>();
  const maxChecks = 4;

  function ip(req: IncomingMessage): string {
    const fwd = options.trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() : '';
    return fwd || req.socket.remoteAddress || 'unknown';
  }

  async function adminProject(req: IncomingMessage): Promise<Project> {
    const m = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
    const p = m ? await projects.authorize(m[1]) : null;
    if (!p) throw new HttpError(401, 'That Basalt key is missing or not valid. Run basalt_start again to get one.');
    return p;
  }

  async function dropHandler(id: string): Promise<void> {
    const h = handlers.get(id);
    handlers.delete(id);
    await h?.data.close().catch(() => {});
  }

  // Hosted environments' data is served only on their app's own site (/_basalt/data through the
  // edge), where the preview gate and attack shield apply, never on Cloud's public address.
  const onPublicAddress = (req: IncomingMessage) => Boolean(options.trustProxy) && req.headers['x-forwarded-host'] === publicHost;

  async function dataHandler(id: string, req: IncomingMessage): Promise<DataHandler | null | 'hidden'> {
    const cached = handlers.get(id);
    if (cached) return cached.hosted && onPublicAddress(req) ? 'hidden' : cached.handler;
    const p = await projects.get(id);
    if (p?.hosted && onPublicAddress(req)) return 'hidden';
    if (!p || !p.approvedContract) return null;
    const data = new BasaltData({ connectionString: projects.dataUrl(p), contract: parseContract(p.approvedContract), poolSize: 3 });
    const handler = createDataHandler({ data });
    // Keep a bounded number of apps' connection pools open at once.
    if (handlers.size >= 200) await dropHandler(handlers.keys().next().value!);
    handlers.set(id, { handler, data, hosted: p.hosted });
    return handler;
  }

  async function status(p: Project) {
    const pending = await projects.pendingApproval(p.id);
    const approved = p.approvedContract ? parseContract(p.approvedContract) : null;
    return {
      id: p.id,
      name: p.name,
      dataUrl: `${base}/p/${p.id}`,
      status: approved ? 'live' : pending ? 'waiting_for_owner' : 'no_rules_yet',
      rules: approved ? summarize(approved).text : null,
      waitingForOwner: Boolean(pending),
      mapUrl: `${base}/owner/${p.id}?k=${await projects.ownerViewKey(p)}`,
    };
  }

  function requirePlatform(req: IncomingMessage): void {
    // Only Basalt Host's control plane calls this, directly over the platform network. Anything
    // that came through the edge carries X-Forwarded-For, so the platform API isn't there for it.
    if (options.trustProxy && req.headers['x-forwarded-for'] !== undefined) throw new HttpError(404, 'Unknown route.');
    const presented = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
    const ok =
      Boolean(options.platformKey) &&
      timingSafeEqual(createHash('sha256').update(presented).digest(), createHash('sha256').update(options.platformKey!).digest());
    if (!ok) throw new HttpError(401, 'Platform key required.');
  }

  async function handlePlatform(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    requirePlatform(req);
    if (req.method === 'POST' && path === '/api/platform/projects') {
      const body = await readJson(req);
      const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : '';
      const authProjectId = typeof body.authProjectId === 'string' && /^prj_[A-Za-z0-9]{8,40}$/.test(body.authProjectId) ? body.authProjectId : '';
      const authOwner = typeof body.authOwner === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(body.authOwner) ? body.authOwner : '';
      if (!name || !authProjectId || !authOwner) throw new HttpError(400, 'name, authProjectId and authOwner are required.');
      if (body.externalId !== undefined && (typeof body.externalId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(body.externalId))) throw new HttpError(400, 'externalId must be 1 to 64 letters, numbers, _ or -.');
      const { project, adminKey } = await projects.create(name, { authProjectId, authOwner, externalId: body.externalId as string | undefined }).catch((err) => {
        throw err instanceof ConflictError ? new HttpError(409, err.message) : err;
      });
      return sendJson(res, 201, { ok: true, project: await status(project), adminKey });
    }
    // Deletes an environment's data project by the platform's environment id, so one whose
    // creation reply was lost can still be cleaned up.
    const envMatch = /^\/api\/platform\/environments\/([A-Za-z0-9_-]{1,64})$/.exec(path);
    if (envMatch && req.method === 'DELETE') {
      if (!(await projects.deleteByExternalId(envMatch[1], (p) => dropHandler(p.id)))) throw new HttpError(404, 'Unknown environment.');
      return sendJson(res, 200, { ok: true });
    }
    const m = /^\/api\/platform\/projects\/([a-z0-9]{10})(\/rules)?$/.exec(path);
    const p = m ? await projects.get(m[1]) : null;
    if (!m || !p) throw new HttpError(404, 'Unknown project.');
    // Test environments: rules apply right away (only test data is at stake). Production goes
    // through the owner-approval flow in /api/projects/me/rules instead.
    if (req.method === 'PUT' && m[2]) {
      const body = await readJson(req);
      try {
        await projects.apply(p, body.contract);
      } catch (err) {
        throw new HttpError(409, (err as Error).message);
      }
      await dropHandler(p.id);
      return sendJson(res, 200, { ok: true, status: 'live', summary: summarize(parseContract(body.contract)).text });
    }
    if (req.method === 'DELETE' && !m[2]) {
      await dropHandler(p.id);
      await projects.delete(p);
      return sendJson(res, 200, { ok: true });
    }
    throw new HttpError(404, 'Unknown route.');
  }

  async function handleApi(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    if (path.startsWith('/api/platform/')) return handlePlatform(req, res, path);
    if (req.method === 'POST' && path === '/api/projects') {
      const body = await readJson(req);
      const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : '';
      if (!name) throw new HttpError(400, 'Give the app a name, like "Maria\'s Salon".');
      const who = ip(req);
      const now = Date.now();
      const recent = (created.get(who) ?? []).filter((t) => now - t < 3_600_000);
      if (recent.length >= perIp) throw new HttpError(429, 'Too many new apps from here in the last hour. Try again later.');
      if (projectCount >= maxProjects) throw new HttpError(503, 'Basalt is full right now. Try again later.');
      const { project, adminKey } = await projects.create(name);
      created.set(who, [...recent, now]);
      projectCount++;
      return sendJson(res, 201, { ok: true, project: await status(project), adminKey });
    }

    if (req.method === 'GET' && path === '/api/projects/me') {
      return sendJson(res, 200, { ok: true, project: await status(await adminProject(req)) });
    }

    if (req.method === 'PUT' && path === '/api/projects/me/rules') {
      const p = await adminProject(req);
      const body = await readJson(req);
      let next: Contract;
      try {
        next = parseContract(body.contract);
      } catch (err) {
        throw new HttpError(400, `The rules aren't valid yet: ${(err as Error).message}`);
      }
      const reasons = loosens(p.approvedContract ? parseContract(p.approvedContract) : null, next);
      const summary = summarize(next).text;
      if (reasons.length) {
        const { id, token } = await projects.requestApproval(p, body.contract);
        return sendJson(res, 202, {
          ok: true,
          status: 'waiting_for_owner',
          approveUrl: `${base}/approve/${id}?t=${token}`,
          why: reasons,
          summary,
        });
      }
      try {
        await projects.apply(p, body.contract);
      } catch (err) {
        throw new HttpError(409, (err as Error).message);
      }
      await dropHandler(p.id);
      return sendJson(res, 200, { ok: true, status: 'live', summary });
    }

    if (req.method === 'POST' && path === '/api/projects/me/test-login') {
      const p = await adminProject(req);
      const body = await readJson(req);
      const who = typeof body.who === 'string' && /^[A-Za-z0-9 _-]{1,40}$/.test(body.who) ? body.who : 'test person';
      if (!p.authProjectId) throw new HttpError(409, 'This app was made before Basalt Auth was connected. Make a new one with basalt_start.');
      // A real Basalt Auth user and session: the database checks this token like any other login.
      const login = await options.auth.testLogin(p.authProjectId, who, p.authOwner);
      return sendJson(res, 200, { ok: true, who, userId: login.userId, token: login.token, expiresInSeconds: login.expiresInSeconds });
    }

    if (req.method === 'POST' && path === '/api/projects/me/admins') {
      const p = await adminProject(req);
      if (!p.approvedContract) throw new HttpError(409, "Set the app's rules first (and get them approved), then add an admin.");
      const body = await readJson(req);
      let uid: string;
      let label: string;
      if (typeof body.userId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(body.userId)) {
        uid = body.userId;
        label = typeof body.label === 'string' ? body.label.slice(0, 60) : 'this person';
      } else if (typeof body.who === 'string' && /^[A-Za-z0-9 _-]{1,40}$/.test(body.who)) {
        if (!p.authProjectId) throw new HttpError(409, 'This app was made before Basalt Auth was connected.');
        uid = (await options.auth.testLogin(p.authProjectId, body.who, p.authOwner)).userId;
        label = body.who;
      } else {
        throw new HttpError(400, 'Say who should be an admin: a test person\'s name (who) or a user id (userId).');
      }
      const { id, token } = await projects.requestAdmin(p, uid, label);
      return sendJson(res, 202, { ok: true, status: 'waiting_for_owner', approveUrl: `${base}/approve/${id}?t=${token}`, userId: uid });
    }

    if (req.method === 'POST' && path === '/api/projects/me/check') {
      const p = await adminProject(req);
      if (!p.approvedContract) throw new HttpError(409, "Set the app's rules first (and get them approved), then run the check.");
      const findings = cleanFindings((await readJson(req)).scan);
      if (!p.authProjectId) throw new HttpError(409, 'This app was made before Basalt Auth was connected. Make a new one with basalt_start.');
      if (checking.has(p.id)) throw new HttpError(429, 'A check for this app is already running. Wait for it to finish.');
      if (checking.size >= maxChecks) throw new HttpError(503, 'Basalt is running a lot of checks right now. Try again in a minute.');
      checking.add(p.id);
      try {
        // Two real Basalt Auth test people. The forged and expired logins are A's real token
        // re-signed, so they match what the database expects in every way but the one tested.
        const a = await options.auth.testLogin(p.authProjectId, 'basalt check a', p.authOwner);
        const b = await options.auth.testLogin(p.authProjectId, 'basalt check b', p.authOwner);
        const signing = await options.auth.signing(p.authProjectId, p.authOwner);
        const now = Math.floor(Date.now() / 1000);
        const results = await runChecks(parseContract(p.approvedContract), {
          url: `${(options.selfUrl ?? base).replace(/\/+$/, '')}/p/${p.id}`,
          tokenA: a.token,
          tokenB: b.token,
          userA: a.userId,
          forged: resign(a.token, randomBytes(48).toString('base64url')),
          expired: resign(a.token, signing.secret, { iat: now - 7200, exp: now - 3600 }),
        });
        await projects.saveCheck(p.id, sha256(JSON.stringify(p.approvedContract)), results, findings);
        const passed = results.filter((r) => r.passed).length;
        return sendJson(res, 200, {
          ok: true,
          passed,
          failed: results.length - passed,
          results,
          codeFindings: findings === null ? null : findings.length,
          receiptUrl: `${base}/owner/${p.id}/check?k=${await projects.ownerViewKey(p)}`,
        });
      } finally {
        checking.delete(p.id);
      }
    }

    throw new HttpError(404, 'Unknown route.');
  }

  async function handleApprove(req: IncomingMessage, res: ServerResponse, id: string, url: URL): Promise<void> {
    const form = req.method === 'POST' ? new URLSearchParams(await readBody(req, 4096)) : null;
    const token = form ? form.get('t') : url.searchParams.get('t');
    const approval = await projects.getApproval(id, token);
    if (!approval) return sendHtml(res, 404, page('Link not found', '<h1>This link doesn\'t work</h1><p>It may be mistyped or expired. Ask Claude for a new one.</p>'));
    const p = (await projects.get(approval.projectId))!;

    if (approval.status !== 'pending') {
      const word = { approved: 'already approved', rejected: 'already turned down', replaced: 'replaced by a newer request', pending: '' }[approval.status];
      return sendHtml(res, 410, page('Already decided', `<h1>This request was ${word}</h1><p>Ask Claude for the latest link if you need one.</p>`));
    }

    if (approval.kind === 'admin') {
      const who = esc(approval.admin!.label);
      if (form) {
        if (form.get('decision') === 'approve') {
          await projects.addAdmin(p, approval.admin!.uid);
          await projects.decide(approval, 'approved');
          return sendHtml(res, 200, page('Admin added', `<h1>Done. ${who} is now an admin of ${esc(p.name)}.</h1><p class="muted">You can close this page and go back to Claude.</p>`));
        }
        await projects.decide(approval, 'rejected');
        return sendHtml(res, 200, page('Not approved', '<h1>Nothing changed</h1><p>Nobody new can see everything. Tell Claude what you\'d like instead.</p>'));
      }
      return sendHtml(
        res,
        200,
        page(
          `Make ${approval.admin!.label} an admin`,
          `<h1>Make ${who} an admin of ${esc(p.name)}?</h1>
<div class="warn">An admin can see and change everything everyone has saved in this app. Only say yes for yourself or someone you fully trust.</div>
<form method="post"><input type="hidden" name="t" value="${esc(token!)}">
<button class="yes" name="decision" value="approve">Yes, make ${who} an admin</button>
<button class="no" name="decision" value="reject">No</button></form>`,
        ),
      );
    }

    const contract = parseContract(approval.contract);
    if (form) {
      if (form.get('decision') === 'approve') {
        try {
          await projects.apply(p, approval.contract);
        } catch (err) {
          return sendHtml(res, 409, page('Not applied', `<h1>These rules couldn't be applied</h1><p>${esc((err as Error).message)}</p><p>Nothing changed. Tell Claude what this page says and it will fix it.</p>`));
        }
        await projects.decide(approval, 'approved');
        await dropHandler(p.id);
        return sendHtml(res, 200, page('Rules are live', `<h1>Done. These rules are live for ${esc(p.name)}.</h1>${summaryHtml(contract)}<p class="muted">You can close this page and go back to Claude.</p>`));
      }
      await projects.decide(approval, 'rejected');
      return sendHtml(res, 200, page('Not approved', `<h1>Nothing changed</h1><p>Your app keeps its current rules. Tell Claude what you'd like instead.</p>`));
    }

    const why = loosens(p.approvedContract ? parseContract(p.approvedContract) : null, contract);
    return sendHtml(
      res,
      200,
      page(
        `Approve rules for ${p.name}`,
        `<h1>Who can see what in ${esc(p.name)}</h1>
<div class="warn">${why.map((w) => esc(w)).join('<br>')} Nothing changes until you say yes.</div>
${summaryHtml(contract)}
<form method="post"><input type="hidden" name="t" value="${esc(token!)}">
<button class="yes" name="decision" value="approve">Yes, use these rules</button>
<button class="no" name="decision" value="reject">No, keep things as they are</button></form>`,
      ),
    );
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    const path = url.pathname;
    try {
      if (req.method === 'GET' && path === '/healthz') return sendJson(res, 200, { ok: true });

      const appMatch = /^\/p\/([a-z0-9]{10})(\/.*)$/.exec(path);
      if (appMatch) {
        const handler = await dataHandler(appMatch[1], req);
        if (handler === 'hidden') return sendJson(res, 404, { ok: false, error: { code: 'not_found', message: 'Unknown route.' } });
        if (!handler) {
          if (req.method === 'OPTIONS') return void res.writeHead(204, { 'access-control-allow-origin': '*' }).end();
          res.setHeader('access-control-allow-origin', '*');
          return sendJson(res, 503, { ok: false, error: { code: 'unavailable', message: "This app's data rules haven't been approved yet." } });
        }
        return await handler(req, res, appMatch[2]);
      }

      const mapMatch = /^\/owner\/([a-z0-9]{10})$/.exec(path);
      if (mapMatch && req.method === 'GET') {
        const p = await projects.checkOwnerViewKey(mapMatch[1], url.searchParams.get('k'));
        if (!p) return sendHtml(res, 404, page('Link not found', "<h1>This link doesn't work</h1><p>Ask Claude for your data map link again.</p>"));
        if (!p.approvedContract) return sendHtml(res, 200, page(p.name, `<h1>${esc(p.name)} has no rules yet</h1><p>Once you approve them, this page shows where everything lives.</p>`));
        return sendHtml(res, 200, renderMap(p.name, parseContract(p.approvedContract), await projects.stats(p)));
      }

      const receiptMatch = /^\/owner\/([a-z0-9]{10})\/check$/.exec(path);
      if (receiptMatch && req.method === 'GET') {
        const p = await projects.checkOwnerViewKey(receiptMatch[1], url.searchParams.get('k'));
        if (!p) return sendHtml(res, 404, page('Link not found', "<h1>This link doesn't work</h1><p>Ask Claude for your safety receipt link again.</p>"));
        const check = await projects.latestCheck(p.id);
        if (!check) return sendHtml(res, 200, page(p.name, `<h1>${esc(p.name)} hasn't been checked yet</h1><p>Ask Claude to run the safety check.</p>`));
        return sendHtml(res, 200, renderReceipt(p.name, check, check.contractHash !== sha256(JSON.stringify(p.approvedContract))));
      }

      const approveMatch = /^\/approve\/([a-z0-9]{16})$/.exec(path);
      if (approveMatch && (req.method === 'GET' || req.method === 'POST')) return await handleApprove(req, res, approveMatch[1], url);

      if (path.startsWith('/api/')) return await handleApi(req, res, path);
      return sendJson(res, 404, { ok: false, error: { code: 'not_found', message: 'Unknown route.' } });
    } catch (err) {
      if (res.headersSent) return void res.end();
      if (err instanceof HttpError) return sendJson(res, err.status, { ok: false, error: { message: err.message } });
      if (err instanceof BasaltError) return sendJson(res, 400, { ok: false, error: { code: err.code, message: err.message } });
      console.error('basalt cloud:', err);
      return sendJson(res, 500, { ok: false, error: { message: 'Something went wrong on our side. Try again.' } });
    }
  });

  return { server: setServerLimits(server), close: async () => Promise.all([...handlers.keys()].map(dropHandler)) };
}

if (import.meta.main) {
  const env = (name: string) => {
    const v = process.env[name];
    if (!v) throw new Error(`Set ${name} in .env (see .env.example).`);
    return v;
  };
  const { AuthLink } = await import('./auth.ts');
  const auth = new AuthLink({ url: env('AUTH_URL'), platformKey: env('AUTH_PLATFORM_KEY'), masterKey: env('CLOUD_MASTER_KEY') });
  const projects = new Projects({ adminUrl: env('CLOUD_ADMIN_URL'), dbHost: env('CLOUD_DB_HOST'), masterKey: env('CLOUD_MASTER_KEY') }, auth);
  await projects.init();
  const port = Number(process.env.PORT ?? 8790);
  const host = process.env.HOST ?? '127.0.0.1';
  const { server } = createCloudServer({
    projects,
    auth,
    platformKey: process.env.CLOUD_PLATFORM_KEY || undefined,
    publicUrl: process.env.PUBLIC_URL ?? `http://${host}:${port}`,
    selfUrl: `http://127.0.0.1:${port}`,
    trustProxy: process.env.TRUST_PROXY === '1',
  });
  server.listen(port, host, () => console.log(`basalt cloud on http://${host}:${port}`));

  // Sessions ended in Basalt Auth stop working in every app database within ~10 seconds.
  const sync = async () => {
    for (const id of await projects.linkedProjectIds().catch(() => [])) {
      const p = await projects.get(id);
      if (p) await projects.syncRevocations(p).catch((err) => console.error('basalt cloud: revocation sync failed', id, (err as Error).message));
    }
  };
  setInterval(() => void sync(), 10_000).unref();
}
