import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { initProject, listProjectFiles } from '../src/index.js';

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
});
