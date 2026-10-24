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
ALTER TABLE basalt_auth.keys ADD COLUMN IF NOT EXISTS issuer text;
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

INSERT INTO basalt_auth.keys (version, project_id, k_ipad, k_opad, issuer)
VALUES ({{VERSION}}, '{{PROJECT_ID}}', '\\x{{K_IPAD}}'::bytea, '\\x{{K_OPAD}}'::bytea, '{{ISSUER}}')
ON CONFLICT (version) DO UPDATE SET project_id = EXCLUDED.project_id, k_ipad = EXCLUDED.k_ipad,
  k_opad = EXCLUDED.k_opad, issuer = EXCLUDED.issuer, installed_at = now();

CREATE OR REPLACE FUNCTION basalt_auth.b64url_decode(s text) RETURNS bytea
LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT decode(rpad(translate(s, '-_', '+/'), ((length(s) + 3) / 4) * 4, '='), 'base64')
$fn$;

-- True only for the one exact base64url spelling of its bytes (blocks alternate encodings).
CREATE OR REPLACE FUNCTION basalt_auth.b64url_canonical(s text) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog, pg_temp AS $fn$
  SELECT rtrim(translate(replace(encode(basalt_auth.b64url_decode(s), 'base64'), E'\\n', ''), '+/', '-_'), '=') = s
$fn$;

-- The verified user for this transaction, from the data token in the 'basalt.grant' setting.
-- The token is the HS256 JWT Basalt Auth issues (the same one the Data block's basalt.uid()
-- accepts). NULL when no token is set; raises (SQLSTATE 28000) when a token is present but invalid.
CREATE OR REPLACE FUNCTION basalt_auth.uid() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE
  g        text := current_setting('basalt.grant', true);
  parts    text[];
  header   jsonb;
  payload  jsonb;
  k        record;
  mac      bytea;
  -- This statement's start, not the transaction's: an old transaction can't outlive its token.
  now_s    numeric := extract(epoch FROM statement_timestamp());
  exp_s    numeric;
  iat_s    numeric;
BEGIN
  IF g IS NULL OR g = '' THEN
    RETURN NULL;
  END IF;
  IF length(g) > 4096 OR g !~ '^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]{43}$' THEN
    RAISE EXCEPTION 'basalt_auth: malformed data token' USING ERRCODE = '28000';
  END IF;
  parts := string_to_array(g, '.');
  BEGIN
    IF NOT (basalt_auth.b64url_canonical(parts[1]) AND basalt_auth.b64url_canonical(parts[2]) AND basalt_auth.b64url_canonical(parts[3])) THEN
      RAISE EXCEPTION 'basalt_auth: malformed data token' USING ERRCODE = '28000';
    END IF;
    header := convert_from(basalt_auth.b64url_decode(parts[1]), 'UTF8')::jsonb;
    payload := convert_from(basalt_auth.b64url_decode(parts[2]), 'UTF8')::jsonb;
  EXCEPTION WHEN data_exception THEN
    RAISE EXCEPTION 'basalt_auth: malformed data token' USING ERRCODE = '28000';
  END;
  IF jsonb_typeof(header) IS DISTINCT FROM 'object' OR header->>'alg' IS DISTINCT FROM 'HS256' OR header ? 'crit'
     OR coalesce(header->>'kid', '') !~ '^v[0-9]{1,6}$' THEN
    RAISE EXCEPTION 'basalt_auth: malformed data token' USING ERRCODE = '28000';
  END IF;
  SELECT * INTO k FROM basalt_auth.keys WHERE version = substr(header->>'kid', 2)::integer;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'basalt_auth: data token signed with an unknown key' USING ERRCODE = '28000';
  END IF;
  mac := sha256(k.k_opad || sha256(k.k_ipad || convert_to(parts[1] || '.' || parts[2], 'UTF8')));
  -- Compare digests of the MACs so timing doesn't depend on a matching prefix.
  IF sha256(mac) <> sha256(basalt_auth.b64url_decode(parts[3])) THEN
    IF jsonb_typeof(payload) = 'object' AND payload->>'iss' IS DISTINCT FROM k.issuer THEN
      RAISE EXCEPTION 'basalt_auth: data token is for another project' USING ERRCODE = '28000';
    END IF;
    RAISE EXCEPTION 'basalt_auth: invalid data token signature' USING ERRCODE = '28000';
  END IF;
  -- Signature verified: the payload below came from Basalt Auth.
  IF jsonb_typeof(payload) IS DISTINCT FROM 'object'
     OR jsonb_typeof(payload->'exp') IS DISTINCT FROM 'number' OR jsonb_typeof(payload->'iat') IS DISTINCT FROM 'number'
     OR coalesce(payload->>'sub', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR coalesce(payload->>'sid', '') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR payload->>'aud' IS DISTINCT FROM 'authenticated' OR payload->>'role' IS DISTINCT FROM 'authenticated'
     OR payload->>'iss' IS DISTINCT FROM k.issuer THEN
    RAISE EXCEPTION 'basalt_auth: invalid data token claims' USING ERRCODE = '28000';
  END IF;
  exp_s := (payload->'exp')::numeric;
  iat_s := (payload->'iat')::numeric;
  IF exp_s <> trunc(exp_s) OR iat_s <> trunc(iat_s) OR exp_s - iat_s > 3600 OR iat_s > now_s + 60 THEN
    RAISE EXCEPTION 'basalt_auth: invalid data token claims' USING ERRCODE = '28000';
  END IF;
  IF exp_s <= now_s THEN
    RAISE EXCEPTION 'basalt_auth: data token expired' USING ERRCODE = '28000';
  END IF;
  IF EXISTS (SELECT 1 FROM basalt_auth.revoked_sessions WHERE session_id = (payload->>'sid')::uuid) THEN
    RAISE EXCEPTION 'basalt_auth: session revoked' USING ERRCODE = '28000';
  END IF;
  RETURN (payload->>'sub')::uuid;
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

export function renderDataProtectionSql(input: { projectId: string; version: number; kIpad: Buffer; kOpad: Buffer; issuer: string }) {
  if (!/^prj_[A-Za-z0-9]+$/.test(input.projectId) || !Number.isInteger(input.version)) throw new Error('bad input');
  if (!/^https?:\/\/[A-Za-z0-9.:/_-]+$/.test(input.issuer)) throw new Error('bad issuer');
  return DATA_PROTECTION_SQL_TEMPLATE.replace('{{PROJECT_ID}}', input.projectId)
    .replace('{{VERSION}}', String(input.version))
    .replace('{{K_IPAD}}', input.kIpad.toString('hex'))
    .replace('{{K_OPAD}}', input.kOpad.toString('hex'))
    .replace('{{ISSUER}}', input.issuer);
}
