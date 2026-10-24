import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Edge → origin authentication. The Basalt edge is the only thing allowed to talk to an app's
 * backend: it signs every forwarded request, and the backend rejects anything unsigned, so the
 * origin cannot be reached directly (bypassing TLS termination, WAF rules and IP attribution).
 *
 *   Basalt-Edge-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>\n<METHOD>\n<path?query>\n<request id>")>
 *   X-Request-Id: <request id>
 *
 * The edge must strip any client-supplied Basalt-Edge-Signature / X-Request-Id headers.
 */
export const EDGE_HEADER = 'basalt-edge-signature';
export const MAX_EDGE_SKEW_SECONDS = 60;

function payload(t: string, method: string, pathAndQuery: string, requestId: string) {
  return `${t}\n${method.toUpperCase()}\n${pathAndQuery}\n${requestId}`;
}

export function signEdgeRequest(secret: string, req: { method: string; pathAndQuery: string; requestId: string; now?: number }) {
  const t = Math.floor((req.now ?? Date.now()) / 1000).toString();
  const mac = createHmac('sha256', secret).update(payload(t, req.method, req.pathAndQuery, req.requestId)).digest('hex');
  return `t=${t},v1=${mac}`;
}

export function verifyEdgeSignature(
  secret: string,
  header: string | undefined,
  req: { method: string; pathAndQuery: string; requestId: string | undefined },
  nowMs = Date.now(),
): boolean {
  if (!header || !req.requestId) return false;
  const m = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(header.trim());
  if (!m) return false;
  const t = m[1]!;
  if (Math.abs(nowMs / 1000 - Number(t)) > MAX_EDGE_SKEW_SECONDS) return false;
  const expected = createHmac('sha256', secret).update(payload(t, req.method, req.pathAndQuery, req.requestId)).digest();
  return timingSafeEqual(expected, Buffer.from(m[2]!, 'hex'));
}
