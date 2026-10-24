import { mkdtemp, mkdir, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import * as tar from 'tar';
import { describe, expect, it } from 'vitest';
import { SecretBox } from '../src/crypto.js';
import { appOrigins, emailsReadable, hostFor, RESERVED_APP_NAMES } from '../src/naming.js';
import { detectManifest } from '../src/pipeline.js';
import { scanSource } from '../src/scanner.js';
import { CspPatch, ProtectionPatch } from '../src/service.js';
import { extractSource, storeSource } from '../src/sources.js';

async function tgzOf(dir: string, entries: string[]) {
  const chunks: Buffer[] = [];
  for await (const c of tar.c({ cwd: dir, gzip: true, portable: true }, entries) as AsyncIterable<Buffer>) chunks.push(c);
  return Buffer.concat(chunks);
}

describe('upload handling', () => {
  it('rejects symlinks and drops secrets, dependencies and VCS data', async () => {
    const src = await mkdtemp(path.join(tmpdir(), 'src-'));
    await mkdir(path.join(src, 'server'), { recursive: true });
    await mkdir(path.join(src, 'node_modules/x'), { recursive: true });
    await mkdir(path.join(src, '.git'), { recursive: true });
    await writeFile(path.join(src, 'package.json'), '{}');
    await writeFile(path.join(src, 'server/index.ts'), 'x');
    await writeFile(path.join(src, '.env'), 'SECRET=1');
    await writeFile(path.join(src, 'node_modules/x/index.js'), 'x');
    await writeFile(path.join(src, '.git/config'), 'x');
    const data = await mkdtemp(path.join(tmpdir(), 'data-'));
    const ok = await storeSource(data, await tgzOf(src, ['package.json', 'server', '.env', 'node_modules', '.git']));
    const dest = path.join(data, 'work');
    await extractSource(ok.path, dest);
    expect((await readdir(dest)).sort()).toEqual(['package.json', 'server']);

    await symlink('/etc/passwd', path.join(src, 'evil'));
    const bad = await storeSource(data, await tgzOf(src, ['package.json', 'evil']));
    await expect(extractSource(bad.path, path.join(data, 'work2'))).rejects.toThrow(/links are not allowed/);
  });

  it('neutralizes path traversal entries', async () => {
    const data = await mkdtemp(path.join(tmpdir(), 'data-'));
    const header = new tar.Header({ path: '../../escape.txt', type: 'File', size: 4, mode: 0o644, mtime: new Date() });
    header.encode();
    const raw = Buffer.concat([header.block!, Buffer.from('evil'), Buffer.alloc(508), Buffer.alloc(1024)]);
    const { gzipSync } = await import('node:zlib');
    const s = await storeSource(data, gzipSync(raw));
    const dest = path.join(data, 'w');
    await extractSource(s.path, dest).catch(() => {});
    expect(await readdir(data)).not.toContain('escape.txt');
    expect(await readdir(path.dirname(data))).not.toContain('escape.txt');
  });

  it('rejects non-gzip and oversized uploads', async () => {
    const data = await mkdtemp(path.join(tmpdir(), 'data-'));
    await expect(storeSource(data, Buffer.from('not a tarball'))).rejects.toThrow(/gzipped/);
    await expect(storeSource(data, Buffer.alloc(51 * 1024 * 1024, 0x1f))).rejects.toThrow(/too large/);
  });
});

describe('source scanning', () => {
  it('blocks hardcoded credentials and critical code issues; allows clean code', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'scan-'));
    await mkdir(path.join(dir, 'server'), { recursive: true });
    await writeFile(path.join(dir, 'server/index.ts'), "import { createApi } from '@basalt/api';\nconst api = createApi();\n");
    expect((await scanSource(dir)).blocking).toEqual([]);
    await writeFile(path.join(dir, 'server/pay.ts'), `const key = 'sk_live_${'a'.repeat(24)}';\nawait pool.query(\`SELECT * FROM t WHERE id = \${id}\`);\n`);
    const r = await scanSource(dir);
    expect(r.blocking.map((f) => f.rule)).toEqual(expect.arrayContaining(['hardcoded-stripe-live-key', 'sql-string-building']));
  });
});

describe('manifest detection', () => {
  it('detects backend, frontend, migrations and e2e by convention', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'man-'));
    await mkdir(path.join(dir, 'server'), { recursive: true });
    await mkdir(path.join(dir, 'db/migrations'), { recursive: true });
    await mkdir(path.join(dir, 'e2e'), { recursive: true });
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'vite build' } }));
    await writeFile(path.join(dir, 'server/index.ts'), '');
    await writeFile(path.join(dir, 'db/migrations/001_x.sql'), '');
    await writeFile(path.join(dir, 'e2e/a.spec.ts'), '');
    expect(await detectManifest(dir)).toMatchObject({ backend: { entry: 'server/index.ts' }, frontend: { output: 'dist', build: true }, migrations: true, e2e: true, lockfile: false });
    await writeFile(path.join(dir, 'basalt.json'), JSON.stringify({ frontend: { output: '../etc' } }));
    await expect(detectManifest(dir)).rejects.toThrow(/inside the project/);
  });

  it('reads the data rules from basalt.data.json, and refuses a broken one with a plain reason', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'man-'));
    await writeFile(path.join(dir, 'package.json'), '{}');
    expect((await detectManifest(dir)).dataRules).toBeNull();
    const rules = { tables: { bookings: { fields: { service: { type: 'text', required: true } } } } };
    await writeFile(path.join(dir, 'basalt.data.json'), JSON.stringify(rules));
    expect((await detectManifest(dir)).dataRules).toEqual(rules);
    await writeFile(path.join(dir, 'basalt.data.json'), '{ not json');
    await expect(detectManifest(dir)).rejects.toThrow(/basalt\.data\.json/);
    await writeFile(path.join(dir, 'basalt.data.json'), '[1,2]');
    await expect(detectManifest(dir)).rejects.toThrow(/basalt\.data\.json/);
  });
});

describe('bounded settings', () => {
  it('protection and CSP only accept safe values', () => {
    expect(() => ProtectionPatch.parse({ perIpPerMinute: 5 })).toThrow();
    expect(() => ProtectionPatch.parse({ maxBodyBytes: 10 ** 10 })).toThrow();
    expect(() => ProtectionPatch.parse({ surprise: 1 })).toThrow();
    expect(ProtectionPatch.parse({ underAttack: true })).toEqual({ underAttack: true });
    expect(() => CspPatch.parse({ scriptSrc: ["'unsafe-inline'"] })).toThrow();
    expect(() => CspPatch.parse({ scriptSrc: ['http://evil.com'] })).toThrow();
    expect(() => CspPatch.parse({ connectSrc: ['*'] })).toThrow();
    expect(CspPatch.parse({ connectSrc: ['https://api.stripe.com', 'https://*.example.com'] }).connectSrc).toHaveLength(2);
  });

  it('hostnames are single labels under the root (one wildcard certificate)', () => {
    expect(hostFor('todo', 'production', 'prod', 'apps.dev')).toBe('todo.apps.dev');
    expect(hostFor('todo', 'staging', 'staging', 'apps.dev')).toBe('todo--staging.apps.dev');
    expect(hostFor('todo', 'preview', 'pabc123', 'apps.dev')).toBe('todo--pabc123.apps.dev');
  });

  it('apps sign in from https only, plus plain http on the local demo port when one is set', () => {
    expect(appOrigins('todo.apps.dev')).toEqual(['https://todo.apps.dev']);
    expect(appOrigins('todo.basalt.localhost', 8080)).toEqual(['https://todo.basalt.localhost', 'http://todo.basalt.localhost:8080']);
  });

  it("production email stays private, except on a one-laptop demo that can't send email at all", () => {
    expect(emailsReadable('staging', {})).toBe(true);
    expect(emailsReadable('production', {})).toBe(false);
    expect(emailsReadable('production', { localHttpPort: 8080, resendKey: 're_x' })).toBe(false);
    expect(emailsReadable('production', { localHttpPort: 8080 })).toBe(true);
  });

  it('platform service names (including cloud, where Basalt Cloud lives) are never app names', () => {
    for (const name of ['host', 'registry', 'auth', 'cloud']) expect(RESERVED_APP_NAMES.has(name), name).toBe(true);
  });

  it('secrets are bound to their owner', () => {
    const box = new SecretBox(randomBytes(32));
    const sealed = box.seal('s3cret', 'env:a:KEY');
    expect(box.open(sealed, 'env:a:KEY')).toBe('s3cret');
    expect(() => box.open(sealed, 'env:b:KEY')).toThrow();
  });
});
