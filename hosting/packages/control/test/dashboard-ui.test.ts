import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

// The dashboard script's drawing parts, without the last part that wires up the page.
function loadDashboard(): any {
  const src = readFileSync(new URL('../src/dashboard-ui/dashboard.js', import.meta.url), 'utf8');
  const window: Record<string, unknown> = {};
  runInNewContext(src.slice(0, src.indexOf('/* ---- part 11')), { window, document: { querySelector: () => null } });
  return window.__dash;
}

describe('dashboard data card', () => {
  const D = loadDashboard();
  const sel = (data: unknown) => ({ app: 'salon', env: 'production', data });

  it('gives the owner a way to say yes to everything waiting for them', () => {
    const html: string = D.dataCard(
      sel({
        status: 'live',
        rules: 'Bookings: each person sees their own.',
        waitingForOwner: false,
        mapUrl: 'https://cloud.x/owner/a?k=v',
        pending: [
          { kind: 'admin', label: 'Make <b>maria</b> an admin', approveUrl: 'https://cloud.x/approve/a?t=1&x="y"' },
          { kind: 'remove_admin', label: 'Remove sam as admin', approveUrl: 'https://cloud.x/approve/b?t=2' },
        ],
      }),
      null,
    );
    expect(html).toContain('Make &lt;b&gt;maria&lt;/b&gt; an admin');
    expect(html).toContain('href="https://cloud.x/approve/a?t=1&amp;x=&quot;y&quot;"');
    expect(html).toContain('href="https://cloud.x/approve/b?t=2"');
    expect(html.match(/Review and approve/g)).toHaveLength(2);
  });

  it('the waiting state comes with its button, not just a heading', () => {
    const html: string = D.dataCard(
      sel({ status: 'waiting_for_owner', rules: '', waitingForOwner: true, mapUrl: null, pending: [{ kind: 'rules', label: 'New rules for who can see what', approveUrl: 'https://cloud.x/approve/c?t=3' }] }),
      null,
    );
    expect(html).toContain('Waiting for your OK');
    expect(html).toContain('New rules for who can see what');
    expect(html).toContain('href="https://cloud.x/approve/c?t=3"');
  });

  it('nothing waiting means no button', () => {
    const html: string = D.dataCard(sel({ status: 'live', rules: 'x', waitingForOwner: false, mapUrl: null, pending: [] }), null);
    expect(html).not.toContain('Review and approve');
    // Older control planes send no pending list at all.
    expect(D.dataCard(sel({ status: 'live', rules: 'x', waitingForOwner: false, mapUrl: null }), null)).not.toContain('Review and approve');
  });
});
