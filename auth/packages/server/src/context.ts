import type { Db } from './db/db.js';
import type { KeyRing } from './lib/crypto.js';
import type { Logger } from './lib/logger.js';
import type { Mailer } from './lib/mailer.js';
import type { BreachChecker, PasswordHasher } from './lib/password.js';
import type { RateLimiter } from './lib/ratelimit.js';

export interface ServiceContext {
  db: Db;
  keyRing: KeyRing;
  hasher: PasswordHasher;
  rateLimiter: RateLimiter;
  mailer: Mailer;
  breachChecker: BreachChecker | undefined;
  log: Logger;
  /** Public base URL; JWT issuers are `${publicUrl}/v1/projects/${projectId}`. */
  publicUrl: string;
  now: () => Date;
}

/** Facts about the HTTP request that services record for auditing and rate limiting. */
export interface RequestMeta {
  ip: string;
  userAgent: string | undefined;
}
