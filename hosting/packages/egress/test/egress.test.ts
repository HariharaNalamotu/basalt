import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEgressProxy } from '../src/proxy.js';

let proxyPort: number;
let target: http.Server;
let targetPort: number;
const resolveMap: Record<string, string[]> = {};
const proxy = createEgressProxy({
  ports: [80, 443],
  maxConnsPerClient: 2,
  resolve: async (h) => resolveMap[h] ?? [],
});

beforeAll(async () => {
  await new Promise<void>((r) => proxy.server.listen(0, '127.0.0.1', r));
  proxyPort = (proxy.server.address() as AddressInfo).port;
  target = http.createServer((_q, s) => s.end('internal secret'));
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
  targetPort = (target.address() as AddressInfo).port;
});
afterAll(() => {
  proxy.server.close();
  target.close();
});

function connect(hostPort: string): Promise<string> {
  return new Promise((resolve) => {
    const s = net.connect(proxyPort, '127.0.0.1', () => s.write(`CONNECT ${hostPort} HTTP/1.1\r\nHost: ${hostPort}\r\n\r\n`));
    let buf = '';
    s.on('data', (d) => {
      buf += d.toString();
      if (buf.includes('\r\n\r\n')) {
        s.destroy();
        resolve(buf.split('\r\n')[0]!);
      }
    });
    s.on('error', () => resolve('error'));
  });
}

function plain(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port: proxyPort, method: 'GET', path: url, headers: { host: new URL(url).host } }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    r.end();
  });
}

describe('egress proxy', () => {
  it('refuses private, loopback, metadata and LAN destinations (literal and via DNS)', async () => {
    resolveMap['evil.example'] = ['10.0.0.5'];
    resolveMap['rebind.example'] = ['93.184.216.34', '192.168.1.1'];
    resolveMap['postgres'] = ['10.201.0.2'];
    for (const t of ['127.0.0.1:443', '169.254.169.254:80', '[::1]:443', '192.168.1.10:443', 'evil.example:443', 'rebind.example:443', 'postgres:443']) {
      expect(await connect(t), t).toMatch(/403/);
    }
    const r = await plain(`http://127.0.0.1:${targetPort}/`);
    expect(r.status).toBe(403);
    expect(r.body).not.toContain('internal secret');
  });

  it('refuses non-web ports (no SMTP relaying)', async () => {
    resolveMap['mail.example'] = ['93.184.216.34'];
    expect(await connect('mail.example:25')).toMatch(/403/);
    expect(await connect('mail.example:587')).toMatch(/403/);
  });

  it('allows public destinations', async () => {
    // A public-looking resolution that points at a non-listening TEST-NET-free public IP would need the
    // internet; we only assert the policy decision here by checking the error is not a policy denial.
    resolveMap['public.example'] = ['1.1.1.1'];
    const line = await Promise.race([connect('public.example:443'), new Promise<string>((r) => setTimeout(() => r('pending'), 1500))]);
    expect(line).not.toMatch(/403|400|429/);
  });
});
