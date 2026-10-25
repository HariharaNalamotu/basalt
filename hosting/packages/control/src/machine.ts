import type { Ctx } from './ctx.js';

/** Something this machine is missing for deploys, in plain words, with what to do about it. */
export type MachineProblem = { what: string; fix: string; blocking?: false };

/**
 * Checks what Basalt expects the machine to already have: its own containers under their usual
 * names, the build network, the data volume and the images app builds and tests run in.
 * Repairs what it safely can: gives a Basalt container back its name (an interrupted rebuild can
 * leave one running under a temporary name) and, with `pull`, downloads missing build and test images.
 */
export async function checkMachine(ctx: Pick<Ctx, 'cfg' | 'docker' | 'log'>, opts: { pull?: boolean } = {}): Promise<MachineProblem[]> {
  const { cfg, docker, log } = ctx;
  const problems: MachineProblem[] = [];
  const restart = { fix: 'Run ./start.sh --no-build to start Basalt again (it keeps your apps and data).' };

  for (const name of cfg.infraContainers) {
    const service = name.replace(/^basalt-/, '');
    const existing = await docker.inspectOrNull(name);
    if (existing?.State?.Running) continue;
    if (!existing) {
      const running = (await docker.list({ 'com.docker.compose.project': 'basalt', 'com.docker.compose.service': service }, false)).find((c) => c.State === 'running');
      if (running) {
        try {
          await docker.rename(running.Id, name);
          log.warn('infra_renamed', { container: name, from: running.Names?.[0] });
          continue;
        } catch (err) {
          log.error('infra_rename_failed', { container: name, err });
        }
      }
    }
    problems.push({ what: `Basalt's ${service} service isn't running.`, ...restart });
  }

  if (!(await docker.networkExists(cfg.BUILD_NETWORK))) problems.push({ what: `The network app builds use (${cfg.BUILD_NETWORK}) is missing.`, ...restart });
  if (!(await docker.volumeExists(cfg.DATA_VOLUME))) problems.push({ what: `Basalt's data volume (${cfg.DATA_VOLUME}) is missing.`, ...restart });
  if (!(await docker.imageExists(cfg.RUNTIME_IMAGE))) problems.push({ what: `The image apps run in (${cfg.RUNTIME_IMAGE}) is missing.`, fix: 'Run ./start.sh once with a build (without --no-build) to make it.' });

  for (const image of [cfg.BUILD_IMAGE, cfg.TEST_IMAGE]) {
    if (opts.pull) {
      await docker.ensureImage(image).catch((err) => problems.push({ what: `Basalt couldn't download ${image} (${(err as Error).message}).`, fix: `Check this computer is online, then run: docker pull ${image}` }));
    } else if (!(await docker.imageExists(image))) {
      problems.push({ what: `${image} isn't downloaded yet.`, fix: `It downloads on the next deploy, or now with: docker pull ${image}`, blocking: false });
    }
  }
  return problems;
}

/** One message for a deploy that can't start. */
export function describeProblems(problems: MachineProblem[]) {
  return `This computer isn't ready to deploy apps yet. ${problems.map((p) => `${p.what} ${p.fix}`).join(' ')}`;
}
