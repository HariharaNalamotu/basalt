-- Basalt Auth: initial schema.
-- Conventions:
--   * Every secret (tokens, codes, keys) is stored hashed or encrypted. Never plaintext.
--   * Every tenant-scoped row carries project_id and every lookup filters on it.
--   * Timestamps are timestamptz, set by the application clock unless noted.

CREATE TABLE auth_projects (
  id                 text PRIMARY KEY,
  name               text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  secret_key_hash    bytea NOT NULL,
  secret_key_hint    text NOT NULL,
  allowed_origins    text[] NOT NULL DEFAULT '{}',
  settings           jsonb NOT NULL DEFAULT '{}',
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX auth_projects_secret_key_hash_idx ON auth_projects (secret_key_hash);

-- Per-project Ed25519 signing keys. Private keys are AES-256-GCM encrypted with the master key.
CREATE TABLE auth_signing_keys (
  kid                text PRIMARY KEY,
  project_id         text NOT NULL REFERENCES auth_projects(id) ON DELETE CASCADE,
  public_jwk         jsonb NOT NULL,
  private_key_enc    bytea NOT NULL,
  status             text NOT NULL CHECK (status IN ('active', 'retiring', 'retired')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  retired_at         timestamptz
);
CREATE UNIQUE INDEX auth_signing_keys_one_active_idx ON auth_signing_keys (project_id) WHERE status = 'active';
CREATE INDEX auth_signing_keys_project_idx ON auth_signing_keys (project_id, status);

CREATE TABLE auth_users (
  id                   uuid PRIMARY KEY,
  project_id           text NOT NULL REFERENCES auth_projects(id) ON DELETE CASCADE,
  email                text NOT NULL,
  email_normalized     text NOT NULL,
  email_verified_at    timestamptz,
  password_hash        text,
  password_changed_at  timestamptz,
  totp_secret_enc      bytea,
  totp_enabled_at      timestamptz,
  totp_last_step       bigint,
  metadata             jsonb NOT NULL DEFAULT '{}',
  disabled_at          timestamptz,
  last_sign_in_at      timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, email_normalized)
);
CREATE INDEX auth_users_project_created_idx ON auth_users (project_id, created_at, id);

-- Signups awaiting email verification. No user row exists until the email is proven,
-- which makes account pre-hijacking impossible. Each pending signup is bound to the
-- device that created it via signup_token_hash.
CREATE TABLE auth_pending_signups (
  id                 uuid PRIMARY KEY,
  project_id         text NOT NULL REFERENCES auth_projects(id) ON DELETE CASCADE,
  email              text NOT NULL,
  email_normalized   text NOT NULL,
  password_hash      text NOT NULL,
  signup_token_hash  bytea NOT NULL UNIQUE,
  code_hash          bytea NOT NULL,
  attempts           integer NOT NULL DEFAULT 0,
  expires_at         timestamptz NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_pending_signups_email_idx ON auth_pending_signups (project_id, email_normalized);
CREATE INDEX auth_pending_signups_expires_idx ON auth_pending_signups (expires_at);

-- Short numeric codes sent by email (password reset, verifying an existing account's email).
-- Codes are HMAC'd with a server-side pepper so a DB leak does not allow offline guessing.
CREATE TABLE auth_email_codes (
  id                 uuid PRIMARY KEY,
  project_id         text NOT NULL REFERENCES auth_projects(id) ON DELETE CASCADE,
  user_id            uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  purpose            text NOT NULL CHECK (purpose IN ('reset_password', 'verify_email')),
  code_hash          bytea NOT NULL,
  attempts           integer NOT NULL DEFAULT 0,
  expires_at         timestamptz NOT NULL,
  consumed_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_email_codes_user_idx ON auth_email_codes (user_id, purpose) WHERE consumed_at IS NULL;
CREATE INDEX auth_email_codes_expires_idx ON auth_email_codes (expires_at);

CREATE TABLE auth_sessions (
  id                 uuid PRIMARY KEY,
  project_id         text NOT NULL REFERENCES auth_projects(id) ON DELETE CASCADE,
  user_id            uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  amr                text[] NOT NULL,
  ip                 text,
  user_agent         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_active_at     timestamptz NOT NULL DEFAULT now(),
  idle_expires_at    timestamptz NOT NULL,
  expires_at         timestamptz NOT NULL,
  revoked_at         timestamptz,
  revoke_reason      text,
  -- Refresh tokens are HMAC(refresh_secret, generation). Only the current generation is
  -- accepted; presenting any older genuine token is proof of theft and revokes the session.
  -- O(1) storage per session no matter how many times it is refreshed.
  refresh_secret_enc   bytea NOT NULL,
  refresh_generation   integer NOT NULL DEFAULT 0,
  refresh_rotated_at   timestamptz
);
CREATE INDEX auth_sessions_user_active_idx ON auth_sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX auth_sessions_expires_idx ON auth_sessions (expires_at);

-- Second step of a sign-in for users with MFA enabled.
CREATE TABLE auth_mfa_challenges (
  token_hash         bytea PRIMARY KEY,
  project_id         text NOT NULL REFERENCES auth_projects(id) ON DELETE CASCADE,
  user_id            uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  attempts           integer NOT NULL DEFAULT 0,
  expires_at         timestamptz NOT NULL,
  consumed_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_mfa_challenges_expires_idx ON auth_mfa_challenges (expires_at);

CREATE TABLE auth_recovery_codes (
  user_id            uuid NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  code_hash          bytea NOT NULL,
  used_at            timestamptz,
  PRIMARY KEY (user_id, code_hash)
);

-- Append-only security audit log.
CREATE TABLE auth_events (
  id                 bigserial PRIMARY KEY,
  project_id         text NOT NULL REFERENCES auth_projects(id) ON DELETE CASCADE,
  user_id            uuid,
  type               text NOT NULL,
  ip                 text,
  user_agent         text,
  data               jsonb NOT NULL DEFAULT '{}',
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_events_project_idx ON auth_events (project_id, id DESC);
CREATE INDEX auth_events_user_idx ON auth_events (user_id, id DESC) WHERE user_id IS NOT NULL;
