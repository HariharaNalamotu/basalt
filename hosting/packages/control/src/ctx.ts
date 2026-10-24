import type { Redis } from 'ioredis';
import { HttpControlPlane } from '@basalt/auth-mcp';
import type { Log } from '@basalt/host-shared';
import type { Config } from './config.js';
import type { SecretBox } from './crypto.js';
import type { Db } from './db.js';
import type { Docker } from './docker.js';

export interface Ctx {
  cfg: Config;
  db: Db;
  box: SecretBox;
  docker: Docker;
  redis: Redis;
  log: Log;
  /** Bumped whenever anything the edge routes on changes. */
  routes: { version: number; bump(): void; /** Bump and make the edge load the new table now. */ sync?(): Promise<void> };
  /** Auth control plane scoped to a workspace (one auth "owner" per workspace). */
  authFor(workspaceId: string): HttpControlPlane;
}

export function authFactory(cfg: Config) {
  return (workspaceId: string) => new HttpControlPlane(cfg.AUTH_INTERNAL_URL, cfg.AUTH_PLATFORM_KEY, workspaceId);
}
