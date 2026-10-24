import { chown, cp, lstat, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, constants as zc, gzip } from 'node:zlib';
import * as tar from 'tar';
import type { Ctx } from './ctx.js';
import { hardened } from './docker.js';
import type { DeploymentRow } from './runtime.js';
import { imageTag } from './naming.js';
import { scanSource } from './scanner.js';
import { extractSource } from './sources.js';

const gz = promisify(gzip);
const br = promisify(brotliCompress);
const DEFAULT_TEST_SCRIPT = /no test specified/;
const COMPRESSIBLE = /\.(html|js|mjs|css|json|svg|txt|xml|webmanifest|map|wasm)$/;

export interface Manifest {
  backend: { entry: string } | null;
  frontend: { output: string; build: boolean } | null;
  migrations: boolean;
  e2e: boolean;
  lockfile: boolean;
  scripts: string[];
}

export interface Step {
  name: string;
  status: 'passed' | 'failed' | 'skipped' | 'warning';
  ms?: number;
  output?: string;
}

const exists = (p: string) => stat(p).then(() => true, () => false);

/** Detects what to build: explicit basalt.json wins, otherwise Basalt conventions. */
export async function detectManifest(work: string): Promise<Manifest> {
  const pkg = JSON.parse(await readFile(path.join(work, 'package.json'), 'utf8').catch(() => '{}')) as { scripts?: Record<string, string> };
  const cfg = JSON.parse(await readFile(path.join(work, 'basalt.json'), 'utf8').catch(() => '{}')) as {
    backend?: { entry?: string } | false;
    frontend?: { output?: string } | false;
  };
  const scripts = Object.keys(pkg.scripts ?? {});
  let backend: Manifest['backend'] = null;
  if (cfg.backend !== false) {
    for (const candidate of cfg.backend?.entry ? [cfg.backend.entry] : ['server/index.ts', 'server/index.js', 'server/index.mjs']) {
      if (/^[\w./-]+$/.test(candidate) && !candidate.includes('..') && (await exists(path.join(work, candidate)))) {
        backend = { entry: candidate };
        break;
      }
    }
  }
  let frontend: Manifest['frontend'] = null;
  if (cfg.frontend !== false) {
    if (cfg.frontend?.output) frontend = { output: cfg.frontend.output, build: scripts.includes('build') };
    else if (scripts.includes('build')) frontend = { output: 'dist', build: true };
    else if (await exists(path.join(work, 'public/index.html'))) frontend = { output: 'public', build: false };
    if (frontend && (!/^[\w./-]+$/.test(frontend.output) || frontend.output.includes('..'))) throw new Error('frontend.output must be a relative path inside the project.');
  }
  const e2eDir = path.join(work, 'e2e');
  const e2e = (await exists(e2eDir)) && (await readdir(e2eDir)).some((f) => /\.(spec|test)\.[cm]?[jt]s$/.test(f));
  const migDir = path.join(work, 'db/migrations');
  const migrations = (await exists(migDir)) && (await readdir(migDir)).some((f) => f.endsWith('.sql'));
  return { backend, frontend, migrations, e2e, lockfile: await exists(path.join(work, 'package-lock.json')), scripts };
}

export class Pipeline {
  private running = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly ctx: Ctx) {}

  workDir(depId: string) {
    return path.join(this.ctx.cfg.DATA_DIR, 'builds', depId, 'work');
  }

  private async slot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= this.ctx.cfg.MAX_CONCURRENT_BUILDS) await new Promise<void>((r) => this.queue.push(r));
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      this.queue.shift()?.();
    }
  }

  private async setSteps(depId: string, steps: Step[], status?: string, extra: Record<string, unknown> = {}) {
    const sets = ['steps = $2'];
    const params: unknown[] = [depId, JSON.stringify(steps)];
    if (status) {
      params.push(status);
      sets.push(`status = $${params.length}`);
      if (status === 'built' || status === 'failed') sets.push('finished_at = now()');
    }
    for (const [k, v] of Object.entries(extra)) {
      params.push(typeof v === 'object' && v !== null ? JSON.stringify(v) : v);
      sets.push(`${k} = $${params.length}`);
    }
    await this.ctx.db.query(`UPDATE deployments SET ${sets.join(', ')} WHERE id = $1`, params);
  }

  /** Runs one step in a fresh, hardened, network-restricted container. */
  private async runStep(depId: string, name: string, script: string, deadline: number): Promise<{ code: number; output: string; ms: number }> {
    const started = Date.now();
    const cname = `basalt-build-${depId}-${name}`;
    await this.ctx.docker.remove(cname).catch(() => {});
    await this.ctx.docker.createContainer(cname, {
      Image: this.ctx.cfg.BUILD_IMAGE,
      User: '10001:10001',
      WorkingDir: '/work',
      Cmd: ['sh', '-c', script],
      Env: [
        `npm_config_registry=${this.ctx.cfg.REGISTRY_URL}`,
        'npm_config_replace_registry_host=always',
        'npm_config_cache=/tmp/npm-cache',
        'npm_config_update_notifier=false',
        'HOME=/tmp',
        'CI=true',
      ],
      Labels: { 'basalt.kind': 'build', 'basalt.deployment': depId },
      HostConfig: hardened({
        memoryMb: this.ctx.cfg.BUILD_MEMORY_MB,
        cpus: 2,
        pids: 1024,
        network: this.ctx.cfg.BUILD_NETWORK,
        tmpfsMb: 512,
        mounts: [{ Type: 'volume', Source: this.ctx.cfg.DATA_VOLUME, Target: '/work', VolumeOptions: { Subpath: `builds/${depId}/work` } }],
      }),
    });
    await this.ctx.docker.start(cname);
    const remaining = Math.max(1000, deadline - Date.now());
    const code = await Promise.race([this.ctx.docker.wait(cname), new Promise<number>((r) => setTimeout(() => r(-1), remaining))]);
    const output = await this.ctx.docker.logs(cname, { tail: 300 }).catch(() => '');
    await this.ctx.docker.remove(cname);
    return { code, output: (code === -1 ? `${output}\n(step timed out)` : output).slice(-16_000), ms: Date.now() - started };
  }

  /** The whole CI: extract → scan → install → audit → typecheck → lint → test → build → package. */
  build(dep: { id: string; app: string; sourcePath: string }): Promise<void> {
    return this.slot(async () => {
      const steps: Step[] = [];
      const work = this.workDir(dep.id);
      const deadline = Date.now() + this.ctx.cfg.BUILD_TIMEOUT_MINUTES * 60_000;
      const fail = async (msg: string) => {
        await this.setSteps(dep.id, steps, 'failed', { error: msg.slice(0, 4000) });
      };
      try {
        await this.setSteps(dep.id, steps, 'building');
        const t0 = Date.now();
        const { files } = await extractSource(dep.sourcePath, work);
        steps.push({ name: 'extract', status: 'passed', ms: Date.now() - t0, output: `${files} files` });

        const t1 = Date.now();
        const scan = await scanSource(work);
        const fmt = (f: (typeof scan.blocking)[number]) => `${f.severity.toUpperCase()} ${f.file}:${f.line} [${f.rule}] ${f.problem} Fix: ${f.fix}`;
        if (scan.blocking.length) {
          steps.push({ name: 'security-scan', status: 'failed', ms: Date.now() - t1, output: scan.blocking.map(fmt).join('\n') });
          return fail(`Security scan found ${scan.blocking.length} blocking issue(s).`);
        }
        steps.push({ name: 'security-scan', status: scan.warnings.length ? 'warning' : 'passed', ms: Date.now() - t1, output: scan.warnings.map(fmt).join('\n') || 'no issues' });

        const manifest = await detectManifest(work);
        if (!(await exists(path.join(work, 'package.json')))) {
          steps.push({ name: 'detect', status: 'failed', output: 'package.json is missing.' });
          return fail('No package.json in the project root.');
        }
        if (!manifest.backend && !manifest.frontend) {
          steps.push({ name: 'detect', status: 'failed', output: 'Nothing to deploy: expected server/index.ts (backend) and/or a "build" script or public/index.html (frontend).' });
          return fail('Nothing to deploy.');
        }
        steps.push({ name: 'detect', status: 'passed', output: JSON.stringify(manifest) });
        await this.setSteps(dep.id, steps, undefined, { manifest });
        await chownTree(work, 10001);

        const pkg = JSON.parse(await readFile(path.join(work, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
        const plan: Array<{ name: string; script: string | null; soft?: boolean }> = [
          { name: 'install', script: manifest.lockfile ? 'npm ci --ignore-scripts --no-audit --no-fund' : 'npm install --ignore-scripts --no-audit --no-fund' },
          { name: 'audit', script: 'npm audit --omit=dev --audit-level=critical', soft: true },
          { name: 'typecheck', script: pkg.scripts?.typecheck ? 'npm run typecheck' : null },
          { name: 'lint', script: pkg.scripts?.lint ? 'npm run lint' : null },
          { name: 'unit-tests', script: pkg.scripts?.test && !DEFAULT_TEST_SCRIPT.test(pkg.scripts.test) ? 'npm test' : null },
          { name: 'build', script: manifest.frontend?.build ? 'npm run build' : null },
          {
            name: 'package',
            script: manifest.backend
              ? `node .basalt-package.cjs && cd .basalt-out/app && ${manifest.lockfile ? 'npm ci' : 'npm install'} --omit=dev --ignore-scripts --no-audit --no-fund`
              : null,
          },
        ];
        if (!manifest.lockfile) steps.push({ name: 'lockfile', status: 'warning', output: 'No package-lock.json: dependencies resolved fresh. Commit a lockfile for reproducible builds.' });
        for (const s of plan) {
          if (!s.script) {
            steps.push({ name: s.name, status: 'skipped' });
            continue;
          }
          await this.setSteps(dep.id, [...steps, { name: s.name, status: 'passed', output: 'running…' }]);
          if (s.name === 'package') {
            // Copies the project (minus dev-only and frontend output) for a production-only install.
            const skip = ['node_modules', '.basalt-out', '.basalt-package.cjs', 'e2e', 'test-results', 'playwright-report', manifest.frontend?.output ?? ''];
            await writeFile(
              path.join(work, '.basalt-package.cjs'),
              `const fs=require('fs');const skip=new Set(${JSON.stringify(skip)});fs.rmSync('.basalt-out',{recursive:true,force:true});fs.mkdirSync('.basalt-out/app',{recursive:true});for(const e of fs.readdirSync('.')){if(!skip.has(e))fs.cpSync(e,'.basalt-out/app/'+e,{recursive:true,verbatimSymlinks:true})}`,
            );
            if (process.getuid?.() === 0) await chown(path.join(work, '.basalt-package.cjs'), 10001, 10001);
          }
          const r = await this.runStep(dep.id, s.name, s.script, deadline);
          const auditUnavailable = s.name === 'audit' && /ENOAUDIT|audit endpoint|ECONNREFUSED|EAI_AGAIN|status 5\d\d|not supported/i.test(r.output);
          if (r.code !== 0 && !(s.soft && auditUnavailable)) {
            steps.push({ name: s.name, status: 'failed', ms: r.ms, output: r.output });
            return fail(s.name === 'audit' ? 'Production dependencies have critical vulnerabilities.' : `Step "${s.name}" failed.`);
          }
          steps.push({ name: s.name, status: r.code === 0 ? 'passed' : 'warning', ms: r.ms, output: r.output.slice(-4000) });
          await this.setSteps(dep.id, steps);
        }

        const extra: Record<string, unknown> = {};
        if (manifest.frontend) {
          const t = Date.now();
          const out = path.join(work, manifest.frontend.output);
          if (!(await exists(path.join(out, 'index.html')))) {
            steps.push({ name: 'static', status: 'failed', output: `${manifest.frontend.output}/index.html was not produced.` });
            return fail('Frontend build produced no index.html.');
          }
          const dest = path.join(this.ctx.cfg.DATA_DIR, 'artifacts', dep.id, 'static');
          const n = await copyStatic(out, dest);
          steps.push({ name: 'static', status: 'passed', ms: Date.now() - t, output: `${n} files, precompressed` });
          extra.static_dir = dest;
        }
        if (manifest.backend) {
          const t = Date.now();
          const tag = imageTag(dep.app, dep.id);
          const context = await buildContext(path.join(work, '.basalt-out'), this.ctx.cfg.RUNTIME_IMAGE);
          await this.ctx.docker.build(tag, context);
          steps.push({ name: 'image', status: 'passed', ms: Date.now() - t, output: tag });
          extra.image = tag;
          await rm(path.join(work, '.basalt-out'), { recursive: true, force: true });
        }
        await this.setSteps(dep.id, steps, 'built', extra);
      } catch (err) {
        steps.push({ name: 'internal', status: 'failed', output: (err as Error).message });
        await fail(`Build error: ${(err as Error).message}`);
      }
    });
  }

  async get(depId: string): Promise<DeploymentRow | null> {
    return (await this.ctx.db.query<DeploymentRow>('SELECT * FROM deployments WHERE id = $1', [depId])).rows[0] ?? null;
  }
}

async function chownTree(dir: string, uid: number) {
  if (process.getuid?.() !== 0) return; // only possible (and needed) when the control plane runs as root
  await chown(dir, uid, uid);
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await chownTree(p, uid);
    else if (e.isFile()) await chown(p, uid, uid);
  }
}

/** Copies build output to the artifact store (regular files only) and precompresses text assets. */
async function copyStatic(src: string, dest: string): Promise<number> {
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  let n = 0;
  async function walk(rel: string) {
    for (const e of await readdir(path.join(src, rel), { withFileTypes: true })) {
      const r = path.join(rel, e.name);
      const st = await lstat(path.join(src, r));
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        await mkdir(path.join(dest, r), { recursive: true });
        await walk(r);
      } else if (st.isFile()) {
        await cp(path.join(src, r), path.join(dest, r));
        n++;
        if (COMPRESSIBLE.test(e.name) && st.size > 1024) {
          const data = await readFile(path.join(src, r));
          await writeFile(path.join(dest, `${r}.gz`), await gz(data, { level: 9 }));
          await writeFile(path.join(dest, `${r}.br`), await br(data, { params: { [zc.BROTLI_PARAM_QUALITY]: 11 } }));
        }
      }
    }
  }
  await walk('.');
  return n;
}

/** Image context: only COPY, no RUN — no user code executes while building the image. */
async function buildContext(outDir: string, runtimeImage: string): Promise<Buffer> {
  await writeFile(path.join(outDir, 'Dockerfile'), `FROM ${runtimeImage}\nCOPY --chown=10001:10001 app /app\nWORKDIR /app\nUSER 10001:10001\n`);
  const chunks: Buffer[] = [];
  const stream = tar.c({ cwd: outDir, portable: true, follow: false }, ['Dockerfile', 'app']);
  for await (const c of stream as AsyncIterable<Buffer>) chunks.push(c);
  return Buffer.concat(chunks);
}
