import type { Contract, FieldSpec } from '../../data/src/index.ts';
import { contextLine, esc, friendlyName, page } from './html.ts';

// The owner's data map: where their customers' information lives and who can
// reach it. Personal information is marked in red. Counts only, never anyone's data.

export interface MapStats {
  tables: Record<string, { active: number; archived: number }>;
  files: { count: number; bytes: number };
  // Who is an admin, named the way the owner approved them.
  admins: { label: string }[];
  recent: { at: string; table: string; op: string; columns: string[] }[];
}

const PERSONAL_NAME = /(name|phone|email|mail|address|street|city|zip|postal|birth|dob|ssn|social|passport|license|card|iban|account|salary|health|medical|diagnos|allerg|note|message|comment)/i;

export function isPersonal(name: string, spec: FieldSpec): boolean {
  if (spec.type === 'file') return true;
  if (spec.type === 'text' && (spec.format === 'email' || spec.format === 'phone' || spec.format === 'postal_code')) return true;
  return PERSONAL_NAME.test(name);
}

const words = (s: string) => s.replaceAll('_', ' ');
// "bookings" -> "booking", for sentences like "a new booking".
const one = (s: string) => words(s).replace(/ies$/, 'y').replace(/(ss)$/, '$1').replace(/s$/, '');
const title = (s: string) => words(s).replace(/^./, (c) => c.toUpperCase());

function kindOf(spec: FieldSpec): string {
  switch (spec.type) {
    case 'text':
      return spec.format ? words(spec.format) : 'text';
    case 'timestamp':
      return 'date and time';
    case 'user':
      return 'a person';
    case 'file':
      return 'file';
    case 'boolean':
      return 'yes or no';
    default:
      return 'number';
  }
}

function ago(at: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(at)) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

// Who can reach which table, drawn as boxes and lines. Green and blue lines
// are allowed paths. Red crossed lines are the ones that don't exist.
function diagram(contract: Contract, admins: number): string {
  const tables = [...contract.tables.values()];
  const shared = tables.filter((t) => t.shareWith);
  const actors: { label: string; kind: 'own' | 'share' | 'admin' | 'none'; to: string[] }[] = [
    { label: 'Each customer', kind: 'own', to: tables.map((t) => t.name) },
    ...(shared.length ? [{ label: 'Assigned person', kind: 'share' as const, to: shared.map((t) => t.name) }] : []),
    { label: `Admins (${admins})`, kind: 'admin', to: tables.map((t) => t.name) },
    { label: 'The AI that built it', kind: 'none', to: [] },
    { label: 'A hacker', kind: 'none', to: [] },
  ];
  const rowH = 54;
  const h = Math.max(actors.length, tables.length) * rowH + 20;
  const ay = (i: number) => 20 + i * rowH + 18;
  const ty = (i: number) => 20 + i * ((h - 40) / Math.max(1, tables.length)) + ((h - 40) / Math.max(1, tables.length)) / 2;
  const color = { own: 'var(--ok)', share: 'var(--share)', admin: 'var(--admin)', none: 'var(--bad)' };
  const lines: string[] = [];
  actors.forEach((a, i) => {
    if (a.kind === 'none') {
      const y = ay(i);
      lines.push(`<line x1="170" y1="${y}" x2="222" y2="${y}" stroke="${color.none}" stroke-width="2" stroke-dasharray="5 5"/>`);
      lines.push(`<text x="228" y="${y + 7}" fill="${color.none}" font-size="22" font-weight="700">&#x2715;</text>`);
      lines.push(`<text x="252" y="${y + 6}" fill="${color.none}" font-size="15">Cannot access</text>`);
      return;
    }
    for (const t of a.to) {
      const j = tables.findIndex((x) => x.name === t);
      lines.push(`<path d="M170 ${ay(i)} C 250 ${ay(i)}, 280 ${ty(j)}, 400 ${ty(j)}" fill="none" stroke="${color[a.kind]}" stroke-width="2.5" opacity="0.85"/>`);
    }
  });
  const actorBoxes = actors
    .map((a, i) => `<rect x="2" y="${ay(i) - 20}" width="168" height="40" rx="8" fill="var(--card)" stroke="${color[a.kind]}" stroke-width="1.5"/>
<text x="86" y="${ay(i) + 5}" text-anchor="middle" font-size="15" fill="var(--fg)">${esc(a.label)}</text>`)
    .join('');
  const tableBoxes = tables
    .map((t, j) => {
      const personal = [...t.fields].some(([n, s]) => isPersonal(n, s));
      return `<rect x="400" y="${ty(j) - 26}" width="168" height="52" rx="8" fill="var(--card)" stroke="${personal ? 'var(--share)' : 'var(--line)'}" stroke-width="${personal ? 2 : 1.5}"/>
<text x="484" y="${ty(j) - 3}" text-anchor="middle" font-size="17" font-weight="600" fill="var(--fg)">${esc(title(t.name))}</text>
<text x="484" y="${ty(j) + 16}" text-anchor="middle" font-size="14" fill="${personal ? 'var(--share)' : 'var(--muted)'}">${personal ? 'personal info' : 'no personal info'}</text>`;
    })
    .join('');
  return `<svg viewBox="0 0 570 ${h}" role="img" aria-label="Who can reach which data" style="width:100%;max-width:600px;height:auto;display:block;margin:0 auto">${lines.join('')}${actorBoxes}${tableBoxes}</svg>`;
}

export function renderMap(appName: string, contract: Contract, stats: MapStats): string {
  const tables = [...contract.tables.values()];
  const cards = tables
    .map((t) => {
      const c = stats.tables[t.name] ?? { active: 0, archived: 0 };
      const fields = [...t.fields]
        .map(([n, s]) => {
          const personal = isPersonal(n, s);
          const kind = kindOf(s);
          return `<li><span class="${personal ? 'pii' : ''}">${esc(words(n))}</span>${kind === words(n) ? '' : ` <span class="muted">${esc(kind)}</span>`}${personal ? ' <span class="badge tone--info">Personal info</span>' : ''}</li>`;
        })
        .join('');
      return `<section class="card"><h2>${esc(title(t.name))} <span class="muted">${c.active} saved${c.archived ? `, ${c.archived} archived` : ''}</span></h2>
<ul class="fields">${fields}</ul>
<p class="muted">${t.shareWith ? `Each person sees their own. The person in "${esc(words(t.shareWith))}" can read it but not change it. ` : 'Each person sees only their own. '}Admins see all. Nothing is ever permanently deleted.</p></section>`;
    })
    .join('');
  const recent = stats.recent.length
    ? `<ul>${stats.recent.map((r) => `<li>${esc(ago(r.at))}: ${r.op === 'INSERT' ? `a new ${esc(one(r.table))} was added` : `a ${esc(one(r.table))} changed (${esc(r.columns.map(words).join(', '))})`}</li>`).join('')}</ul>`
    : '<p class="muted">Nothing yet.</p>';
  const mb = (stats.files.bytes / 1048576).toFixed(1);
  const adminCard = `<div class="card"><h2>Admins <span class="muted">see and change everything</span></h2>${
    stats.admins.length ? `<ul>${stats.admins.map((a) => `<li>${esc(a.label)}</li>`).join('')}</ul>` : '<p class="muted">Nobody is an admin. Everyone only sees their own entries.</p>'
  }<p class="muted">To add an admin or take one away, ask Claude to add or remove them. You'll get a link to approve it first.</p></div>`;

  return page(
    `${appName}: data map`,
    `<style>
/* The map's own names, pointed at the design system's tokens. */
:root{--ok:var(--safe);--share:var(--info);--admin:var(--warning);--bad:var(--danger);--card:var(--bg-1);--fg:var(--text);--muted:var(--text-muted);--line:var(--edge)}
.pii{color:var(--text);font-weight:var(--semibold)}
.fields{columns:2;list-style:none;padding:0;margin:var(--s0)}.fields li{margin:var(--s1) var(--s0)}
.legend{display:flex;flex-wrap:wrap;gap:var(--s2) var(--s4);font-size:var(--sm);margin:var(--s4) var(--s0)}.dot{display:inline-block;width:var(--dot);height:var(--dot);border-radius:var(--round);margin-right:var(--s1)}
@media (max-width:480px){.fields{columns:1}}
</style>
<p class="decision__context">${contextLine(appName)}</p>
<h1>Where ${esc(friendlyName(appName).app)}'s information lives</h1>
<p class="muted">Live: ${tables.length} kind${tables.length === 1 ? '' : 's'} of data, ${stats.files.count} file${stats.files.count === 1 ? '' : 's'} (${mb} MB), ${stats.admins.length} admin${stats.admins.length === 1 ? '' : 's'}.</p>
<div class="card"><h2>Who can reach what</h2>${diagram(contract, stats.admins.length)}
<p class="legend"><span><i class="dot" style="background:var(--ok)"></i>their own</span>${tables.some((t) => t.shareWith) ? '<span><i class="dot" style="background:var(--share)"></i>read only, when assigned</span>' : ''}<span><i class="dot" style="background:var(--admin)"></i>everything</span><span><i class="dot" style="background:var(--bad)"></i>cannot access</span></p>
<p>The database applies these rules. The AI that built your app only ever gets the same access as the person signed in. Someone who breaks into the website still can't open the data, because the database checks every request itself.</p></div>
${cards}
${adminCard}
<div class="card"><h2>Recent changes</h2>${recent}<p class="muted">Basalt records what changed and when, never the values.</p></div>`,
  );
}
