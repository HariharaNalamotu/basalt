import { Agent, request } from 'undici';
import { Readable } from 'node:stream';

/**
 * Minimal Docker Engine API client over the Unix socket. Only the calls the platform needs,
 * so the surface that can create containers stays small and auditable.
 */
export class Docker {
  private readonly agent: Agent;
  constructor(socketPath: string, private readonly version = 'v1.47') {
    this.agent = new Agent({ connect: { socketPath }, headersTimeout: 0, bodyTimeout: 0 });
  }

  private async call(method: string, path: string, body?: unknown, opts: { raw?: boolean; ok?: number[]; headers?: Record<string, string>; stream?: Readable | Buffer; timeoutMs?: number } = {}) {
    // Ordinary calls fail loudly after 60s instead of hanging; long operations pass timeoutMs: 0.
    const timeout = opts.timeoutMs ?? 60_000;
    const res = await request(`http://docker/${this.version}${path}`, {
      method: method as 'GET',
      dispatcher: this.agent,
      signal: timeout ? AbortSignal.timeout(timeout) : undefined,
      headers: opts.stream ? opts.headers : body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: opts.stream ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
    const ok = opts.ok ?? [200, 201, 204, 304];
    if (!ok.includes(res.statusCode)) {
      const text = await res.body.text();
      const err = new Error(`docker ${method} ${path} -> ${res.statusCode}: ${text.slice(0, 500)}`) as Error & { status: number };
      err.status = res.statusCode;
      throw err;
    }
    if (opts.raw) return res;
    const text = await res.body.text();
    return text ? JSON.parse(text) : {};
  }

  // containers
  createContainer(name: string, spec: Record<string, unknown>) {
    return this.call('POST', `/containers/create?name=${encodeURIComponent(name)}`, spec) as Promise<{ Id: string }>;
  }
  start(id: string) {
    return this.call('POST', `/containers/${id}/start`, undefined, { ok: [204, 304] });
  }
  stop(id: string, t = 10) {
    return this.call('POST', `/containers/${id}/stop?t=${t}`, undefined, { ok: [204, 304, 404] });
  }
  remove(id: string) {
    return this.call('DELETE', `/containers/${id}?force=true&v=true`, undefined, { ok: [204, 404] });
  }
  inspect(id: string) {
    return this.call('GET', `/containers/${id}/json`, undefined, { ok: [200] }) as Promise<any>;
  }
  async inspectOrNull(id: string) {
    try {
      return await this.inspect(id);
    } catch (err) {
      if ((err as { status?: number }).status === 404) return null;
      throw err;
    }
  }
  async wait(id: string): Promise<number> {
    const r = (await this.call('POST', `/containers/${id}/wait`, undefined, { timeoutMs: 0 })) as { StatusCode: number };
    return r.StatusCode;
  }
  async logs(id: string, opts: { tail?: number; since?: number } = {}): Promise<string> {
    const res = (await this.call('GET', `/containers/${id}/logs?stdout=1&stderr=1&timestamps=1&tail=${opts.tail ?? 200}${opts.since ? `&since=${opts.since}` : ''}`, undefined, { raw: true })) as any;
    const buf = Buffer.from(await res.body.arrayBuffer());
    return demux(buf);
  }
  list(labels: Record<string, string>, all = true) {
    const filters = JSON.stringify({ label: Object.entries(labels).map(([k, v]) => `${k}=${v}`) });
    return this.call('GET', `/containers/json?all=${all ? 1 : 0}&filters=${encodeURIComponent(filters)}`) as Promise<any[]>;
  }
  async exec(id: string, cmd: string[]): Promise<{ exitCode: number; output: string }> {
    const ex = (await this.call('POST', `/containers/${id}/exec`, { Cmd: cmd, AttachStdout: true, AttachStderr: true })) as { Id: string };
    const res = (await this.call('POST', `/exec/${ex.Id}/start`, { Detach: false, Tty: false }, { raw: true, timeoutMs: 30_000 })) as any;
    const output = demux(Buffer.from(await res.body.arrayBuffer()));
    const info = (await this.call('GET', `/exec/${ex.Id}/json`)) as { ExitCode: number };
    return { exitCode: info.ExitCode, output };
  }

  // networks
  createNetwork(name: string, spec: Record<string, unknown>) {
    return this.call('POST', '/networks/create', { Name: name, ...spec }) as Promise<{ Id: string }>;
  }
  async connect(network: string, container: string, aliases?: string[]) {
    try {
      await this.call('POST', `/networks/${network}/connect`, { Container: container, EndpointConfig: aliases ? { Aliases: aliases } : {} });
    } catch (err) {
      if (!/already exists|already attached/i.test((err as Error).message)) throw err;
    }
  }
  disconnect(network: string, container: string) {
    return this.call('POST', `/networks/${network}/disconnect`, { Container: container, Force: true }, { ok: [200, 404] });
  }
  removeNetwork(name: string) {
    return this.call('DELETE', `/networks/${name}`, undefined, { ok: [204, 404] });
  }
  inspectNetwork(name: string) {
    return this.call('GET', `/networks/${name}`) as Promise<any>;
  }

  // images
  async build(tag: string, context: Buffer): Promise<string> {
    const res = (await this.call('POST', `/build?t=${encodeURIComponent(tag)}&rm=1&forcerm=1&pull=0&networkmode=none`, undefined, {
      raw: true,
      timeoutMs: 15 * 60_000,
      stream: context,
      headers: { 'content-type': 'application/x-tar' },
    })) as any;
    const text = await res.body.text();
    const lines = text.split('\n').filter(Boolean).map((l: string) => {
      try {
        return JSON.parse(l);
      } catch {
        return { stream: l };
      }
    });
    const error = lines.find((l: any) => l.error || l.errorDetail);
    if (error) throw new Error(`image build failed: ${error.error ?? error.errorDetail?.message}`);
    return lines.map((l: any) => l.stream ?? '').join('');
  }
  removeImage(tag: string) {
    return this.call('DELETE', `/images/${encodeURIComponent(tag)}?force=true`, undefined, { ok: [200, 404, 409] });
  }
  async imageExists(tag: string) {
    try {
      await this.call('GET', `/images/${encodeURIComponent(tag)}/json`);
      return true;
    } catch {
      return false;
    }
  }
}

/** Docker multiplexed log stream → text. */
function demux(buf: Buffer): string {
  const out: string[] = [];
  let i = 0;
  while (i + 8 <= buf.length) {
    const type = buf[i];
    const size = buf.readUInt32BE(i + 4);
    if (type !== 1 && type !== 2) return buf.toString('utf8'); // TTY / raw
    out.push(buf.subarray(i + 8, i + 8 + size).toString('utf8'));
    i += 8 + size;
  }
  return out.join('');
}

/** Hardened HostConfig shared by every user-code container. */
export function hardened(opts: { memoryMb: number; cpus: number; pids?: number; network: string; mounts?: unknown[]; readOnly?: boolean; tmpfsMb?: number; extraHosts?: string[]; restart?: boolean }) {
  return {
    NetworkMode: opts.network,
    Memory: opts.memoryMb * 1024 * 1024,
    MemorySwap: opts.memoryMb * 1024 * 1024,
    NanoCpus: Math.round(opts.cpus * 1e9),
    PidsLimit: opts.pids ?? 256,
    ReadonlyRootfs: opts.readOnly ?? true,
    Tmpfs: { '/tmp': `rw,nosuid,nodev,size=${opts.tmpfsMb ?? 64}m` },
    CapDrop: ['ALL'],
    SecurityOpt: ['no-new-privileges:true'],
    Init: true,
    Ulimits: [{ Name: 'nofile', Soft: 4096, Hard: 4096 }],
    LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } },
    RestartPolicy: opts.restart ? { Name: 'on-failure', MaximumRetryCount: 5 } : { Name: 'no' },
    Mounts: opts.mounts ?? [],
    ExtraHosts: opts.extraHosts,
  };
}
