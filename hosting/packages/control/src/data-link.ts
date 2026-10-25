/**
 * Link to Basalt Cloud, which hosts the Data block. Every environment gets its own Cloud data
 * project bound to the environment's Auth project, so the signed-in user's token is the one its
 * database checks. The edge serves it on the app's own site at /_basalt/data.
 */

export interface DataLinkConfig {
  /** Cloud base URL on the platform network, like http://cloud:8790. */
  url: string;
  /** Cloud's CLOUD_PLATFORM_KEY. */
  platformKey: string;
}

const PROJECT_ID = /^[a-z0-9]{10}$/;

class CloudError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function cloudCall(cfg: DataLinkConfig, method: string, path: string, body: unknown, f: typeof fetch, key = cfg.platformKey, timeoutMs = 30_000): Promise<any> {
  const res = await f(`${cfg.url.replace(/\/+$/, '')}${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = (await res.json().catch(() => null)) as { ok?: boolean; error?: { message?: string } } | null;
  if (!res.ok || !json?.ok) throw new CloudError(`Basalt Cloud: ${json?.error?.message ?? `answered ${res.status}`}`, res.status);
  return json;
}

export async function createDataProject(
  cfg: DataLinkConfig,
  p: { name: string; authProjectId: string; authOwner: string; externalId: string },
  f: typeof fetch = fetch,
): Promise<{ projectId: string; adminKey: string }> {
  // externalId (the environment id) makes this safe to retry: Cloud returns the same project.
  const out = await cloudCall(cfg, 'POST', '/api/platform/projects', { name: p.name, authProjectId: p.authProjectId, authOwner: p.authOwner, externalId: p.externalId }, f);
  const projectId = out.project?.id;
  if (typeof projectId !== 'string' || !PROJECT_ID.test(projectId) || typeof out.adminKey !== 'string') {
    throw new Error('Basalt Cloud sent back something unexpected.');
  }
  return { projectId, adminKey: out.adminKey };
}

/**
 * Deletes an environment's data project by the environment id, so one whose creation reply was
 * lost is found too. Already gone counts as done. Any other failure throws, so the caller can
 * keep its record and retry.
 */
// Dropping a database can be slow on a busy machine, so deletes wait longer than everyday calls.
const DELETE_TIMEOUT_MS = 120_000;

export async function deleteDataProject(cfg: DataLinkConfig, envId: string, f: typeof fetch = fetch, recordedProjectId?: string | null): Promise<void> {
  const gone = (err: unknown) => {
    if (!(err instanceof CloudError && err.status === 404)) throw err;
    return true;
  };
  let found = true;
  if (/^[A-Za-z0-9_-]{1,64}$/.test(envId)) await cloudCall(cfg, 'DELETE', `/api/platform/environments/${envId}`, undefined, f, cfg.platformKey, DELETE_TIMEOUT_MS).catch((err) => (found = !gone(err)));
  // Projects made before environment ids were sent are only known by their recorded id.
  if (!found && recordedProjectId && PROJECT_ID.test(recordedProjectId)) {
    await cloudCall(cfg, 'DELETE', `/api/platform/projects/${recordedProjectId}`, undefined, f, cfg.platformKey, DELETE_TIMEOUT_MS).catch(gone);
  }
}

export type DataRulesResult =
  | { status: 'live'; summary: string }
  | { status: 'waiting_for_owner'; approveUrl: string; why: string[]; summary: string };

/**
 * Sets what an environment's data project saves and who can see it. Test environments (only
 * test data at stake) take the rules right away. Production goes through the owner's approval
 * page whenever the rules would show data to more people.
 */
export async function setDataRules(
  cfg: DataLinkConfig,
  env: { projectId: string; adminKey: string; kind: 'preview' | 'staging' | 'production' },
  contract: unknown,
  f: typeof fetch = fetch,
): Promise<DataRulesResult> {
  if (!PROJECT_ID.test(env.projectId)) throw new Error('This environment has no data project.');
  if (env.kind !== 'production') {
    const out = await cloudCall(cfg, 'PUT', `/api/platform/projects/${env.projectId}/rules`, { contract }, f);
    return { status: 'live', summary: String(out.summary ?? '') };
  }
  const out = await cloudCall(cfg, 'PUT', '/api/projects/me/rules', { contract }, f, env.adminKey);
  if (out.status === 'waiting_for_owner') {
    return { status: 'waiting_for_owner', approveUrl: String(out.approveUrl), why: Array.isArray(out.why) ? out.why.map(String) : [], summary: String(out.summary ?? '') };
  }
  return { status: 'live', summary: String(out.summary ?? '') };
}

/** Where the edge sends /_basalt/data for an environment, or null when it has no data project. */
export function dataUrlFor(cfg: DataLinkConfig | null, projectId: string | null): string | null {
  if (!cfg || !projectId || !PROJECT_ID.test(projectId)) return null;
  return `${cfg.url.replace(/\/+$/, '')}/p/${projectId}`;
}

/** A change waiting for the owner's yes, and the page where they give it. */
export interface PendingApproval {
  kind: 'rules' | 'admin' | 'remove_admin';
  label: string;
  approveUrl: string;
}

export interface DataStatus {
  status: 'live' | 'waiting_for_owner' | 'no_rules';
  rules: string;
  waitingForOwner: boolean;
  mapUrl: string | null;
  /** Approval links. Only for the owner's signed in dashboard and Claude, never app code. */
  pending: PendingApproval[];
}

const PENDING_KINDS = new Set(['rules', 'admin', 'remove_admin']);

function pendingFrom(raw: unknown): PendingApproval[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((a) => a && PENDING_KINDS.has(a.kind) && typeof a.label === 'string' && typeof a.approveUrl === 'string' && /^https?:\/\//.test(a.approveUrl))
    .map((a) => ({ kind: a.kind, label: a.label.slice(0, 120), approveUrl: a.approveUrl }));
}

/** An environment's data rules in plain English, the owner's data map link and what's waiting for them. */
export async function dataStatus(cfg: DataLinkConfig, adminKey: string, f: typeof fetch = fetch): Promise<DataStatus> {
  const { project: p } = await cloudCall(cfg, 'GET', '/api/projects/me', undefined, f, adminKey);
  return {
    status: p.status === 'live' || p.status === 'waiting_for_owner' ? p.status : 'no_rules',
    rules: String(p.rules ?? ''),
    waitingForOwner: Boolean(p.waitingForOwner),
    mapUrl: typeof p.mapUrl === 'string' ? p.mapUrl : null,
    pending: pendingFrom(p.pending),
  };
}

/** Asks the owner to make someone an admin of an environment's data (always needs their approval). */
export async function requestDataAdmin(cfg: DataLinkConfig, adminKey: string, who: { email?: string; who?: string; userId?: string; label?: string }, f: typeof fetch = fetch): Promise<{ approveUrl: string; userId: string }> {
  const out = await cloudCall(cfg, 'POST', '/api/projects/me/admins', who, f, adminKey);
  return { approveUrl: String(out.approveUrl), userId: String(out.userId) };
}

/** Asks the owner to take someone's admin access away (always needs their approval). */
export async function requestRemoveDataAdmin(cfg: DataLinkConfig, adminKey: string, who: { email?: string; who?: string; userId?: string }, f: typeof fetch = fetch): Promise<{ approveUrl: string; userId: string }> {
  const out = await cloudCall(cfg, 'POST', '/api/projects/me/admins/remove', who, f, adminKey);
  return { approveUrl: String(out.approveUrl), userId: String(out.userId) };
}

export interface GuardFinding {
  rule: string;
  file: string;
  line: number;
  problem: string;
  fix: string;
}

export type GuardCheck = { id: string; title: string; passed: boolean; detail: string; table?: string };

export interface GuardResult {
  passed: number;
  failed: number;
  results: GuardCheck[];
  /** The checks that didn't pass, each saying in plain words what got through. */
  failures: GuardCheck[];
  /** The owner's safety receipt page. */
  receiptUrl: string;
}

/**
 * Runs Guard against an environment's data: two real test people and a stranger try to reach
 * data that isn't theirs. `scan` is the local code scan (data kept outside Basalt), or null.
 */
export async function runDataCheck(cfg: DataLinkConfig, adminKey: string, scan: GuardFinding[] | null, f: typeof fetch = fetch): Promise<GuardResult> {
  const out = await cloudCall(cfg, 'POST', '/api/projects/me/check', scan === null ? {} : { scan }, f, adminKey);
  const results: GuardCheck[] = Array.isArray(out.results) ? out.results : [];
  return { passed: Number(out.passed ?? 0), failed: Number(out.failed ?? 0), results, failures: results.filter((r) => r.passed !== true), receiptUrl: String(out.receiptUrl ?? '') };
}
