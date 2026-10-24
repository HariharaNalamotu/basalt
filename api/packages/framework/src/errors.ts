/**
 * Every error the framework emits, with its HTTP status. Handlers throw these (via `errors.*`);
 * anything else becomes a generic 500 so internals never leak to clients.
 */
export const ERROR_STATUS = {
  invalid_request: 400,
  malformed_json: 400,
  unauthenticated: 401,
  forbidden: 403,
  email_not_verified: 403,
  mfa_required: 403,
  reauthentication_required: 403,
  direct_access_forbidden: 403,
  origin_not_allowed: 403,
  not_found: 404,
  method_not_allowed: 405,
  conflict: 409,
  idempotency_in_progress: 409,
  gone: 410,
  precondition_failed: 412,
  payload_too_large: 413,
  unsupported_media_type: 415,
  validation_failed: 422,
  idempotency_key_reused: 422,
  rate_limited: 429,
  internal_error: 500,
  service_unavailable: 503,
  transaction_conflict: 503,
  timeout: 504,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export interface ValidationIssue {
  /** Where the problem is: "body.title", "query.limit", "params.id". */
  path: string;
  message: string;
}

export class ApiError extends Error {
  override readonly name = 'ApiError';
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly extra: { details?: ValidationIssue[] | Record<string, unknown>; retryAfterSeconds?: number; allow?: string[] } = {},
  ) {
    super(message);
    this.status = ERROR_STATUS[code];
  }
}

/** Throw these from handlers. Messages are shown to end users: keep them free of internals. */
export const errors = {
  badRequest: (message = 'The request is invalid.', details?: ValidationIssue[]) => new ApiError('invalid_request', message, { details }),
  validation: (details: ValidationIssue[], message = 'Some fields are invalid.') => new ApiError('validation_failed', message, { details }),
  unauthenticated: (message = 'Sign in required.') => new ApiError('unauthenticated', message),
  /** The user is known but not allowed. For resources they shouldn't know exist, prefer notFound. */
  forbidden: (message = "You don't have permission to do that.") => new ApiError('forbidden', message),
  notFound: (message = 'Not found.') => new ApiError('not_found', message),
  conflict: (message = 'That conflicts with the current state.', details?: Record<string, unknown>) => new ApiError('conflict', message, { details }),
  gone: (message = 'This no longer exists.') => new ApiError('gone', message),
  preconditionFailed: (message = 'The resource changed since you last loaded it.') => new ApiError('precondition_failed', message),
  tooManyRequests: (retryAfterSeconds = 1) => new ApiError('rate_limited', 'Too many requests. Please slow down.', { retryAfterSeconds }),
  unavailable: (retryAfterSeconds = 1, message = 'Temporarily unavailable. Please retry.') =>
    new ApiError('service_unavailable', message, { retryAfterSeconds }),
};

/**
 * Translates Postgres errors into the right HTTP answer, so a unique-violation is a 409 and a
 * malformed uuid is a 400 instead of a mystery 500. Returns null for errors that really are 500s.
 */
export function fromDatabaseError(err: unknown): ApiError | null {
  const e = err as { code?: unknown; constraint?: unknown; column?: unknown } | null;
  if (!e || typeof e.code !== 'string' || !/^[0-9A-Z]{5}$/.test(e.code)) return null;
  const constraint = typeof e.constraint === 'string' ? e.constraint : undefined;
  switch (e.code) {
    case '23505':
      return new ApiError('conflict', 'That already exists.', { details: constraint ? { constraint } : undefined });
    case '23503':
      return new ApiError('conflict', 'That refers to something that does not exist, or is still in use.', {
        details: constraint ? { constraint } : undefined,
      });
    case '23502':
    case '23514':
    case '22001':
    case '22003':
      return new ApiError('validation_failed', 'A value is missing, too long, or out of range.', {
        details: constraint ? { constraint } : undefined,
      });
    case '22P02':
    case '22007':
    case '22008':
      return new ApiError('invalid_request', 'A value has the wrong format.');
    case '42501': // RLS WITH CHECK failure: writing a row the user doesn't own
      return new ApiError('forbidden', "You don't have permission to do that.");
    case '28000':
      return new ApiError('unauthenticated', 'Session is no longer valid. Please sign in again.');
    case '40001':
    case '40P01':
      return new ApiError('transaction_conflict', 'The request conflicted with another one. Please retry.', { retryAfterSeconds: 1 });
    case '57014':
      return new ApiError('timeout', 'The request took too long.');
    case '53300':
    case '57P01':
    case '57P03':
      return new ApiError('service_unavailable', 'Temporarily unavailable. Please retry.', { retryAfterSeconds: 2 });
    default:
      return null;
  }
}
