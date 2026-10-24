import { BlockList, isIP } from 'node:net';

const v4 = new BlockList();
const v6 = new BlockList();
for (const [n, p] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) v4.addSubnet(n, p, 'ipv4');
for (const [n, p] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23], ['2001:db8::', 32],
  ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) v6.addSubnet(n, p, 'ipv6');

/** True for anything but a public unicast address (private, loopback, link-local/metadata, CGNAT, reserved). */
export function isNonPublicAddress(address: string): boolean {
  const fam = isIP(address);
  if (fam === 4) return v4.check(address, 'ipv4');
  if (fam !== 6) return true;
  const lower = address.toLowerCase();
  if (lower.startsWith('::ffff:') || /^::(\d+\.){3}\d+$/.test(lower)) return true;
  return v6.check(address, 'ipv6');
}

/** Rate-limit bucket: IPv4 as-is, IPv6 per /64. */
export function ipBucket(ip: string): string {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (m) return m[1]!;
  if (!ip.includes(':')) return ip;
  const [head = '', tail = ''] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return `${groups.slice(0, 4).map((g) => g.toLowerCase().padStart(4, '0')).join(':')}::/64`;
}

/** Hostnames the platform will accept for apps: one DNS label under the root domain. */
export const APP_NAME_RE = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;
