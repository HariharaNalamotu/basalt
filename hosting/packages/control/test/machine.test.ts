import { describe, expect, it } from 'vitest';
import { checkMachine } from '../src/machine.js';

// A fake Docker with just what checkMachine calls: containers by name, compose labels, images.
function machine(over: { containers?: Record<string, { running: boolean }>; composed?: Array<{ Id: string; name: string; service: string }>; images?: string[]; pullFails?: boolean } = {}) {
  const cfg = {
    infraContainers: ['basalt-edge', 'basalt-cloud'],
    BUILD_NETWORK: 'basalt_build',
    DATA_VOLUME: 'basalt-data',
    RUNTIME_IMAGE: 'basalt/runtime:1',
    BUILD_IMAGE: 'node:24-alpine',
    TEST_IMAGE: 'playwright:test',
  };
  const containers = over.containers ?? { 'basalt-edge': { running: true }, 'basalt-cloud': { running: true } };
  const images = new Set(over.images ?? ['basalt/runtime:1', 'node:24-alpine', 'playwright:test']);
  const renamed: Array<[string, string]> = [];
  const docker = {
    inspectOrNull: async (name: string) => (containers[name] ? { State: { Running: containers[name].running } } : null),
    list: async (labels: Record<string, string>) =>
      (over.composed ?? []).filter((c) => c.service === labels['com.docker.compose.service']).map((c) => ({ Id: c.Id, Names: [`/${c.name}`], State: 'running' })),
    rename: async (id: string, name: string) => void renamed.push([id, name]),
    networkExists: async () => true,
    volumeExists: async () => true,
    imageExists: async (ref: string) => images.has(ref),
    ensureImage: async (ref: string) => {
      if (over.pullFails) throw new Error(`couldn't download ${ref}: network unreachable`);
      images.add(ref);
    },
  };
  const log = { warn: () => {}, error: () => {}, info: () => {} };
  return { ctx: { cfg, docker, log } as any, renamed, images };
}

describe('checkMachine', () => {
  it('is quiet on a machine that has everything', async () => {
    expect(await checkMachine(machine().ctx)).toEqual([]);
  });

  it('gives a Basalt container back its name after a rebuild left it on a temporary one', async () => {
    const m = machine({ containers: { 'basalt-edge': { running: true } }, composed: [{ Id: 'abc', name: 'c97fb5905e8f_basalt-cloud', service: 'cloud' }] });
    expect(await checkMachine(m.ctx)).toEqual([]);
    expect(m.renamed).toEqual([['abc', 'basalt-cloud']]);
  });

  it('says which service is down when there is nothing to rename', async () => {
    const problems = await checkMachine(machine({ containers: { 'basalt-edge': { running: true }, 'basalt-cloud': { running: false } } }).ctx);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.what).toMatch(/cloud service isn't running/);
    expect(problems[0]!.fix).toMatch(/start\.sh --no-build/);
  });

  it('blocks deploys when the app image is missing, but not for images it can download', async () => {
    const problems = await checkMachine(machine({ images: [] }).ctx);
    expect(problems.filter((p) => p.blocking !== false).map((p) => p.what)).toEqual([expect.stringMatching(/basalt\/runtime:1/)]);
    expect(problems.filter((p) => p.blocking === false)).toHaveLength(2);
  });

  it('downloads the build and test images when asked to', async () => {
    const m = machine({ images: ['basalt/runtime:1'] });
    expect(await checkMachine(m.ctx, { pull: true })).toEqual([]);
    expect(m.images.has('node:24-alpine') && m.images.has('playwright:test')).toBe(true);
  });

  it('names the image and the fix when a download fails', async () => {
    const problems = await checkMachine(machine({ images: ['basalt/runtime:1'], pullFails: true }).ctx, { pull: true });
    expect(problems.map((p) => p.fix)).toEqual(['Check this computer is online, then run: docker pull node:24-alpine', 'Check this computer is online, then run: docker pull playwright:test']);
  });
});
