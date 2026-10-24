-- Basalt Host control plane state.

CREATE TABLE workspaces (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_tokens (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  token_hash    bytea NOT NULL UNIQUE,
  name          text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);

CREATE TABLE apps (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name          text NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE environments (
  id                  text PRIMARY KEY,
  app_id              text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  kind                text NOT NULL CHECK (kind IN ('preview', 'staging', 'production')),
  slug                text NOT NULL,
  host                text NOT NULL UNIQUE,
  status              text NOT NULL DEFAULT 'provisioning',
  subnet_index        integer NOT NULL UNIQUE,
  auth_project_id     text,
  current_release_id  text,
  sleeping            boolean NOT NULL DEFAULT false,
  protection          jsonb NOT NULL DEFAULT '{}',
  csp                 jsonb NOT NULL DEFAULT '{}',
  access_key_enc      bytea,
  error               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz,
  last_active_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, slug)
);

CREATE TABLE env_vars (
  env_id     text NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  name       text NOT NULL,
  value_enc  bytea NOT NULL,
  secret     boolean NOT NULL,
  managed    boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (env_id, name)
);

CREATE TABLE deployments (
  id            text PRIMARY KEY,
  app_id        text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  source_sha    text NOT NULL,
  message       text,
  status        text NOT NULL DEFAULT 'queued',
  steps         jsonb NOT NULL DEFAULT '[]',
  manifest      jsonb,
  image         text,
  static_dir    text,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);
CREATE INDEX deployments_app_idx ON deployments (app_id, created_at DESC);

CREATE TABLE releases (
  id             text PRIMARY KEY,
  env_id         text NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  deployment_id  text NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  status         text NOT NULL DEFAULT 'starting',
  container      text,
  reason         text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  live_at        timestamptz,
  ended_at       timestamptz
);
CREATE INDEX releases_env_idx ON releases (env_id, created_at DESC);

CREATE TABLE test_runs (
  id             text PRIMARY KEY,
  env_id         text NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  deployment_id  text NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  kind           text NOT NULL,
  status         text NOT NULL DEFAULT 'running',
  summary        jsonb NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz
);
CREATE INDEX test_runs_env_idx ON test_runs (env_id, created_at DESC);

CREATE TABLE pipelines (
  id             text PRIMARY KEY,
  app_id         text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  deployment_id  text NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  target         text NOT NULL,
  status         text NOT NULL DEFAULT 'running',
  stage          text NOT NULL DEFAULT 'build',
  log            jsonb NOT NULL DEFAULT '[]',
  created_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz
);

CREATE TABLE emails (
  id          bigserial PRIMARY KEY,
  env_id      text NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  to_addr     text NOT NULL,
  subject     text NOT NULL,
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX emails_env_idx ON emails (env_id, id DESC);

CREATE TABLE audit (
  id            bigserial PRIMARY KEY,
  workspace_id  text,
  action        text NOT NULL,
  target        text,
  data          jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_ws_idx ON audit (workspace_id, id DESC);

CREATE TABLE platform_settings (
  key    text PRIMARY KEY,
  value  jsonb NOT NULL
);
