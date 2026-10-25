import type { CheckResult } from './guard.ts';
import { banner, contextLine, esc, friendlyName, icon, page } from './html.ts';
import type { ScanFinding } from './scan.ts';

// The owner's safety receipt: what Guard tried against their app the last
// time it ran, in plain words, plus anything the code scan found.

export function renderReceipt(appName: string, check: { results: CheckResult[]; findings: ScanFinding[] | null; at: string }, stale = false): string {
  const passed = check.results.filter((r) => r.passed).length;
  const total = check.results.length;
  const found = check.findings?.length ?? 0;
  const allGood = passed === total && check.findings !== null && found === 0 && !stale;
  const toFix = found ? `, ${found} thing${found === 1 ? '' : 's'} to fix in the code` : '';
  const when = new Date(check.at).toUTCString().replace(' GMT', ' UTC');
  // Each attempt gets the badge for what was actually seen: a clear refusal, a leak, or no clear answer.
  // Failing to tidy up Guard's own test entry isn't an attack getting through, so it never shows as a leak.
  const verdict = (r: CheckResult) => (r.passed ? 'refused' : r.id === 'cleanup' || /^Couldn't tell|wasn't checked/.test(r.detail) ? 'unclear' : 'leaked');
  const badge = { refused: ['safe', 'shield', 'REFUSED'], leaked: ['danger', 'problem', 'LEAKED'], unclear: ['warning', 'question', "CAN'T TELL"] } as const;
  const rows = check.results
    .map((r) => {
      const [tone, ic, label] = badge[verdict(r)];
      return `<div class="result-row"><span class="badge tone--${tone}">${icon(ic)}${label}</span>
<div><div class="row__title">${esc(r.title)}${r.table ? ` <span class="muted">in ${esc(r.table.replaceAll('_', ' '))}</span>` : ''}</div><p>${esc(r.detail)}</p></div></div>`;
    })
    .join('');
  const code = check.findings === null
    ? "<p>The app's code wasn't checked this time. Ask Claude to run basalt_check from the app's folder.</p>"
    : found
    ? `<ul>${check.findings.map((f) => `<li><strong>${esc(f.file || 'App folder')}${f.line ? `, line ${f.line}` : ''}</strong>: ${esc(f.problem)} <span class="muted">${esc(f.fix)}</span></li>`).join('')}</ul>`
    : "<p>Nothing found in the app's folder on the builder's computer. All of the app's data goes through Basalt.</p>";

  const leaked = check.results.filter((r) => verdict(r) === 'leaked').length;
  const unclear = check.results.filter((r) => verdict(r) === 'unclear').length;
  const headline = `${passed} of ${total} attacks were refused${toFix}`;
  const status = stale
    ? banner('warning', "The app's rules changed after this check", 'Ask Claude to run it again before trusting this receipt.')
    : leaked
    ? banner('danger', `${leaked} attack${leaked === 1 ? '' : 's'} got through`, 'Ask Claude to fix this before the app goes live. Customers could reach data that isn\'t theirs.')
    : unclear
    ? banner('warning', `${unclear} check${unclear === 1 ? '' : 's'} couldn't tell either way`, 'Ask Claude to run the check again. A check that can\'t tell is never counted as safe.')
    : found
    ? banner('warning', 'The code check found something to fix', `${found} thing${found === 1 ? '' : 's'} in the app's code keep data outside Basalt. See the code check below.`)
    : check.findings === null
    ? banner('warning', "The app's code wasn't checked", 'Every attack was refused, but the code check below didn\'t run. Ask Claude to run it from the app\'s folder.')
    : banner('safe', 'Every attack was refused', 'Nobody could reach data that wasn\'t theirs.');

  return page(
    `${appName}: safety receipt`,
    `<header class="page-header__copy"><p class="decision__context">${contextLine(appName)}</p><h1>Safety receipt for ${esc(friendlyName(appName).app)}</h1>
<p class="summary numeric">${headline}</p>
<p class="numeric">Refused: ${passed} · Leaked: ${leaked} · Couldn't tell: ${unclear}</p>
<p class="muted">Checked ${esc(when)}. Basalt signed in as two pretend people and a stranger and tried to reach data that wasn't theirs, using the same address your app uses. This receipt describes these checks against this version.</p></header>
${status}
<section class="card"><div class="card__header"><h2>What we tried</h2></div>${rows}</section>
<section class="card"><div class="card__header"><h2>Data kept outside Basalt</h2></div>${code}</section>
<p class="muted">The test entries were archived afterwards. Ask Claude to run the check again after any change.</p>`,
  );
}
