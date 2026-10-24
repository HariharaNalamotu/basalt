export interface UserRow {
  id: string;
  project_id: string;
  email: string;
  email_normalized: string;
  email_verified_at: Date | null;
  password_hash: string | null;
  password_changed_at: Date | null;
  totp_secret_enc: Buffer | null;
  totp_enabled_at: Date | null;
  totp_last_step: string | null;
  metadata: Record<string, unknown>;
  disabled_at: Date | null;
  last_sign_in_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** The only user shape that ever leaves the service. Secrets and hashes are never included. */
export interface PublicUser {
  id: string;
  email: string;
  emailVerified: boolean;
  mfaEnabled: boolean;
  metadata: Record<string, unknown>;
  disabled: boolean;
  createdAt: string;
  lastSignInAt: string | null;
}

export function toPublicUser(u: UserRow): PublicUser {
  return {
    id: u.id,
    email: u.email,
    emailVerified: u.email_verified_at !== null,
    mfaEnabled: u.totp_enabled_at !== null,
    metadata: u.metadata ?? {},
    disabled: u.disabled_at !== null,
    createdAt: u.created_at.toISOString(),
    lastSignInAt: u.last_sign_in_at?.toISOString() ?? null,
  };
}
