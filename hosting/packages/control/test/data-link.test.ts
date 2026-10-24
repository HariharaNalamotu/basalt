import { describe, expect, it } from 'vitest';
import { createDataProject, dataUrlFor, deleteDataProject } from '../src/data-link.js';

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
    const r = await createDataProject(cfg, { name: 'todo (production)', authProjectId: 'prj_abc12345', authOwner: 'ws_1' }, f);
    expect(r).toEqual({ projectId: 'abcde12345', adminKey: 'bsk_abcde12345_secret' });
    expect(calls[0]!.url).toBe('http://cloud:8790/api/platform/projects');
    expect(calls[0]!.init.method).toBe('POST');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${cfg.platformKey}`);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ name: 'todo (production)', authProjectId: 'prj_abc12345', authOwner: 'ws_1' });
  });

  it('says plainly when Cloud refuses, and never trusts a malformed project id', async () => {
    await expect(createDataProject(cfg, { name: 'x', authProjectId: 'prj_abc12345', authOwner: 'ws_1' }, stub({ status: 503, body: { ok: false, error: { message: 'Basalt is full right now.' } } }).f)).rejects.toThrow(/Basalt is full/);
    await expect(createDataProject(cfg, { name: 'x', authProjectId: 'prj_abc12345', authOwner: 'ws_1' }, stub({ status: 201, body: { ok: true, project: { id: '../../x' }, adminKey: 'k' } }).f)).rejects.toThrow(/unexpected/);
  });

  it('deletes the data project with the environment', async () => {
    const { f, calls } = stub({ status: 200, body: { ok: true } });
    await deleteDataProject(cfg, 'abcde12345', f);
    expect(calls[0]!.url).toBe('http://cloud:8790/api/platform/projects/abcde12345');
    expect(calls[0]!.init.method).toBe('DELETE');
  });

  it('points the edge at the data project, or nowhere when Cloud is not set up', () => {
    expect(dataUrlFor(cfg, 'abcde12345')).toBe('http://cloud:8790/p/abcde12345');
    expect(dataUrlFor(null, 'abcde12345')).toBeNull();
    expect(dataUrlFor(cfg, null)).toBeNull();
  });
});
