import type { CheckResult } from './guard.ts';
import { esc, page } from './html.ts';
import type { ScanFinding } from './scan.ts';

// The owner's safety receipt: what Guard tried against their app the last
// time it ran, in plain words, plus anything the code scan found.

export function renderReceipt(appName: string, check: { results: CheckResult[]; findings: ScanFinding[]; at: string }): string {
  const passed = check.results.filter((r) => r.passed).length;
  const total = check.results.length;
  const allGood = passed === total && check.findings.length === 0;
  const toFix = check.findings.length ? `, ${check.findings.length} thing${check.findings.length === 1 ? '' : 's'} to fix in the code` : '';
  const when = new Date(check.at).toUTCString().replace(' GMT', ' UTC');
  const rows = check.results
    .map(
      (r) => `<li class="${r.passed ? 'ok' : 'bad'}"><span class="mark" aria-hidden="true">${r.passed ? '&#x2713;' : '&#x2715;'}</span>
<span><strong>${esc(r.title)}</strong><br><span class="muted">${r.passed ? 'Safe' : 'Problem'}: ${esc(r.detail)}</span></span></li>`,
    )
    .join('');
  const code = check.findings.length
    ? `<ul>${check.findings.map((f) => `<li><strong>${esc(f.file || 'App folder')}${f.line ? `, line ${f.line}` : ''}</strong>: ${esc(f.problem)} <span class="muted">${esc(f.fix)}</span></li>`).join('')}</ul>`
    : '<p>Nothing found. All of the app\'s data goes through Basalt.</p>';

  return page(
    `${appName}: safety receipt`,
    `<style>
:root{--ok:#2b8a3e;--bad:#e03131}@media (prefers-color-scheme:dark){:root{--ok:#51cf66;--bad:#ff6b6b}}
.checks{list-style:none;padding:0}.checks li{display:flex;gap:12px;align-items:flex-start;margin:12px 0}
.mark{font-weight:700;font-size:20px;line-height:1.2;width:20px;flex:none}.ok .mark{color:var(--ok)}.bad .mark{color:var(--bad)}
.score{font-size:20px;font-weight:600;color:${allGood ? 'var(--ok)' : 'var(--bad)'}}
</style>
<h1>Safety receipt for ${esc(appName)}</h1>
<p class="score">${passed} of ${total} checks passed${toFix}</p>
<p class="muted">Checked ${esc(when)}. Basalt signed in as two pretend people and a stranger and tried to reach data that wasn't theirs, using the same address your app uses.</p>
<div class="card"><h2>What we tried</h2><ul class="checks">${rows}</ul></div>
<div class="card"><h2>Data kept outside Basalt</h2>${code}</div>
<p class="muted">The test entries were archived afterwards. Ask Claude to run the check again after any change.</p>`,
  );
}
