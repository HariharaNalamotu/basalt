/**
 * What the MCP tools need from the platform. The Basalt platform's MCP gateway implements this
 * for the authenticated workspace; `HttpControlPlane` talks to the auth service directly.
 */
export interface ControlPlane {
  listProjects(): Promise<{ projects: Project[] }>;
  createProject(input: { name: string; allowedOrigins?: string[]; settings?: Record<string, unknown> }): Promise<{ project: Project; secretKey: string }>;
  getProject(id: string): Promise<{ project: Project }>;
  updateProject(id: string, patch: { name?: string; allowedOrigins?: string[]; settings?: Record<string, unknown> }): Promise<{ project: Project }>;
  rotateSecretKey(id: string): Promise<{ secretKey: string }>;
  rotateSigningKey(id: string): Promise<{ kid: string }>;
  listUsers(id: string, q: { limit?: number; cursor?: string; email?: string }): Promise<{ users: unknown[]; nextCursor: string | null }>;
  getUser(id: string, userId: string): Promise<{ user: unknown }>;
  updateUser(id: string, userId: string, patch: { metadata?: Record<string, unknown>; disabled?: boolean }): Promise<{ user: unknown }>;
  deleteUser(id: string, userId: string): Promise<void>;
  revokeSessions(id: string, userId: string): Promise<{ revoked: number }>;
  listEvents(id: string, q: { userId?: string; limit?: number; before?: number }): Promise<{ events: unknown[] }>;
  /** SQL that installs the data-grant verifier and the project's key into an app database. Contains a secret. */
  getDataProtectionSql(id: string): Promise<string>;
  /**
   * If implemented, the platform runs the install SQL against the app's database itself (as the
   * admin role) so neither the key nor the SQL is ever shown to the agent.
   */
  installDataProtection?(projectId: string): Promise<{ database: string; appRole: string }>;
  /**
   * If implemented, new/rotated secret keys are written straight into the app's secret store and
   * never shown to the agent. Returns the environment variable name the app will see.
   */
  storeProjectSecret?(projectId: string, secretKey: string): Promise<{ envVar: string }>;
  /** Public base URL of the auth service (for BASALT_AUTH_URL). */
  authUrl: string;
}

export interface Project {
  id: string;
  name: string;
  allowedOrigins: string[];
  settings: Record<string, unknown>;
  secretKeyHint: string;
  issuer: string;
  jwksUrl: string;
  createdAt: string;
  updatedAt: string;
}

export class ControlPlaneError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export class HttpControlPlane implements ControlPlane {
  constructor(
    readonly authUrl: string,
    private readonly platformKey: string,
    private readonly ownerId: string,
    private readonly fetchImpl: typeof fetch = (i, init) => globalThis.fetch(i, init),
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.authUrl.replace(/\/+$/, '')}/v1/platform${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.platformKey}`,
        'x-basalt-owner': this.ownerId,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const err = ((await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string; details?: unknown } }).error;
      throw new ControlPlaneError(err?.code ?? 'error', err?.message ?? `HTTP ${res.status}`, res.status, err?.details);
    }
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  getDataProtectionSql = async (id: string) => {
    const res = await this.fetchImpl(`${this.authUrl.replace(/\/+$/, '')}/v1/platform${this.p(id)}/data-protection/install.sql`, {
      headers: { authorization: `Bearer ${this.platformKey}`, 'x-basalt-owner': this.ownerId },
    });
    if (!res.ok) {
      const err = ((await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } }).error;
      throw new ControlPlaneError(err?.code ?? 'error', err?.message ?? `HTTP ${res.status}`, res.status);
    }
    return res.text();
  };

  private p = (id: string) => `/projects/${encodeURIComponent(id)}`;

  listProjects = () => this.call<{ projects: Project[] }>('GET', '/projects');
  createProject = (input: Parameters<ControlPlane['createProject']>[0]) => this.call<{ project: Project; secretKey: string }>('POST', '/projects', input);
  getProject = (id: string) => this.call<{ project: Project }>('GET', this.p(id));
  updateProject = (id: string, patch: Parameters<ControlPlane['updateProject']>[1]) => this.call<{ project: Project }>('PATCH', this.p(id), patch);
  rotateSecretKey = (id: string) => this.call<{ secretKey: string }>('POST', `${this.p(id)}/rotate-secret-key`, {});
  rotateSigningKey = (id: string) => this.call<{ kid: string }>('POST', `${this.p(id)}/rotate-signing-key`, {});
  listUsers = (id: string, q: { limit?: number; cursor?: string; email?: string }) =>
    this.call<{ users: unknown[]; nextCursor: string | null }>('GET', `${this.p(id)}/users?${query(q)}`);
  getUser = (id: string, userId: string) => this.call<{ user: unknown }>('GET', `${this.p(id)}/users/${encodeURIComponent(userId)}`);
  updateUser = (id: string, userId: string, patch: { metadata?: Record<string, unknown>; disabled?: boolean }) =>
    this.call<{ user: unknown }>('PATCH', `${this.p(id)}/users/${encodeURIComponent(userId)}`, patch);
  deleteUser = (id: string, userId: string) => this.call<void>('DELETE', `${this.p(id)}/users/${encodeURIComponent(userId)}`);
  revokeSessions = (id: string, userId: string) =>
    this.call<{ revoked: number }>('POST', `${this.p(id)}/users/${encodeURIComponent(userId)}/revoke-sessions`, {});
  listEvents = (id: string, q: { userId?: string; limit?: number; before?: number }) =>
    this.call<{ events: unknown[] }>('GET', `${this.p(id)}/events?${query(q)}`);
}

function query(q: Record<string, string | number | undefined>) {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') s.set(k, String(v));
  return s.toString();
}
