-- Clients an owner always lets through on their own apps (their own machine, a security test):
-- never banned and never rate limited there. `ip` is the edge's bucket (IPv4, or an IPv6 /64).
CREATE TABLE IF NOT EXISTS allowlist (
  workspace_id  text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ip            text NOT NULL,
  label         text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, ip)
);
