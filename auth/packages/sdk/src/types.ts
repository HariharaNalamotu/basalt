export interface User {
  id: string;
  email: string;
  emailVerified: boolean;
  mfaEnabled: boolean;
  /** App-controlled data, writable only from your backend (secret key). Safe to trust for roles. */
  metadata: Record<string, unknown>;
  disabled: boolean;
  createdAt: string;
  lastSignInAt: string | null;
}

export interface SessionInfo {
  id: string;
  createdAt: string;
  lastActiveAt: string;
  expiresAt: string;
  ip: string | null;
  userAgent: string | null;
  amr: string[];
  current: boolean;
}
