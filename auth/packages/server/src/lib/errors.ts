import type { ContentfulStatusCode } from 'hono/utils/http-status';

/**
 * Stable, machine-readable error codes. Clients (and the SDK) switch on `code`, never on `message`.
 * Messages are deliberately generic where detail would help an attacker (e.g. user enumeration).
 */
export const ErrorCodes = {
  invalid_request: 400,
  weak_password: 400,
  breached_password: 400,
  invalid_credentials: 401,
  unauthenticated: 401,
  invalid_code: 400,
  code_expired: 400,
  too_many_attempts: 429,
  invalid_token: 401,
  mfa_required: 401,
  reauthentication_required: 403,
  email_not_verified: 403,
  forbidden: 403,
  origin_not_allowed: 403,
  account_disabled: 403,
  not_found: 404,
  email_taken: 409,
  conflict: 409,
  refresh_in_progress: 409,
  payload_too_large: 413,
  rate_limited: 429,
  server_busy: 503,
  internal_error: 500,
} as const satisfies Record<string, ContentfulStatusCode>;

export type ErrorCode = keyof typeof ErrorCodes;

export class AuthError extends Error {
  readonly status: ContentfulStatusCode;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly extra: { retryAfterSeconds?: number; details?: unknown } = {},
  ) {
    super(message);
    this.status = ErrorCodes[code];
  }
}
