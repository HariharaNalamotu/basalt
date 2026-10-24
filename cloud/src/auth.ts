// Basalt Cloud's link to Basalt Auth, the one service that issues login tokens.
//
// Every Cloud app gets an Auth project. The app's database is set up to accept exactly the data
// tokens that project issues (same signing secret and issuer), so the person signed in to the
// app is the person the database checks. Test logins are real Auth users, and sessions Auth ends
// (sign out, password change, stolen token) are synced into the database so they stop working there too.

import { createHmac } from 'node:crypto';

export interface AuthLinkOptions {
  // Auth service base URL as Cloud reaches it, like http://auth:8787.
  url: string;
  // Platform key for Auth's control plane.
  platformKey: string;
  // Derives test users' passwords. Cloud's master key.
  masterKey: string;
  // Workspace name Cloud's projects live under in Auth.
  owner?: string;
}

export interface Signing {
  secret: string;
  issuer: string;
  maxTokenSeconds: number;
}

export class AuthLink {
  #o: AuthLinkOptions;
  #owner: string;
  #testTokens = new Map<string, { userId: string; token: string; expiresAt: number }>();

  constructor(options: AuthLinkOptions) {
    this.#o = options;
    this.#owner = options.owner ?? 'basalt-cloud';
  }

  async #platform<T>(method: string, path: string, body?: unknown, owner = this.#owner): Promise<T> {
    const res = await fetch(`${this.#o.url.replace(/\/+$/, '')}/v1/platform${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.#o.platformKey}`,
        'x-basalt-owner': owner,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {
      throw new Error("Couldn't reach Basalt Auth.");
    });
    const json = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
    if (!res.ok) {
      const err = new Error(json.error?.message ?? `Basalt Auth answered ${res.status}.`) as Error & { status: number; code?: string };
      err.status = res.status;
      err.code = json.error?.code;
      throw err;
    }
    return json as T;
  }

  async createProject(name: string): Promise<{ projectId: string; signing: Signing }> {
    const { project } = await this.#platform<{ project: { id: string } }>('POST', '/projects', { name: name.slice(0, 100), allowedOrigins: [] });
    return { projectId: project.id, signing: await this.signing(project.id) };
  }

  /** The owner a Cloud project's Auth project lives under (Cloud's own, or a hosting workspace). */
  get defaultOwner() {
    return this.#owner;
  }

  async signing(projectId: string, owner = this.#owner): Promise<Signing> {
    const s = await this.#platform<{ secret: string; issuer: string; maxTokenSeconds: number }>('GET', `/projects/${projectId}/data-protection/signing`, undefined, owner);
    return { secret: s.secret, issuer: s.issuer, maxTokenSeconds: s.maxTokenSeconds };
  }

  async deleteProject(projectId: string): Promise<void> {
    await this.#platform('DELETE', `/projects/${projectId}`).catch(() => {});
  }

  #testEmail(who: string): string {
    return `${who.toLowerCase().trim().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '') || 'test'}@test.basalt.invalid`;
  }

  #testPassword(projectId: string, who: string): string {
    // Keyed on the email, so names that map to the same test person share one password.
    return `Tp-${createHmac('sha256', this.#o.masterKey).update(`test-user|${projectId}|${this.#testEmail(who)}`).digest('base64url')}`;
  }

  /**
   * Signs in as a named test person (created on first use, the same person every time) and
   * returns their real data token. Tokens are reused until two minutes before they expire.
   */
  async testLogin(projectId: string, who: string, owner = this.#owner): Promise<{ userId: string; token: string; expiresInSeconds: number }> {
    const key = `${projectId}|${this.#testEmail(who)}`;
    const cached = this.#testTokens.get(key);
    if (cached && cached.expiresAt - Date.now() > 120_000) {
      return { userId: cached.userId, token: cached.token, expiresInSeconds: Math.floor((cached.expiresAt - Date.now()) / 1000) };
    }
    const email = this.#testEmail(who);
    const password = this.#testPassword(projectId, who);
    await this.#platform('POST', `/projects/${projectId}/users`, { email, password }, owner).catch((err: { status?: number }) => {
      if (err.status !== 409) throw err;
    });
    // Sign in like a native app (no Origin): Auth returns the tokens in the body.
    const res = await fetch(`${this.#o.url.replace(/\/+$/, '')}/v1/projects/${projectId}/signin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => ({}))) as { accessToken?: string; user?: { id: string }; error?: { message?: string } };
    if (!res.ok || !body.accessToken || !body.user) throw new Error(body.error?.message ?? `Test sign in failed (${res.status}).`);
    const claims = JSON.parse(Buffer.from(body.accessToken.split('.')[1]!, 'base64url').toString('utf8')) as { bdg: string; exp: number };
    const entry = { userId: body.user.id, token: claims.bdg, expiresAt: claims.exp * 1000 };
    this.#testTokens.set(key, entry);
    if (this.#testTokens.size > 5000) this.#testTokens.delete(this.#testTokens.keys().next().value!);
    return { userId: entry.userId, token: entry.token, expiresInSeconds: Math.floor((entry.expiresAt - Date.now()) / 1000) };
  }

  /** Sessions Auth ended early, oldest first. */
  async revocations(projectId: string, opts: { since?: Date; cursor?: string }, owner = this.#owner) {
    const q = new URLSearchParams();
    if (opts.cursor) q.set('cursor', opts.cursor);
    else if (opts.since) q.set('since', opts.since.toISOString());
    return this.#platform<{ revocations: Array<{ sessionId: string; revokedAt: string }>; hasMore: boolean; nextCursor: string | null }>(
      'GET',
      `/projects/${projectId}/data-protection/revocations?${q}`,
      undefined,
      owner,
    );
  }
}
