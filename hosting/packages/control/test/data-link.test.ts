import { describe, expect, it } from 'vitest';
import { createDataProject, dataUrlFor, deleteDataProject, setDataRules } from '../src/data-link.js';

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
});
