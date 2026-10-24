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

async function cloudCall(cfg: DataLinkConfig, method: string, path: string, body: unknown, f: typeof fetch): Promise<any> {
  const res = await f(`${cfg.url.replace(/\/+$/, '')}${path}`, {
    method,
    headers: { authorization: `Bearer ${cfg.platformKey}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const json = (await res.json().catch(() => null)) as { ok?: boolean; error?: { message?: string } } | null;
  if (!res.ok || !json?.ok) throw new Error(`Basalt Cloud: ${json?.error?.message ?? `answered ${res.status}`}`);
  return json;
}

export async function createDataProject(
  cfg: DataLinkConfig,
  p: { name: string; authProjectId: string; authOwner: string },
  f: typeof fetch = fetch,
): Promise<{ projectId: string; adminKey: string }> {
  const out = await cloudCall(cfg, 'POST', '/api/platform/projects', { name: p.name, authProjectId: p.authProjectId, authOwner: p.authOwner }, f);
  const projectId = out.project?.id;
  if (typeof projectId !== 'string' || !PROJECT_ID.test(projectId) || typeof out.adminKey !== 'string') {
    throw new Error('Basalt Cloud sent back something unexpected.');
  }
  return { projectId, adminKey: out.adminKey };
}

export async function deleteDataProject(cfg: DataLinkConfig, projectId: string, f: typeof fetch = fetch): Promise<void> {
  if (!PROJECT_ID.test(projectId)) return;
  await cloudCall(cfg, 'DELETE', `/api/platform/projects/${projectId}`, undefined, f);
}

/** Where the edge sends /_basalt/data for an environment, or null when it has no data project. */
export function dataUrlFor(cfg: DataLinkConfig | null, projectId: string | null): string | null {
  if (!cfg || !projectId || !PROJECT_ID.test(projectId)) return null;
  return `${cfg.url.replace(/\/+$/, '')}/p/${projectId}`;
}
