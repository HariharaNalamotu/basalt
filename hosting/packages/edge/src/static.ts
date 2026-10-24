import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml',
  '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm', '.mp4': 'video/mp4', '.webm': 'video/webm', '.pdf': 'application/pdf',
};
const HASHED = /[.-][A-Za-z0-9_-]{8,}\.(js|mjs|css|woff2?|png|jpe?g|svg|webp|avif)$/;

export interface StaticResult {
  status: number;
  /** Set when a file is served. */
  file?: string;
}

/**
 * Serves a built frontend. Paths were normalized by the caller; we still confine resolution to
 * the root, never serve dotfiles, serve precompressed variants, and fall back to index.html for
 * client-side routes (paths without an extension).
 */
export async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  root: string,
  urlPath: string,
  opts: { production: boolean; headers: Record<string, string> },
): Promise<StaticResult> {
  const method = req.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') return { status: 405 };
  if (urlPath.split('/').some((s) => s.startsWith('.'))) return { status: 404 };
  if (opts.production && urlPath.endsWith('.map')) return { status: 404 }; // never leak source in production

  const resolveFile = async (p: string): Promise<string | null> => {
    const abs = path.resolve(root, `.${p}`);
    if (abs !== root && !abs.startsWith(root + path.sep)) return null;
    const s = await stat(abs).catch(() => null);
    if (s?.isFile()) return abs;
    if (s?.isDirectory()) {
      const idx = path.join(abs, 'index.html');
      return (await stat(idx).catch(() => null))?.isFile() ? idx : null;
    }
    return null;
  };

  let file = await resolveFile(urlPath.endsWith('/') ? `${urlPath}index.html` : urlPath);
  if (!file) {
    const looksLikeRoute = !path.extname(urlPath);
    const acceptsHtml = (req.headers.accept ?? '').includes('text/html') || !req.headers.accept;
    if (looksLikeRoute && acceptsHtml) file = await resolveFile('/index.html');
    if (!file) return { status: 404 };
  }

  const ext = path.extname(file).toLowerCase();
  const isHtml = ext === '.html';
  const s = await stat(file);
  const etag = `W/"${s.size.toString(16)}-${Math.floor(s.mtimeMs).toString(16)}"`;
  const headers: Record<string, string> = {
    ...opts.headers,
    'content-type': TYPES[ext] ?? 'application/octet-stream',
    etag,
    vary: 'Accept-Encoding',
    'cache-control': isHtml ? 'no-cache' : HASHED.test(file) ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
  };
  if (!opts.production) headers['cache-control'] = isHtml ? 'no-store' : 'private, max-age=60';
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers).end();
    return { status: 304, file };
  }

  const accept = String(req.headers['accept-encoding'] ?? '');
  let body = file;
  for (const [enc, suffix] of [['br', '.br'], ['gzip', '.gz']] as const) {
    if (accept.includes(enc) && (await stat(file + suffix).catch(() => null))?.isFile()) {
      body = file + suffix;
      headers['content-encoding'] = enc;
      break;
    }
  }
  headers['content-length'] = String((await stat(body)).size);
  res.writeHead(200, headers);
  if (method === 'HEAD') {
    res.end();
    return { status: 200, file };
  }
  await new Promise<void>((resolve) => {
    const stream = createReadStream(body);
    stream.on('error', () => {
      res.destroy();
      resolve();
    });
    stream.on('end', resolve);
    stream.pipe(res);
  });
  return { status: 200, file };
}
