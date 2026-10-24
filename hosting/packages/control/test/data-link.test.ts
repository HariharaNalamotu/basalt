import { describe, expect, it } from 'vitest';
import { createDataProject, dataStatus, dataUrlFor, deleteDataProject, requestDataAdmin, runDataCheck, setDataRules } from '../src/data-link.js';

const cfg = { url: 'http://cloud:8790/', platformKey: 'k'.repeat(40) };

function stub(reply: { status: number; body: unknown }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe('Basalt Cloud data projects for environments', () => {
  it('creates a data project bound to the environment\'s Auth project', async () => {
    const { f, calls } = stub({ status: 201, body: { ok: true, project: { id: 'abcde12345' }, adminKey: 'bsk_abcde12345_secret' } });
    const r = await createDataProject(cfg, { name: 'todo (production)', authProjectId: 'prj_abc12345', authOwner: 'ws_1', externalId: 'env_1' }, f);
    expect(r).toEqual({ projectId: 'abcde12345', adminKey: 'bsk_abcde12345_secret' });
    expect(calls[0]!.url).toBe('http://cloud:8790/api/platform/projects');
    expect(calls[0]!.init.method).toBe('POST');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${cfg.platformKey}`);
    // The environment id makes a retry return the same project instead of a second one.
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ name: 'todo (production)', authProjectId: 'prj_abc12345', authOwner: 'ws_1', externalId: 'env_1' });
  });

  it('says plainly when Cloud refuses, and never trusts a malformed project id', async () => {
    await expect(createDataProject(cfg, { name: 'x', authProjectId: 'prj_abc12345', authOwner: 'ws_1', externalId: 'env_1' }, stub({ status: 503, body: { ok: false, error: { message: 'Basalt is full right now.' } } }).f)).rejects.toThrow(/Basalt is full/);
    await expect(createDataProject(cfg, { name: 'x', authProjectId: 'prj_abc12345', authOwner: 'ws_1', externalId: 'env_1' }, stub({ status: 201, body: { ok: true, project: { id: '../../x' }, adminKey: 'k' } }).f)).rejects.toThrow(/unexpected/);
  });

  it('deletes by environment id (even if the project id was never recorded), counts "already gone" as done and reports real failures', async () => {
    const { f, calls } = stub({ status: 200, body: { ok: true } });
    await deleteDataProject(cfg, 'env_1', f);
    expect(calls[0]!.url).toBe('http://cloud:8790/api/platform/environments/env_1');
    expect(calls[0]!.init.method).toBe('DELETE');
    await deleteDataProject(cfg, 'env_1', stub({ status: 404, body: { ok: false, error: { message: 'Unknown environment.' } } }).f);
    await expect(deleteDataProject(cfg, 'env_1', stub({ status: 503, body: { ok: false, error: { message: 'down' } } }).f)).rejects.toThrow(/down/);
  });

  it('falls back to the recorded project id for projects made before environment ids were sent', async () => {
    const calls: string[] = [];
    const f = (async (url: string) => {
      calls.push(String(url));
      return new Response(JSON.stringify(String(url).includes('/environments/') ? { ok: false, error: { message: 'Unknown environment.' } } : { ok: true }), {
        status: String(url).includes('/environments/') ? 404 : 200,
      });
    }) as unknown as typeof fetch;
    await deleteDataProject(cfg, 'env_1', f, 'abcde12345');
    expect(calls).toEqual(['http://cloud:8790/api/platform/environments/env_1', 'http://cloud:8790/api/platform/projects/abcde12345']);
  });

  it('test environments get their rules right away, production waits for the owner', async () => {
    const contract = { tables: { notes: { fields: { text: { type: 'text' } } } } };
    const test = stub({ status: 200, body: { ok: true, status: 'live', summary: 'Each person sees their own notes.' } });
    expect(await setDataRules(cfg, { projectId: 'abcde12345', adminKey: 'bsk_x', kind: 'staging' }, contract, test.f)).toEqual({ status: 'live', summary: 'Each person sees their own notes.' });
    expect(test.calls[0]!.url).toBe('http://cloud:8790/api/platform/projects/abcde12345/rules');
    expect((test.calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${cfg.platformKey}`);

    const prod = stub({ status: 202, body: { ok: true, status: 'waiting_for_owner', approveUrl: 'https://cloud.example.com/approve/x?t=y', why: ['New rules.'], summary: 's' } });
    const r = await setDataRules(cfg, { projectId: 'abcde12345', adminKey: 'bsk_x', kind: 'production' }, contract, prod.f);
    expect(r).toEqual({ status: 'waiting_for_owner', approveUrl: 'https://cloud.example.com/approve/x?t=y', why: ['New rules.'], summary: 's' });
    expect(prod.calls[0]!.url).toBe('http://cloud:8790/api/projects/me/rules');
    expect((prod.calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer bsk_x');
  });

  it('points the edge at the data project, or nowhere when Cloud is not set up', () => {
    expect(dataUrlFor(cfg, 'abcde12345')).toBe('http://cloud:8790/p/abcde12345');
    expect(dataUrlFor(null, 'abcde12345')).toBeNull();
    expect(dataUrlFor(cfg, null)).toBeNull();
  });

  it('reads status, requests admins and runs Guard with the environment\'s own admin key, never the platform key', async () => {
    const key = 'bsk_abcde12345_secret';
    const st = stub({ status: 200, body: { ok: true, project: { status: 'live', rules: 'Bookings: each person sees their own.', waitingForOwner: false, mapUrl: 'https://cloud.x/owner/abcde12345?k=v' } } });
    expect(await dataStatus(cfg, key, st.f)).toEqual({ status: 'live', rules: 'Bookings: each person sees their own.', waitingForOwner: false, mapUrl: 'https://cloud.x/owner/abcde12345?k=v' });
    expect(st.calls[0]!.url).toBe('http://cloud:8790/api/projects/me');
    expect((st.calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${key}`);
    expect((await dataStatus(cfg, key, stub({ status: 200, body: { ok: true, project: { status: 'weird' } } }).f)).status).toBe('no_rules');

    const ad = stub({ status: 202, body: { ok: true, status: 'waiting_for_owner', approveUrl: 'https://cloud.x/approve/1?t=2', userId: 'u1' } });
    expect(await requestDataAdmin(cfg, key, { who: 'maria' }, ad.f)).toEqual({ approveUrl: 'https://cloud.x/approve/1?t=2', userId: 'u1' });
    expect(JSON.parse(String(ad.calls[0]!.init.body))).toEqual({ who: 'maria' });

    const ck = stub({ status: 200, body: { ok: true, passed: 11, failed: 1, results: [{ id: 'x', title: 'X', passed: false, detail: 'd' }], receiptUrl: 'https://cloud.x/owner/a/check?k=v' } });
    const scan = [{ rule: 'browser_storage', file: 'src/a.js', line: 2, problem: 'p', fix: 'f' }];
    expect((await runDataCheck(cfg, key, scan, ck.f)).failed).toBe(1);
    expect(JSON.parse(String(ck.calls[0]!.init.body))).toEqual({ scan });
    const noScan = stub({ status: 200, body: { ok: true, passed: 12, failed: 0, results: [], receiptUrl: 'r' } });
    await runDataCheck(cfg, key, null, noScan.f);
    expect(JSON.parse(String(noScan.calls[0]!.init.body))).toEqual({});
    await expect(runDataCheck(cfg, key, null, stub({ status: 409, body: { ok: false, error: { message: "Set the app's rules first" } } }).f)).rejects.toThrow(/rules first/);
  });
});
