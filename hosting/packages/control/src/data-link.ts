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

async function cloudCall(cfg: DataLinkConfig, method: string, path: string, body: unknown, f: typeof fetch, key = cfg.platformKey): Promise<any> {
  const res = await f(`${cfg.url.replace(/\/+$/, '')}${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
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
export async function deleteDataProject(cfg: DataLinkConfig, envId: string, f: typeof fetch = fetch, recordedProjectId?: string | null): Promise<void> {
  const gone = (err: unknown) => {
    if (!(err instanceof CloudError && err.status === 404)) throw err;
    return true;
  };
  let found = true;
  if (/^[A-Za-z0-9_-]{1,64}$/.test(envId)) await cloudCall(cfg, 'DELETE', `/api/platform/environments/${envId}`, undefined, f).catch((err) => (found = !gone(err)));
  // Projects made before environment ids were sent are only known by their recorded id.
  if (!found && recordedProjectId && PROJECT_ID.test(recordedProjectId)) {
    await cloudCall(cfg, 'DELETE', `/api/platform/projects/${recordedProjectId}`, undefined, f).catch(gone);
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
