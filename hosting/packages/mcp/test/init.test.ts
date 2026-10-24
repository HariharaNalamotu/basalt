import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { initProject } from '../src/init.js';

describe('host_init', () => {
  it('points the frontend at public/ for a plain site with no build step, and at dist/ otherwise', async () => {
    const plain = await mkdtemp(path.join(tmpdir(), 'init-'));
    await mkdir(path.join(plain, 'public'));
    await writeFile(path.join(plain, 'public/index.html'), '<!doctype html><title>x</title>');
    await writeFile(path.join(plain, 'package.json'), '{}');
    await initProject(plain, 'example.com');
    expect(JSON.parse(await readFile(path.join(plain, 'basalt.json'), 'utf8')).frontend.output).toBe('public');

    const built = await mkdtemp(path.join(tmpdir(), 'init-'));
    await writeFile(path.join(built, 'package.json'), JSON.stringify({ scripts: { build: 'vite build' } }));
    await initProject(built, 'example.com');
    expect(JSON.parse(await readFile(path.join(built, 'basalt.json'), 'utf8')).frontend.output).toBe('dist');
  });
});
