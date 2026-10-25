import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Docker } from '../src/docker.js';

// App builds fail with "No such image" when the build image isn't on the machine yet, so the
// platform pulls it on demand. Needs a real Docker socket; skipped without one.
const SOCKET = process.env.DOCKER_SOCKET ?? '/var/run/docker.sock';

describe.skipIf(!existsSync(SOCKET))('ensureImage', () => {
  const docker = new Docker(SOCKET);

  it('downloads a missing image', async () => {
    await docker.removeImage('hello-world:latest');
    expect(await docker.imageExists('hello-world:latest')).toBe(false);
    await docker.ensureImage('hello-world:latest');
    expect(await docker.imageExists('hello-world:latest')).toBe(true);
    await docker.removeImage('hello-world:latest');
  }, 120_000);

  it('says which image it could not download', async () => {
    await expect(docker.ensureImage('basalt-test/does-not-exist:never')).rejects.toThrow(/does-not-exist/);
  }, 120_000);
});
