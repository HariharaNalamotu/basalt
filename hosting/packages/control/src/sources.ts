import { createHash } from 'node:crypto';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as tar from 'tar';

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_FILES = 20_000;
const MAX_UNPACKED_BYTES = 300 * 1024 * 1024;
// Never accepted into a build: local dependencies, VCS data, local secrets.
const DROP = /(^|\/)(node_modules|\.git|\.basalt|\.e2e-app)(\/|$)|(^|\/)\.env(\.[^/]*)?$|(^|\/)\.npmrc$/;

export async function storeSource(dataDir: string, body: Buffer): Promise<{ sha: string; path: string; size: number }> {
  if (body.length > MAX_UPLOAD_BYTES) throw new Error(`Upload too large (max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB).`);
  if (body[0] !== 0x1f || body[1] !== 0x8b) throw new Error('Upload must be a gzipped tarball.');
  const sha = createHash('sha256').update(body).digest('hex');
  const dir = path.join(dataDir, 'sources');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${sha}.tgz`);
  if (!(await stat(file).catch(() => null))) {
    await writeFile(`${file}.tmp`, body, { mode: 0o600 });
    await rename(`${file}.tmp`, file);
  }
  return { sha, path: file, size: body.length };
}

/**
 * Extracts an uploaded tarball defensively: only regular files and directories (no symlinks,
 * hardlinks, devices), no absolute or parent paths, bounded file count and size.
 */
export async function extractSource(tgz: string, dest: string): Promise<{ files: number; bytes: number }> {
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  let files = 0;
  let bytes = 0;
  let violation: string | null = null;
  await tar.x({
    file: tgz,
    cwd: dest,
    strict: true,
    preservePaths: false,
    preserveOwner: false,
    noChmod: true,
    filter: (p, entry) => {
      const e = entry as tar.ReadEntry;
      const norm = p.replace(/^\.\//, '');
      if (violation) return false;
      if (e.type !== 'File' && e.type !== 'Directory' && e.type !== 'OldFile' && e.type !== 'ContiguousFile') {
        if (e.type === 'SymbolicLink' || e.type === 'Link') violation = `links are not allowed in uploads (${norm})`;
        return false;
      }
      if (path.isAbsolute(norm) || norm.split('/').includes('..')) {
        violation = `unsafe path in upload: ${norm}`;
        return false;
      }
      if (DROP.test(norm)) return false;
      files++;
      bytes += e.size ?? 0;
      if (files > MAX_FILES) violation = `too many files (max ${MAX_FILES})`;
      if (bytes > MAX_UNPACKED_BYTES) violation = `unpacked source too large (max ${MAX_UNPACKED_BYTES / 1024 / 1024} MB)`;
      return !violation;
    },
  });
  if (violation) {
    await rm(dest, { recursive: true, force: true });
    throw new Error(violation);
  }
  return { files, bytes };
}
