import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const exists = (p: string) => stat(p).then(() => true, () => false);

/** Writes the files the Basalt build relies on, never overwriting existing ones. */
export async function initProject(root: string, rootDomain: string) {
  const written: string[] = [];
  const kept: string[] = [];
  const put = async (rel: string, content: string) => {
    const p = path.join(root, rel);
    if (await exists(p)) return kept.push(rel);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, content);
    written.push(rel);
  };
  // .npmrc: append the scope registry if missing (it may hold other settings).
  const npmrcPath = path.join(root, '.npmrc');
  const npmrc = await readFile(npmrcPath, 'utf8').catch(() => '');
  if (!npmrc.includes('@basalt:registry')) {
    await writeFile(npmrcPath, `${npmrc}${npmrc && !npmrc.endsWith('\n') ? '\n' : ''}@basalt:registry=https://registry.${rootDomain}/\n`);
    written.push('.npmrc');
  }
  // A plain site (public/index.html, no build script) is served as is; anything with a build outputs dist/.
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8').catch(() => '{}')) as { scripts?: Record<string, string> };
  const plainSite = !pkg.scripts?.build && (await exists(path.join(root, 'public/index.html')));
  await put('basalt.json', JSON.stringify({ backend: { entry: 'server/index.ts' }, frontend: { output: plainSite ? 'public' : 'dist' } }, null, 2) + '\n');
  await put(
    'playwright.config.ts',
    `import { defineConfig } from '@playwright/test';

// On Basalt Host the platform sets baseURL, https and access headers for each test environment.
export default defineConfig({
  testDir: './e2e',
  use: { baseURL: process.env.BASE_URL ?? 'http://localhost:5173' },
});
`,
  );
  if (!(await exists(path.join(root, 'e2e')))) {
    await put(
      'e2e/home.spec.ts',
      `import { test, expect } from '@playwright/test';

test('home page loads', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/.+/);
});
`,
    );
  }
  const gitignore = await readFile(path.join(root, '.gitignore'), 'utf8').catch(() => '');
  const need = ['node_modules/', 'dist/', '.env*', 'test-results/', 'playwright-report/'].filter((l) => !gitignore.includes(l));
  if (need.length) {
    await writeFile(path.join(root, '.gitignore'), `${gitignore}${gitignore && !gitignore.endsWith('\n') ? '\n' : ''}${need.join('\n')}\n`);
    written.push('.gitignore');
  }
  return { written, kept };
}
