-- Database-enforced data ownership ("data grants") and step-up re-authentication.

-- Per-project key that signs data grants. Encrypted with the master key; created lazily.
ALTER TABLE auth_projects
  ADD COLUMN data_key_enc bytea,
  ADD COLUMN data_key_version integer NOT NULL DEFAULT 1;

-- When the user last proved who they are in this session (sign-in or re-authentication).
ALTER TABLE auth_sessions ADD COLUMN authenticated_at timestamptz;
UPDATE auth_sessions SET authenticated_at = created_at WHERE authenticated_at IS NULL;
ALTER TABLE auth_sessions
  ALTER COLUMN authenticated_at SET NOT NULL,
  ALTER COLUMN authenticated_at SET DEFAULT now();

-- Append-only feed of sessions that stopped being valid early (revoked, or deleted with their
-- user/project). App databases pull it so revoked sessions lose data access before their grants
-- expire. Written by trigger, so no code path can forget to record a revocation.
CREATE TABLE auth_session_revocations (
  id           bigserial PRIMARY KEY,
  project_id   text NOT NULL,
  session_id   uuid NOT NULL,
  revoked_at   timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX auth_session_revocations_feed_idx ON auth_session_revocations (project_id, revoked_at, id);

CREATE FUNCTION auth_record_session_revocation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
      INSERT INTO auth_session_revocations (project_id, session_id) VALUES (NEW.project_id, NEW.id);
    END IF;
    RETURN NEW;
  END IF;
  -- DELETE: a still-live session disappearing (user or project deleted) is a revocation too.
  IF OLD.revoked_at IS NULL AND OLD.expires_at > now() AND OLD.idle_expires_at > now() THEN
    INSERT INTO auth_session_revocations (project_id, session_id) VALUES (OLD.project_id, OLD.id);
  END IF;
  RETURN OLD;
END $$;

CREATE TRIGGER auth_sessions_revocation_feed
  AFTER UPDATE OF revoked_at OR DELETE ON auth_sessions
  FOR EACH ROW EXECUTE FUNCTION auth_record_session_revocation();
