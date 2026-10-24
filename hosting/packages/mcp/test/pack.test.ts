import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { initProject, listProjectFiles, scanFolder } from '../src/index.js';

describe('project packing', () => {
  it('never uploads secrets, dependencies, VCS data or build output', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pack-'));
    for (const f of ['package.json', 'server/index.ts', 'src/main.tsx', '.env', '.env.local', '.npmrc', 'node_modules/x/index.js', '.git/config', 'dist/index.html', 'secret.pem', 'e2e/a.spec.ts']) {
      await mkdir(path.dirname(path.join(root, f)), { recursive: true });
      await writeFile(path.join(root, f), 'x');
    }
    await writeFile(path.join(root, '.gitignore'), 'secret.pem\n');
    expect(await listProjectFiles(root)).toEqual(['.gitignore', 'e2e/a.spec.ts', 'package.json', 'server/index.ts', 'src/main.tsx']);
  });

  it('init writes conventions without overwriting', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'init-'));
    await writeFile(path.join(root, 'basalt.json'), '{"custom":true}');
    const r = await initProject(root, 'apps.example.com');
    expect(r.kept).toContain('basalt.json');
    expect(await readFile(path.join(root, '.npmrc'), 'utf8')).toContain('@basalt:registry=https://registry.apps.example.com/');
    expect(await readFile(path.join(root, 'basalt.json'), 'utf8')).toBe('{"custom":true}');
    expect(r.written).toEqual(expect.arrayContaining(['playwright.config.ts', 'e2e/home.spec.ts', '.gitignore']));
  });

  it('init takes a full registry URL (local mode)', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'init-'));
    await initProject(root, 'http://registry.basalt.localhost:8080');
    expect(await readFile(path.join(root, '.npmrc'), 'utf8')).toBe('@basalt:registry=http://registry.basalt.localhost:8080/\n');
  });
});

describe('local data scan', () => {
  it('finds data kept outside Basalt and pasted tokens, but not settings', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'scan-'));
    await mkdir(path.join(root, 'src'), { recursive: true });
    await mkdir(path.join(root, 'node_modules/x'), { recursive: true });
    await writeFile(path.join(root, 'src/app.js'), "localStorage.setItem('theme', 'dark');\nlocalStorage.setItem('cart', JSON.stringify(cart));\nconst t = 'bht_" + 'a'.repeat(43) + "';\n");
    await writeFile(path.join(root, 'src/db.ts'), "import Database from 'better-sqlite3';\n");
    await writeFile(path.join(root, 'node_modules/x/index.js'), "localStorage.setItem('x', 1)");
    await writeFile(path.join(root, 'data.sqlite'), '');
    const found = scanFolder(root).map((f) => `${f.rule}@${f.file}:${f.line}`);
    expect(found.sort()).toEqual(['browser_storage@src/app.js:2', 'data_file@data.sqlite:0', 'host_token_in_code@src/app.js:3', 'other_database@src/db.ts:1']);
  });
});
