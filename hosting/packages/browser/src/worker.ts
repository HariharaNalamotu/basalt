import { randomUUID } from 'node:crypto';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';
import type { Log } from '@basalt/host-shared';

/**
 * Drives real Chromium for coding agents, against their own preview/staging environments only.
 *
 * Containment:
 * - Hostnames under the platform domain resolve ONLY to the internal edge (--host-resolver-rules),
 *   so the browser can never reach the platform network, the host machine or the LAN directly.
 * - Everything else (fonts, payment SDKs) goes through the egress proxy, which blocks private ranges.
 * - Each session is a fresh, isolated context; the environment's access cookie is scoped to its host.
 */
export interface WorkerOptions {
  rootDomain: string;
  /** Internal edge host the platform domain maps to (port 443 inside the platform network). */
  edgeHost: string;
  /** Egress proxy for third-party resources, e.g. http://egress:3128 */
  egressProxy?: string;
  maxSessions?: number;
  idleTimeoutMs?: number;
  log: Log;
  /** Tests: override launch (e.g. headless with no resolver rules). */
  launch?: () => Promise<Browser>;
}

export interface Target {
  role?: string;
  name?: string;
  text?: string;
  label?: string;
  placeholder?: string;
  testId?: string;
  selector?: string;
  exact?: boolean;
  nth?: number;
}

export type Action =
  | { type: 'navigate'; path: string }
  | { type: 'back' }
  | { type: 'reload' }
  | { type: 'click'; target: Target }
  | { type: 'fill'; target: Target; value: string }
  | { type: 'press'; key: string; target?: Target }
  | { type: 'select'; target: Target; values: string[] }
  | { type: 'check'; target: Target; checked: boolean }
  | { type: 'hover'; target: Target }
  | { type: 'wait_for'; text?: string; target?: Target; urlIncludes?: string; gone?: boolean; timeoutMs?: number }
  | { type: 'snapshot' }
  | { type: 'screenshot'; fullPage?: boolean; target?: Target }
  | { type: 'evaluate'; expression: string }
  | { type: 'console' }
  | { type: 'network' };

interface Session {
  id: string;
  host: string;
  context: BrowserContext;
  page: Page;
  console: Array<{ type: string; text: string; at: string }>;
  network: Array<{ method: string; url: string; status: number | null; failure?: string; at: string }>;
  lastUsed: number;
  owner: string;
}

const ACTION_TIMEOUT = 10_000;
const MAX_SNAPSHOT = 24_000;

export class BrowserWorker {
  private browser?: Browser;
  private readonly sessions = new Map<string, Session>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(private readonly o: WorkerOptions) {
    this.sweeper = setInterval(() => void this.sweep(), 30_000);
    this.sweeper.unref();
  }

  private async getBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    this.browser = this.o.launch
      ? await this.o.launch()
      : await chromium.launch({
          headless: true,
          args: [
            `--host-resolver-rules=MAP *.${this.o.rootDomain} ${this.o.edgeHost}, MAP ${this.o.rootDomain} ${this.o.edgeHost}`,
            '--disable-dev-shm-usage',
          ],
          proxy: this.o.egressProxy ? { server: this.o.egressProxy, bypass: `*.${this.o.rootDomain},${this.o.rootDomain}` } : undefined,
        });
    this.browser.on('disconnected', () => {
      this.browser = undefined;
      this.sessions.clear();
    });
    return this.browser;
  }

  async open(input: { host: string; accessToken?: string; owner: string; path?: string }): Promise<{ sessionId: string } & Record<string, unknown>> {
    if (!input.host.endsWith(`.${this.o.rootDomain}`) && input.host !== this.o.rootDomain) throw new Error('Only platform hosts can be opened.');
    if (this.sessions.size >= (this.o.maxSessions ?? 6)) {
      // Evict this owner's oldest session first, otherwise refuse.
      const mine = [...this.sessions.values()].filter((s) => s.owner === input.owner).sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (!mine) throw new Error('Browser capacity reached. Close a session (browser_close) and retry.');
      await this.close(mine.id);
    }
    const browser = await this.getBrowser();
    const context = await browser.newContext({
      ignoreHTTPSErrors: true, // internal edge uses a self-signed certificate
      viewport: { width: 1280, height: 800 },
      serviceWorkers: 'block',
      acceptDownloads: false,
    });
    if (input.accessToken) {
      await context.addCookies([{ name: 'basalt_access', value: input.accessToken, domain: input.host, path: '/', httpOnly: true, secure: true, sameSite: 'Lax' }]);
    }
    const page = await context.newPage();
    page.setDefaultTimeout(ACTION_TIMEOUT);
    const s: Session = { id: randomUUID(), host: input.host, context, page, console: [], network: [], lastUsed: Date.now(), owner: input.owner };
    const push = <T>(arr: T[], v: T) => {
      arr.push(v);
      if (arr.length > 300) arr.shift();
    };
    page.on('console', (m) => push(s.console, { type: m.type(), text: m.text().slice(0, 2000), at: new Date().toISOString() }));
    page.on('pageerror', (e) => push(s.console, { type: 'pageerror', text: String(e.message).slice(0, 2000), at: new Date().toISOString() }));
    page.on('requestfailed', (r) => push(s.network, { method: r.method(), url: r.url().slice(0, 500), status: null, failure: r.failure()?.errorText, at: new Date().toISOString() }));
    page.on('response', (r) => {
      if (r.status() >= 400) push(s.network, { method: r.request().method(), url: r.url().slice(0, 500), status: r.status(), at: new Date().toISOString() });
    });
    this.sessions.set(s.id, s);
    const result = await this.act(s.id, input.owner, { type: 'navigate', path: input.path ?? '/' });
    return { sessionId: s.id, ...result };
  }

  private session(id: string, owner: string): Session {
    const s = this.sessions.get(id);
    if (!s || s.owner !== owner) throw new Error('Unknown or expired browser session. Open a new one with browser_open.');
    s.lastUsed = Date.now();
    return s;
  }

  private locate(page: Page, t: Target): Locator {
    let l: Locator;
    if (t.role) l = page.getByRole(t.role as Parameters<Page['getByRole']>[0], t.name ? { name: t.name, exact: t.exact } : undefined);
    else if (t.label) l = page.getByLabel(t.label, { exact: t.exact });
    else if (t.placeholder) l = page.getByPlaceholder(t.placeholder, { exact: t.exact });
    else if (t.testId) l = page.getByTestId(t.testId);
    else if (t.text) l = page.getByText(t.text, { exact: t.exact });
    else if (t.selector) l = page.locator(t.selector);
    else throw new Error('A target needs one of: role (+name), label, placeholder, testId, text, selector.');
    return t.nth !== undefined ? l.nth(t.nth) : l.first();
  }

  private async state(s: Session) {
    return { url: s.page.url(), title: await s.page.title().catch(() => '') };
  }

  async act(id: string, owner: string, a: Action): Promise<Record<string, unknown>> {
    const s = this.session(id, owner);
    const { page } = s;
    switch (a.type) {
      case 'navigate': {
        if (!a.path.startsWith('/') || a.path.startsWith('//')) throw new Error('navigate takes a path on this environment, like "/todos".');
        const res = await page.goto(`https://${s.host}${a.path}`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
        await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
        return { ...(await this.state(s)), status: res?.status() ?? null, snapshot: await this.snapshot(page) };
      }
      case 'back':
        await page.goBack({ waitUntil: 'domcontentloaded' });
        return { ...(await this.state(s)), snapshot: await this.snapshot(page) };
      case 'reload':
        await page.reload({ waitUntil: 'domcontentloaded' });
        return { ...(await this.state(s)), snapshot: await this.snapshot(page) };
      case 'click':
        await this.locate(page, a.target).click();
        await settle(page);
        return { ...(await this.state(s)), snapshot: await this.snapshot(page) };
      case 'fill':
        await this.locate(page, a.target).fill(a.value);
        return { ok: true };
      case 'press':
        if (a.target) await this.locate(page, a.target).press(a.key);
        else await page.keyboard.press(a.key);
        await settle(page);
        return { ...(await this.state(s)), snapshot: await this.snapshot(page) };
      case 'select':
        await this.locate(page, a.target).selectOption(a.values);
        return { ok: true };
      case 'check':
        await this.locate(page, a.target).setChecked(a.checked);
        return { ok: true };
      case 'hover':
        await this.locate(page, a.target).hover();
        return { ok: true };
      case 'wait_for': {
        const timeout = Math.min(a.timeoutMs ?? 10_000, 30_000);
        const state = a.gone ? 'hidden' : 'visible';
        if (a.text) await page.getByText(a.text).first().waitFor({ state, timeout });
        else if (a.target) await this.locate(page, a.target).waitFor({ state, timeout });
        else if (a.urlIncludes) await page.waitForURL((u) => u.toString().includes(a.urlIncludes!), { timeout });
        else await page.waitForTimeout(Math.min(timeout, 5000));
        return { ...(await this.state(s)), snapshot: await this.snapshot(page) };
      }
      case 'snapshot':
        return { ...(await this.state(s)), snapshot: await this.snapshot(page) };
      case 'screenshot': {
        const png = a.target
          ? await this.locate(page, a.target).screenshot({ type: 'png' })
          : await page.screenshot({ type: 'png', fullPage: a.fullPage ?? false });
        return { ...(await this.state(s)), pngBase64: png.toString('base64') };
      }
      case 'evaluate': {
        if (a.expression.length > 5000) throw new Error('Expression too long.');
        const value = await page.evaluate((expr) => {
          // eslint-disable-next-line no-new-func
          const v = new Function(`return (${expr})`)();
          return Promise.resolve(v).then((x) => JSON.stringify(x ?? null));
        }, a.expression);
        return { value: String(value).slice(0, 10_000) };
      }
      case 'console':
        return { entries: s.console.slice(-100) };
      case 'network':
        return { problems: s.network.slice(-100) };
    }
  }

  private async snapshot(page: Page): Promise<string> {
    const yaml = await page.locator('body').ariaSnapshot({ timeout: 5000 }).catch(() => '(page not ready)');
    return yaml.length > MAX_SNAPSHOT ? `${yaml.slice(0, MAX_SNAPSHOT)}\n… (truncated)` : yaml;
  }

  async close(id: string, owner?: string) {
    const s = this.sessions.get(id);
    if (!s || (owner && s.owner !== owner)) return false;
    this.sessions.delete(id);
    await s.context.close().catch(() => {});
    return true;
  }

  list(owner: string) {
    return [...this.sessions.values()].filter((s) => s.owner === owner).map((s) => ({ sessionId: s.id, host: s.host, url: s.page.url(), idleSeconds: Math.round((Date.now() - s.lastUsed) / 1000) }));
  }

  private async sweep() {
    const limit = this.o.idleTimeoutMs ?? 10 * 60_000;
    for (const s of [...this.sessions.values()]) if (Date.now() - s.lastUsed > limit) await this.close(s.id);
  }

  async shutdown() {
    clearInterval(this.sweeper);
    for (const id of [...this.sessions.keys()]) await this.close(id);
    await this.browser?.close().catch(() => {});
  }
}

async function settle(page: Page) {
  await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
}
