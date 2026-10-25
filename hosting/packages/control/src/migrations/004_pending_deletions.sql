-- An app Claude asked to delete. Nothing is removed until the owner taps Confirm in their
-- dashboard; Cancel (or 24 hours passing) drops the request.
CREATE TABLE IF NOT EXISTS pending_deletions (
  app_id        text PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  workspace_id  text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  requested_at  timestamptz NOT NULL DEFAULT now()
);
