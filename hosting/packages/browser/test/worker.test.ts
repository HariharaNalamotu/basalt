import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { silentLog } from '@basalt/host-shared';
import { BrowserWorker } from '../src/worker.js';

// A tiny app standing in for an environment behind the edge. The worker maps the platform
// domain to it via Chromium host-resolver rules, exactly as in production.
let site: http.Server;
let port: number;
let worker: BrowserWorker;
const seenCookies: string[] = [];

beforeAll(async () => {
  site = http.createServer((req, res) => {
    seenCookies.push(String(req.headers.cookie ?? ''));
    if (req.url === '/api/missing') return res.writeHead(404).end('{}');
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>Todos</title><main>
      <h1>Todos</h1>
      <label>New todo <input placeholder="What needs doing?" id="t"></label>
      <button onclick="const li=document.createElement('li');li.textContent=document.getElementById('t').value;document.querySelector('ul').append(li);console.error('added');fetch('/api/missing')">Add</button>
      <ul aria-label="list"></ul></main>`);
  });
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
  port = (site.address() as AddressInfo).port;
  worker = new BrowserWorker({
    rootDomain: 'apps.test',
    edgeHost: '127.0.0.1',
    log: silentLog,
    // The production launch uses https on 443; here we map to the local http server instead.
    launch: () => chromium.launch({ headless: true, args: [`--host-resolver-rules=MAP *.apps.test 127.0.0.1:${port}`] }),
  });
  // Tests drive http:// on the mapped port; patch navigate's scheme for the local stand-in.
  (worker as any).act = new Proxy((worker as any).act, {
    apply(target, self, args) {
      const [, , a] = args;
      if (a.type === 'navigate') {
        const s = (self as any).sessions.get(args[0]);
        return s.page.goto(`http://${s.host}${a.path}`).then(async (r: any) => ({ status: r?.status(), snapshot: await (self as any).snapshot(s.page) }));
      }
      return Reflect.apply(target, self, args);
    },
  });
}, 120_000);

afterAll(async () => {
  await worker.shutdown();
  site.close();
});

describe('browser worker', () => {
  it('opens a session on a platform host, interacts by role/label, and captures console and network problems', async () => {
    const s = await worker.open({ host: 'todo--staging.apps.test', owner: 'ws_a', accessToken: 'tok123' });
    expect(s.snapshot).toContain('heading "Todos"');
    await worker.act(s.sessionId, 'ws_a', { type: 'fill', target: { placeholder: 'What needs doing?' }, value: 'Buy milk' });
    const after = await worker.act(s.sessionId, 'ws_a', { type: 'click', target: { role: 'button', name: 'Add' } });
    expect(after.snapshot).toContain('Buy milk');
    const shot = await worker.act(s.sessionId, 'ws_a', { type: 'screenshot' });
    expect(Buffer.from(shot.pngBase64 as string, 'base64').subarray(1, 4).toString()).toBe('PNG');
    const consoleLog = await worker.act(s.sessionId, 'ws_a', { type: 'console' });
    expect(JSON.stringify(consoleLog)).toContain('added');
    await new Promise((r) => setTimeout(r, 300));
    const net = await worker.act(s.sessionId, 'ws_a', { type: 'network' });
    expect(JSON.stringify(net)).toContain('/api/missing');
    const ev = await worker.act(s.sessionId, 'ws_a', { type: 'evaluate', expression: 'document.querySelectorAll("li").length' });
    expect(ev.value).toBe('1');
    // The access cookie is Secure (sent over the https internal edge in production) and scoped to this host only.
    const cookies = await (worker as any).sessions.get(s.sessionId).context.cookies();
    expect(cookies).toEqual([expect.objectContaining({ name: 'basalt_access', value: 'tok123', domain: 'todo--staging.apps.test', httpOnly: true, secure: true })]);
  });

  it('opens at phone size and in dark mode when asked, so agents can check the layout people actually see', async () => {
    const s = await worker.open({ host: 'todo--staging.apps.test', owner: 'ws_view', viewport: 'phone', colorScheme: 'dark' });
    // The emulated screen is a phone. (The page's layout width is 980 unless it has a mobile
    // viewport meta tag, exactly like a real phone, which is the point of checking.)
    const size = await worker.act(s.sessionId, 'ws_view', { type: 'evaluate', expression: 'screen.width + "x" + screen.height' });
    expect(size.value).toBe('"390x844"');
    const dark = await worker.act(s.sessionId, 'ws_view', { type: 'evaluate', expression: 'matchMedia("(prefers-color-scheme: dark)").matches' });
    expect(dark.value).toBe('true');
    const d = await worker.open({ host: 'todo--staging.apps.test', owner: 'ws_view' });
    expect((await worker.act(d.sessionId, 'ws_view', { type: 'evaluate', expression: 'innerWidth' })).value).toBe('1280');
  });

  it('isolates sessions between owners and refuses non-platform hosts', async () => {
    const s = await worker.open({ host: 'todo--staging.apps.test', owner: 'ws_a' });
    await expect(worker.act(s.sessionId, 'ws_b', { type: 'snapshot' })).rejects.toThrow(/Unknown or expired/);
    await expect(worker.open({ host: 'example.com', owner: 'ws_a' })).rejects.toThrow(/Only platform hosts/);
    await expect(worker.open({ host: 'evil.apps.test.attacker.com', owner: 'ws_a' })).rejects.toThrow(/Only platform hosts/);
    expect(await worker.close(s.sessionId, 'ws_b')).toBe(false);
    expect(await worker.close(s.sessionId, 'ws_a')).toBe(true);
  });

  it('only navigates within the session host', async () => {
    const s = await worker.open({ host: 'todo--staging.apps.test', owner: 'ws_a' });
    await expect((BrowserWorker.prototype.act as any).call(worker, s.sessionId, 'ws_a', { type: 'navigate', path: '//evil.com/x' })).rejects.toThrow(/path on this environment/);
    await expect((BrowserWorker.prototype.act as any).call(worker, s.sessionId, 'ws_a', { type: 'navigate', path: 'https://evil.com' })).rejects.toThrow(/path on this environment/);
  });
});
