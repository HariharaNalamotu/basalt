import { createHash, randomBytes } from 'node:crypto';
import { signToken, verifyToken } from '@basalt/host-shared';

/**
 * "Under attack" mode: before an app is served, the browser solves a small proof-of-work
 * (SHA-256 with N leading zero hex digits, ~0.2–1s for a real browser). Cheap for a visitor,
 * expensive at botnet scale, and requires a real JS engine. Clearance is bound to IP + host.
 */
export const CLEARANCE_COOKIE = 'basalt_clearance';
const DIFFICULTY = 4; // hex zeros: ~65k hashes on average

export function issueChallenge(key: string, ipKey: string, host: string) {
  return signToken(key, { ip: ipKey, host, n: randomBytes(8).toString('hex'), d: DIFFICULTY, exp: Math.floor(Date.now() / 1000) + 300 });
}

export function verifySolution(key: string, ipKey: string, host: string, challenge: unknown, nonce: unknown): string | null {
  if (typeof challenge !== 'string' || typeof nonce !== 'string' || nonce.length > 32) return null;
  const c = verifyToken<{ ip: string; host: string; d: number; exp: number }>(key, challenge);
  if (!c || c.ip !== ipKey || c.host !== host) return null;
  const digest = createHash('sha256').update(challenge + nonce).digest('hex');
  if (!digest.startsWith('0'.repeat(c.d))) return null;
  return signToken(key, { ip: ipKey, host, exp: Math.floor(Date.now() / 1000) + 3600 });
}

export function hasClearance(key: string, ipKey: string, host: string, cookie: string | undefined): boolean {
  const c = verifyToken<{ ip: string; host: string; exp: number }>(key, cookie);
  return Boolean(c && c.ip === ipKey && c.host === host);
}

export function challengePage(challenge: string, nonce: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Checking your browser</title>
<style nonce="${nonce}">body{font:16px system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;color:#222}</style></head>
<body><main><p>Checking your browser before continuing&hellip;</p><noscript>JavaScript is required.</noscript></main>
<script nonce="${nonce}">
(async () => {
  const challenge = ${JSON.stringify(challenge)};
  const target = '0'.repeat(${DIFFICULTY});
  const enc = new TextEncoder();
  for (let i = 0; ; i++) {
    const n = i.toString(36);
    const buf = await crypto.subtle.digest('SHA-256', enc.encode(challenge + n));
    const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
    if (hex.startsWith(target)) {
      const r = await fetch('/_basalt/challenge', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ challenge, nonce: n }) });
      if (r.ok) location.reload();
      return;
    }
  }
})();
</script></body></html>`;
}
