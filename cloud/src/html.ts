// Shared bits for Basalt Cloud's pages: escaping and the page shell. The look comes from the
// Basalt design system (design/basalt.css, spec in design/README.md), inlined into every page.

import { readFileSync } from 'node:fs';

const DESIGN_CSS = readFileSync(new URL('../../design/basalt.css', import.meta.url), 'utf8');

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const ENVIRONMENTS: Record<string, string> = { prod: 'Production', production: 'Production', staging: 'Staging' };

/**
 * A hosted environment's project is named like "shearjoyfive (prod)". Owners see
 * "shearjoyfive · Production" instead of the internal short name.
 */
export function friendlyName(name: string): { app: string; env: string | null } {
  const m = /^(.*) \(([a-z0-9-]+)\)$/.exec(name);
  if (!m) return { app: name, env: null };
  return { app: m[1]!, env: ENVIRONMENTS[m[2]!] ?? (/^p[a-z0-9]+$/.test(m[2]!) ? 'Preview' : m[2]!) };
}

export function contextLine(name: string): string {
  const f = friendlyName(name);
  return f.env ? `${esc(f.app)} · ${esc(f.env)}${f.env === 'Production' ? ' (the app your customers use)' : ''}` : esc(f.app);
}

const ICONS = {
  check: '<path d="M20 6 9 17l-5-5"/>',
  warning: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  problem: '<path d="M7.9 2h8.2L22 7.9v8.2L16.1 22H7.9L2 16.1V7.9Z"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  question: '<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/>',
};

/** An outline icon from the design system's one icon family. */
export function icon(name: keyof typeof ICONS): string {
  return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
}

/** A status banner: safe, warning or danger, with its icon and text in the status color. */
export function banner(tone: 'safe' | 'warning' | 'danger', heading: string, body = ''): string {
  const ic = tone === 'safe' ? 'check' : tone === 'warning' ? 'warning' : 'problem';
  return `<div class="banner tone--${tone}" role="${tone === 'danger' ? 'alert' : 'status'}">${icon(ic)}<div><h3>${heading}</h3>${body ? `<p>${body}</p>` : ''}</div></div>`;
}

export function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title><style>${DESIGN_CSS}</style></head>
<body><main class="page"><span class="wordmark"><span class="wordmark__mark" aria-hidden="true"></span>Basalt</span>${body}</main></body></html>`;
}
