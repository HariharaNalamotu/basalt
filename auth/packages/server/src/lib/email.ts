import { AuthError } from './errors.js';

const MAX_EMAIL_LENGTH = 254;
// Pragmatic check: one @, non-empty local part, dotted domain, no whitespace or control chars.
const EMAIL_RE = /^[^\s@"<>()[\]\\,;:\u0000-\u001f\u007f]+@[^\s@"<>()[\]\\,;:\u0000-\u001f\u007f]+\.[^\s@"<>()[\]\\,;:\u0000-\u001f\u007f.]{2,}$/u;

export interface NormalizedEmail {
  /** As the user typed it (trimmed, NFC) — used when sending mail. */
  display: string;
  /** Canonical key for uniqueness and lookups. */
  normalized: string;
}

export function normalizeEmail(input: unknown): NormalizedEmail {
  if (typeof input !== 'string') throw new AuthError('invalid_request', 'A valid email address is required.');
  const display = input.trim().normalize('NFC');
  if (display.length === 0 || display.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(display)) {
    throw new AuthError('invalid_request', 'A valid email address is required.');
  }
  return { display, normalized: display.normalize('NFKC').toLowerCase() };
}
