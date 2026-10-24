import type { RateLimitRule } from '../lib/ratelimit.js';

/**
 * Abuse limits. IP limits are generous enough for offices/NAT; per-account limits are tight
 * because they protect a single target from credential stuffing and code guessing.
 */
export const LIMITS = {
  signupPerIp: { limit: 20, windowSeconds: 3600 },
  signupPerEmail: { limit: 5, windowSeconds: 3600 },
  verifyPerIp: { limit: 60, windowSeconds: 600 },
  resendPerSignup: { limit: 5, windowSeconds: 3600 },
  signinPerIp: { limit: 60, windowSeconds: 600 },
  signinPerAccount: { limit: 10, windowSeconds: 900 },
  mfaPerUser: { limit: 10, windowSeconds: 900 },
  resetRequestPerIp: { limit: 20, windowSeconds: 3600 },
  resetRequestPerEmail: { limit: 3, windowSeconds: 3600 },
  resetConfirmPerIp: { limit: 30, windowSeconds: 600 },
  emailCodePerUser: { limit: 5, windowSeconds: 3600 },
  refreshPerIp: { limit: 600, windowSeconds: 60 },
  sensitivePerUser: { limit: 10, windowSeconds: 900 },
} as const satisfies Record<string, RateLimitRule>;

/** Wrong guesses allowed per emailed code / MFA challenge before it is burned. */
export const MAX_CODE_ATTEMPTS = 5;
export const EMAIL_CODE_TTL_MINUTES = 15;
export const PENDING_SIGNUP_TTL_MINUTES = 30;
export const MFA_CHALLENGE_TTL_SECONDS = 300;
export const RECOVERY_CODE_COUNT = 10;
