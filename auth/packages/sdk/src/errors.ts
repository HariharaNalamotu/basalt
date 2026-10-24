/** Every error code the auth service can return. Switch on `code`, never on `message`. */
export type AuthErrorCode =
  | 'invalid_request'
  | 'weak_password'
  | 'breached_password'
  | 'invalid_credentials'
  | 'unauthenticated'
  | 'invalid_code'
  | 'code_expired'
  | 'too_many_attempts'
  | 'invalid_token'
  | 'mfa_required'
  | 'email_not_verified'
  | 'forbidden'
  | 'origin_not_allowed'
  | 'account_disabled'
  | 'not_found'
  | 'email_taken'
  | 'conflict'
  | 'refresh_in_progress'
  | 'payload_too_large'
  | 'rate_limited'
  | 'server_busy'
  | 'internal_error'
  | 'network_error';

export class BasaltAuthError extends Error {
  override readonly name = 'BasaltAuthError';
  constructor(
    readonly code: AuthErrorCode,
    message: string,
    readonly status: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

export async function toAuthError(res: Response): Promise<BasaltAuthError> {
  let code: AuthErrorCode = 'internal_error';
  let message = `Request failed with status ${res.status}`;
  try {
    const body = (await res.json()) as { error?: { code?: AuthErrorCode; message?: string } };
    if (body.error?.code) code = body.error.code;
    if (body.error?.message) message = body.error.message;
  } catch {
    /* non-JSON error body */
  }
  const retry = Number(res.headers.get('retry-after'));
  return new BasaltAuthError(code, message, res.status, Number.isFinite(retry) && retry > 0 ? retry : undefined);
}
