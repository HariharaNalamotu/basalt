import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The pages are plain HTML, CSS and JS kept beside the code (copied to dist/ at build), inlined
// into one response so their CSP can stay 'none' for everything but the page's own nonce.
const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dashboard-ui');
const cache = new Map<string, string>();

function file(name: string) {
  const hit = cache.get(name);
  if (hit !== undefined && process.env.NODE_ENV === 'production') return hit;
  const text = readFileSync(path.join(DIR, name), 'utf8');
  cache.set(name, text);
  return text;
}

function inline(html: string, nonce: string, css: string, js: string) {
  // Function replacers: the CSS and JS are inserted as-is, never read as replacement patterns.
  return html
    .replace('<!--STYLE-->', () => `<style nonce="${nonce}">${css}</style>`)
    .replace('<!--SCRIPT-->', () => `<script nonce="${nonce}">${js.replace(/<\/script/gi, '<\\/script')}</script>`);
}

/** The analytics page ships separately; until it's there, the dashboard opens on Connect Claude. */
export function hasDashboardUi() {
  return existsSync(path.join(DIR, 'dashboard.js'));
}

export function dashboardPage(nonce: string): string {
  return inline(file('index.html'), nonce, file('dashboard.css'), file('dashboard.js'));
}

export function connectPage(nonce: string, opts: { windowsLoopback: boolean; hasDashboard: boolean }): string {
  const config = `window.BASALT_CONNECT=${JSON.stringify(opts)};`;
  return inline(file('connect.html'), nonce, file('dashboard.css') + file('connect.css'), config + file('connect.js'));
}
