import type { Log, Route, RouteTable } from '@basalt/host-shared';

/** Polls the control plane for the route table; keeps serving the last good table if it's unreachable. */
export class RouteTableClient {
  private table: RouteTable = { version: 0, generatedAt: new Date(0).toISOString(), underAttack: false, routes: [] };
  private byHost = new Map<string, Route>();
  private timer?: NodeJS.Timeout;
  private waiters: Array<() => void> = [];

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly log: Log,
    private readonly intervalMs = 1000,
  ) {}

  get current() {
    return this.table;
  }

  lookup(host: string): Route | undefined {
    return this.byHost.get(host);
  }

  set(table: RouteTable) {
    this.table = table;
    this.byHost = new Map(table.routes.map((r) => [r.host.toLowerCase(), r]));
    const w = this.waiters;
    this.waiters = [];
    w.forEach((f) => f());
  }

  async refresh() {
    try {
      const res = await fetch(this.url, {
        headers: { authorization: `Bearer ${this.token}`, 'if-none-match': String(this.table.version) },
        signal: AbortSignal.timeout(3000),
      });
      if (res.status === 200) this.set((await res.json()) as RouteTable);
    } catch (err) {
      this.log.warn('route_table_unreachable', { err: (err as Error).message });
    }
  }

  /** Resolves on the next table change (or timeout). */
  changed(timeoutMs: number) {
    return new Promise<void>((resolve) => {
      const t = setTimeout(resolve, timeoutMs);
      this.waiters.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  start() {
    const tick = async () => {
      await this.refresh();
      this.timer = setTimeout(tick, this.intervalMs);
      this.timer.unref();
    };
    void tick();
  }

  stop() {
    clearTimeout(this.timer);
  }
}
