import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Log } from '@basalt/host-shared';

const run = promisify(execFile);
const PACKAGES_DIR = process.env.BASALT_PACKAGES_DIR ?? '/opt/basalt/packages';

/**
 * Publishes the bundled @basalt/* packages (packed at image build) to the platform registry so
 * user builds and agents' local installs can depend on them. Idempotent: existing versions are kept.
 */
export async function publishBasaltPackages(registryUrl: string, log: Log) {
  const files = (await readdir(PACKAGES_DIR).catch(() => [] as string[])).filter((f) => f.endsWith('.tgz'));
  if (!files.length) return;
  const reg = registryUrl.replace(/\/+$/, '');
  const password = process.env.REGISTRY_PUBLISH_PASSWORD;
  if (!password) throw new Error('REGISTRY_PUBLISH_PASSWORD is required to publish @basalt packages');
  // Register once (max_users: 1). Afterwards the account exists (409) and Basic auth is used.
  for (let i = 0; i < 30; i++) {
    const res = await fetch(`${reg}/-/user/org.couchdb.user:basalt-platform`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'basalt-platform', password }),
    }).catch(() => null);
    if (res && (res.ok || res.status === 409)) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  const basic = Buffer.from(`basalt-platform:${password}`).toString('base64');
  const dir = await mkdtemp(path.join(tmpdir(), 'npmrc-'));
  const npmrc = path.join(dir, '.npmrc');
  const hostPart = reg.replace(/^https?:/, '');
  await writeFile(npmrc, `registry=${reg}/\n${hostPart}/:_auth=${basic}\n${hostPart}/:always-auth=true\n`, { mode: 0o600 });
  try {
    for (const f of files.sort()) {
      try {
        await run('npm', ['publish', path.join(PACKAGES_DIR, f), '--userconfig', npmrc, '--registry', `${reg}/`, '--access', 'public'], { timeout: 60_000 });
        log.info('package_published', { file: f });
      } catch (err) {
        const msg = String((err as { stderr?: string }).stderr ?? err);
        if (/EPUBLISHCONFLICT|cannot publish over|409|already present|E403/i.test(msg)) continue;
        log.warn('package_publish_failed', { file: f, error: msg.slice(0, 500) });
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
