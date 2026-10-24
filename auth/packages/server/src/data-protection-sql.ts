/**
 * SQL installed into an APP's Postgres database (not the auth database). It lets Postgres itself
 * verify the caller's session-bound data grant and enforce row ownership with Row-Level Security.
 *
 * Trust model:
 *   - The grant key lives in basalt_auth.keys, readable only by the installing (admin) role through
 *     SECURITY DEFINER functions. The app's runtime role can USE grants but never MINT them, so a
 *     compromised app server, SQL injection or a missing WHERE clause cannot reach another user's rows.
 *   - The app must connect as a role that is not a superuser, has no BYPASSRLS, and does not own the
 *     basalt_auth objects or the protected tables. The SDK refuses to run otherwise in production.
 *   - No grant (or an invalid one) means uid() is NULL or raises, so protected tables return nothing.
 *
 * Idempotent: safe to run again (e.g. to install a new key version).
 */
export const DATA_PROTECTION_SQL_TEMPLATE = `
BEGIN;

CREATE SCHEMA IF NOT EXISTS basalt_auth;
REVOKE ALL ON SCHEMA basalt_auth FROM PUBLIC;
GRANT USAGE ON SCHEMA basalt_auth TO PUBLIC;

-- HMAC key material, stored pre-padded (key XOR ipad / key XOR opad) so verification needs only
-- the built-in sha256(): HMAC(k, m) = sha256(k_opad || sha256(k_ipad || m)). No extensions needed.
CREATE TABLE IF NOT EXISTS basalt_auth.keys (
  version     integer PRIMARY KEY,
  project_id  text NOT NULL,
  k_ipad      bytea NOT NULL CHECK (length(k_ipad) = 64),
  k_opad      bytea NOT NULL CHECK (length(k_opad) = 64),
  installed_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON basalt_auth.keys FROM PUBLIC;

CREATE TABLE IF NOT EXISTS basalt_auth.revoked_sessions (
  session_id  uuid PRIMARY KEY,
  revoked_at  timestamptz NOT NULL
);
REVOKE ALL ON basalt_auth.revoked_sessions FROM PUBLIC;

CREATE TABLE IF NOT EXISTS basalt_auth.sync_state (
  id                     boolean PRIMARY KEY DEFAULT true CHECK (id),
  revocations_synced_to  timestamptz
);
REVOKE ALL ON basalt_auth.sync_state FROM PUBLIC;

INSERT INTO basalt_auth.keys (version, project_id, k_ipad, k_opad)
VALUES ({{VERSION}}, '{{PROJECT_ID}}', '\\x{{K_IPAD}}'::bytea, '\\x{{K_OPAD}}'::bytea)
ON CONFLICT (version) DO UPDATE SET project_id = EXCLUDED.project_id, k_ipad = EXCLUDED.k_ipad,
  k_opad = EXCLUDED.k_opad, installed_at = now();

-- The verified user for this transaction, from the grant in the 'basalt.grant' setting.
-- NULL when no grant is set; raises (SQLSTATE 28000) when a grant is present but invalid.
CREATE OR REPLACE FUNCTION basalt_auth.uid() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  g      text := current_setting('basalt.grant', true);
  parts  text[];
  k      record;
  mac    bytea;
BEGIN
  IF g IS NULL OR g = '' THEN
    RETURN NULL;
  END IF;
  -- bdg1.<keyVersion>.<projectId>.<userId>.<sessionId>.<expEpoch>.<hmacHex>
  IF g !~ '^bdg1\\.[0-9]{1,6}\\.prj_[A-Za-z0-9]{1,64}\\.[0-9a-f-]{36}\\.[0-9a-f-]{36}\\.[0-9]{1,12}\\.[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'basalt_auth: malformed data grant' USING ERRCODE = '28000';
  END IF;
  parts := string_to_array(g, '.');
  SELECT * INTO k FROM basalt_auth.keys WHERE version = parts[2]::integer AND project_id = parts[3];
  IF NOT FOUND THEN
    RAISE EXCEPTION 'basalt_auth: data grant is for another project or an unknown key' USING ERRCODE = '28000';
  END IF;
  mac := sha256(k.k_opad || sha256(k.k_ipad || convert_to(array_to_string(parts[1:6], '.'), 'UTF8')));
  -- Compare digests of the MACs so the comparison time doesn't depend on a matching prefix.
  IF sha256(mac) <> sha256(decode(parts[7], 'hex')) THEN
    RAISE EXCEPTION 'basalt_auth: invalid data grant' USING ERRCODE = '28000';
  END IF;
  IF parts[6]::bigint <= extract(epoch FROM now()) THEN
    RAISE EXCEPTION 'basalt_auth: data grant expired' USING ERRCODE = '28000';
  END IF;
  IF EXISTS (SELECT 1 FROM basalt_auth.revoked_sessions WHERE session_id = parts[5]::uuid) THEN
    RAISE EXCEPTION 'basalt_auth: session revoked' USING ERRCODE = '28000';
  END IF;
  RETURN parts[4]::uuid;
END
$fn$;

-- Sets the grant for the current transaction and returns the verified user id (raises if none).
CREATE OR REPLACE FUNCTION basalt_auth.authenticate(data_grant text) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  u uuid;
BEGIN
  PERFORM set_config('basalt.grant', coalesce(data_grant, ''), true);
  u := basalt_auth.uid();
  IF u IS NULL THEN
    RAISE EXCEPTION 'basalt_auth: no data grant' USING ERRCODE = '28000';
  END IF;
  RETURN u;
END
$fn$;

-- Revocation sync (called by the SDK). Adding revocations can only ever reduce access.
CREATE OR REPLACE FUNCTION basalt_auth.record_revocations(session_ids uuid[], revoked_ats timestamptz[], synced_to timestamptz)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
BEGIN
  INSERT INTO basalt_auth.revoked_sessions (session_id, revoked_at)
  SELECT * FROM unnest(session_ids, revoked_ats)
  ON CONFLICT (session_id) DO NOTHING;
  -- Grants live at most 1 hour, so older revocations are no longer needed.
  DELETE FROM basalt_auth.revoked_sessions WHERE revoked_at < now() - interval '2 hours';
  INSERT INTO basalt_auth.sync_state (id, revocations_synced_to) VALUES (true, synced_to)
  ON CONFLICT (id) DO UPDATE SET revocations_synced_to = GREATEST(basalt_auth.sync_state.revocations_synced_to, EXCLUDED.revocations_synced_to);
END
$fn$;

CREATE OR REPLACE FUNCTION basalt_auth.revocations_synced_to() RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT revocations_synced_to FROM basalt_auth.sync_state WHERE id
$fn$;

-- One call makes a table owner-only: RLS on (and forced for the table owner too), owner column
-- defaults to the verified user, and reads/writes are limited to rows the caller owns.
-- Run it in your migrations (as the migration role) for every table holding per-user data.
CREATE OR REPLACE FUNCTION basalt_auth.protect(tbl regclass, owner_column name DEFAULT 'owner_id')
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  coltype regtype;
BEGIN
  SELECT atttypid::regtype INTO coltype FROM pg_attribute
   WHERE attrelid = tbl AND attname = owner_column AND NOT attisdropped;
  IF coltype IS NULL THEN
    RAISE EXCEPTION 'basalt_auth.protect: table % has no column %', tbl, owner_column;
  END IF;
  IF coltype <> 'uuid'::regtype THEN
    RAISE EXCEPTION 'basalt_auth.protect: %.% must be uuid (the Basalt user id), not %', tbl, owner_column, coltype;
  END IF;
  EXECUTE format('ALTER TABLE %s ALTER COLUMN %I SET NOT NULL', tbl, owner_column);
  EXECUTE format('ALTER TABLE %s ALTER COLUMN %I SET DEFAULT basalt_auth.uid()', tbl, owner_column);
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);
  EXECUTE format('DROP POLICY IF EXISTS basalt_owner ON %s', tbl);
  EXECUTE format(
    'CREATE POLICY basalt_owner ON %s FOR ALL USING (%I = (SELECT basalt_auth.uid())) WITH CHECK (%I = (SELECT basalt_auth.uid()))',
    tbl, owner_column, owner_column);
END
$fn$;

-- Lists tables that look like they hold per-user data but are not protected.
CREATE OR REPLACE FUNCTION basalt_auth.unprotected_tables()
RETURNS TABLE (table_name text, owner_like_column name)
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT c.oid::regclass::text, a.attname
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid AND NOT a.attisdropped AND a.attnum > 0
  WHERE c.relkind IN ('r', 'p')
    AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'basalt_auth')
    AND a.attname IN ('owner_id', 'user_id', 'created_by', 'author_id', 'account_id')
    AND NOT (c.relrowsecurity AND c.relforcerowsecurity)
$fn$;

GRANT EXECUTE ON FUNCTION basalt_auth.uid(), basalt_auth.authenticate(text),
  basalt_auth.record_revocations(uuid[], timestamptz[], timestamptz), basalt_auth.revocations_synced_to(),
  basalt_auth.unprotected_tables() TO PUBLIC;

COMMIT;
`;

export function renderDataProtectionSql(input: { projectId: string; version: number; kIpad: Buffer; kOpad: Buffer }) {
  if (!/^prj_[A-Za-z0-9]+$/.test(input.projectId) || !Number.isInteger(input.version)) throw new Error('bad input');
  return DATA_PROTECTION_SQL_TEMPLATE.replace('{{PROJECT_ID}}', input.projectId)
    .replace('{{VERSION}}', String(input.version))
    .replace('{{K_IPAD}}', input.kIpad.toString('hex'))
    .replace('{{K_OPAD}}', input.kOpad.toString('hex'));
}
