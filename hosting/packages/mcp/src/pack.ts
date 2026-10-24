import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import ignore from 'ignore';
import * as tar from 'tar';

export const MAX_UPLOAD = 50 * 1024 * 1024;
// Never uploaded, whatever .gitignore says: dependencies, VCS, local secrets, build output.
const ALWAYS = ['node_modules/', '.git/', '.basalt/', '.env', '.env.*', '.npmrc', 'dist/', 'build/', 'coverage/', 'test-results/', 'playwright-report/', '.DS_Store', '*.log', '.e2e-app/'];

/** Lists project files to upload (relative paths), honoring .gitignore plus the fixed exclusions. */
export async function listProjectFiles(root: string): Promise<string[]> {
  const ig = ignore().add(ALWAYS);
  const gi = await readFile(path.join(root, '.gitignore'), 'utf8').catch(() => '');
  ig.add(gi);
  const out: string[] = [];
  async function walk(rel: string) {
    for (const e of await readdir(path.join(root, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (!ig.ignores(`${r}/`)) await walk(r);
      } else if (e.isFile() && !ig.ignores(r)) out.push(r);
    }
  }
  await walk('');
  return out.sort();
}

export async function packProject(root: string): Promise<{ tgz: Buffer; files: number }> {
  if (!(await stat(path.join(root, 'package.json')).catch(() => null))) {
    throw new Error(`No package.json in ${root}. Run host_deploy from (or with dir set to) the project root.`);
  }
  const files = await listProjectFiles(root);
  const chunks: Buffer[] = [];
  for await (const c of tar.c({ cwd: root, gzip: true, portable: true, follow: false }, files) as AsyncIterable<Buffer>) {
    chunks.push(c);
    if (chunks.reduce((n, b) => n + b.length, 0) > MAX_UPLOAD) throw new Error('Project is larger than 50 MB after excluding node_modules/build output. Remove large files (use object storage for media).');
  }
  return { tgz: Buffer.concat(chunks), files: files.length };
}
