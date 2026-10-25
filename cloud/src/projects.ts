import { readdirSync, readFileSync } from 'node:fs';
import { migrate, parseContract, pg, runSql, type Contract } from '../../data/src/index.ts';
import type { AuthLink } from './auth.ts';
import { decrypt, encrypt, randomId, randomSecret, sameHash, sha256 } from './secrets.ts';

// Basalt Cloud's own records live in the cluster's postgres database, in a
// schema only the superuser can reach. Each app gets its own database and its
// own three roles, so no key for one app opens another.

const SQL_DIR = new URL('../../data/sql/', import.meta.url);
// Approval links stop working after this many days. Claude can always ask for a fresh one.
const APPROVAL_DAYS = 7;

export interface CloudConfig {
  // Superuser connection to the postgres database.
  adminUrl: string;
  // Host and port apps' data logins connect to (usually the same server).
  dbHost: string;
  masterKey: string;
}

export class ConflictError extends Error {}

export interface Project {
  id: string;
  name: string;
  dbName: string;
  roles: { owner: string; exec: string; data: string };
  dataPassword: string;
  // Basalt Auth project whose data tokens this app's database accepts, and the Auth
  // workspace it belongs to (Cloud's own, or the hosting platform workspace that owns the app).
  authProjectId: string | null;
  authOwner: string;
  approvedContract: unknown | null;
  // Made by the hosting platform for one of its environments, served on that app's own site.
  hosted: boolean;
}

export interface Approval {
  id: string;
  projectId: string;
  kind: 'rules' | 'admin';
  contract: unknown;
  admin?: { uid: string; label: string };
  status: 'pending' | 'approved' | 'rejected' | 'replaced';
  // Still pending, but older than the link's lifetime.
  expired: boolean;
}

function withDb(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

async function connect(url: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url });
  // Deleting an app drops its database WITH (FORCE), which ends every session on it, including
  // one a revocation sync or rule change is using right then. Its query still fails (and the
  // caller handles that); without a listener the 'error' event would take down all of Cloud.
  client.on('error', () => {});
  await client.connect();
  return client;
}

export class Projects {
  #cfg: CloudConfig;
  #pool: pg.Pool;

  #auth: AuthLink;

  constructor(cfg: CloudConfig, auth: AuthLink) {
    this.#cfg = cfg;
    this.#auth = auth;
    this.#pool = new pg.Pool({ connectionString: cfg.adminUrl, max: 5, application_name: 'basalt-cloud' });
    this.#pool.on('error', () => {});
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }

  async init(): Promise<void> {
    const c = await this.#pool.connect();
    try {
      // Two servers starting at once would race to create the same objects.
      await c.query(`
        begin;
        select pg_advisory_xact_lock(hashtext('basalt cloud init'));
        create schema if not exists cloud;
        revoke all on schema cloud from public;
        create table if not exists cloud.projects (
          id text primary key,
          name text not null,
          db_name text not null unique,
          owner_role text not null,
          exec_role text not null,
          data_role text not null,
          data_password text not null,
          jwt_secret text not null,
          admin_key_hash text not null,
          approved_contract jsonb,
          created_at timestamptz not null default now()
        );
        create table if not exists cloud.approvals (
          id text primary key,
          project_id text not null references cloud.projects (id),
          token_hash text not null,
          contract jsonb not null,
          status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'replaced')),
          created_at timestamptz not null default now(),
          decided_at timestamptz
        );
        alter table cloud.projects add column if not exists owner_view_key text;
        alter table cloud.approvals add column if not exists kind text not null default 'rules' check (kind in ('rules', 'admin'));
        alter table cloud.approvals add column if not exists admin_uid uuid;
        alter table cloud.approvals add column if not exists admin_label text;
        alter table cloud.approvals alter column contract drop not null;
        alter table cloud.projects add column if not exists auth_project_id text;
        alter table cloud.projects add column if not exists auth_owner text;
        -- The hosting platform's id for the environment a project belongs to (one each).
        alter table cloud.projects add column if not exists external_id text;
        create unique index if not exists projects_external_id on cloud.projects (external_id) where external_id is not null;
        alter table cloud.projects add column if not exists hosted boolean not null default false;

        create table if not exists cloud.checks (
          id bigint generated always as identity primary key,
          project_id text not null references cloud.projects (id),
          results jsonb not null,
          findings jsonb not null,
          created_at timestamptz not null default now()
        );
        create index if not exists checks_project_recent on cloud.checks (project_id, created_at desc);
        alter table cloud.checks alter column findings drop not null;
        alter table cloud.checks add column if not exists contract_hash text;
        commit;`);
    } catch (err) {
      await c.query('rollback').catch(() => {});
      throw err;
    } finally {
      c.release();
    }
    // Projects the hosting platform made before the hosted flag existed belong to its workspaces.
    await this.#pool.query('update cloud.projects set hosted = true where not hosted and auth_owner is not null and auth_owner <> $1', [this.#auth.defaultOwner]);
  }


  // Setup changes roles and grants shared by every database on the server, and Postgres
  // refuses two of those at once. So app setups take turns, across all Cloud instances.
  async #createDatabase(dbName: string, vars: Record<string, string>): Promise<void> {
    // A connection of its own: holding a pool connection while the work below takes more from
    // the same pool deadlocks once enough setups wait at once.
    const lock = await connect(this.#cfg.adminUrl);
    try {
      await lock.query("select pg_advisory_lock(hashtext('basalt cloud create database'))");
      await lock.query(`create database "${dbName}"`);
      const appDb = await connect(withDb(this.#cfg.adminUrl, dbName));
      try {
        for (const file of readdirSync(SQL_DIR).filter((f) => f.endsWith('.sql')).sort()) {
          await runSql(appDb, readFileSync(new URL(file, SQL_DIR), 'utf8'), vars);
        }
      } finally {
        await appDb.end();
      }
    } finally {
      await lock.end().catch(() => {}); // ending the session releases the lock
    }
  }

  // Makes a brand new database for one app and locks it down. Its database accepts exactly
  // the data tokens Basalt Auth issues for the app's Auth project.
  // `attach` binds the database to an existing Auth project (the hosting platform's environments)
  // instead of making a new one; only the platform API can ask for that.
  async create(name: string, attach?: { authProjectId: string; authOwner: string; externalId?: string }): Promise<{ project: Project; adminKey: string }> {
    if (!attach?.externalId) return this.#create(name, attach);
    // Asking again for the same environment (a retry, or a lost reply) returns its database
    // with a fresh admin key instead of making a second one.
    const lock = await connect(this.#cfg.adminUrl);
    const tag = `basalt cloud env ${attach.externalId}`;
    try {
      await lock.query('select pg_advisory_lock(hashtext($1))', [tag]);
      const row = (await lock.query('select id, auth_project_id, auth_owner from cloud.projects where external_id = $1', [attach.externalId])).rows[0];
      if (row && (row.auth_project_id !== attach.authProjectId || row.auth_owner !== attach.authOwner)) {
        // Its database only accepts the old Auth project's tokens. Reusing it would fail every login.
        throw new ConflictError('This environment already has a data project tied to a different Auth project. Delete the environment\'s data project first.');
      }
      if (row) {
        const adminKey = `bsk_${row.id}_${randomSecret()}`;
        await lock.query('update cloud.projects set admin_key_hash = $2 where id = $1', [row.id, sha256(adminKey)]);
        return { project: (await this.get(row.id))!, adminKey };
      }
      return await this.#create(name, attach);
    } finally {
      await lock.end().catch(() => {});
    }
  }

  async #create(name: string, attach?: { authProjectId: string; authOwner: string; externalId?: string }): Promise<{ project: Project; adminKey: string }> {
    const id = randomId();
    const dbName = `app_${id}`;
    const roles = { owner: `${dbName}_owner`, exec: `${dbName}_exec`, data: `${dbName}_data` };
    const dataPassword = randomSecret();
    const adminKey = `bsk_${id}_${randomSecret()}`;
    const authOwner = attach?.authOwner ?? this.#auth.defaultOwner;
    const { projectId: authProjectId, signing } = attach
      ? { projectId: attach.authProjectId, signing: await this.#auth.signing(attach.authProjectId, attach.authOwner) }
      : await this.#auth.createProject(name);
    const jwtSecret = signing.secret;
    try {
      await this.#createDatabase(dbName, { data_pw: dataPassword, jwt_secret: jwtSecret, jwt_issuer: signing.issuer, owner_role: roles.owner, exec_role: roles.exec, data_role: roles.data });
    } catch (err) {
      // Nothing half made is left behind (an attached Auth project belongs to someone else).
      if (!attach) await this.#auth.deleteProject(authProjectId);
      await this.#pool.query(`drop database if exists "${dbName}" with (force)`).catch(() => {});
      throw err;
    }

    {
      await this.#pool.query(
        `insert into cloud.projects (id, name, db_name, owner_role, exec_role, data_role, data_password, jwt_secret, admin_key_hash, auth_project_id, auth_owner, external_id, hosted)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [id, name, dbName, roles.owner, roles.exec, roles.data, encrypt(this.#cfg.masterKey, dataPassword), encrypt(this.#cfg.masterKey, jwtSecret), sha256(adminKey), authProjectId, authOwner, attach?.externalId ?? null, Boolean(attach)],
      );
    }
    return { project: { id, name, dbName, roles, dataPassword, authProjectId, authOwner, approvedContract: null, hosted: Boolean(attach) }, adminKey };
  }

  /**
   * Deletes the project made for a platform environment. Takes the same lock as creating it, so a
   * delete that arrives while a create is still running waits for it instead of missing it.
   */
  async deleteByExternalId(externalId: string, beforeDelete: (p: Project) => Promise<void>): Promise<boolean> {
    const lock = await connect(this.#cfg.adminUrl);
    const tag = `basalt cloud env ${externalId}`;
    try {
      await lock.query('select pg_advisory_lock(hashtext($1))', [tag]);
      const row = (await lock.query('select id from cloud.projects where external_id = $1', [externalId])).rows[0];
      const p = row ? await this.get(row.id) : null;
      if (!p) return false;
      await beforeDelete(p);
      await this.delete(p);
      return true;
    } finally {
      await lock.end().catch(() => {});
    }
  }

  /** Removes an app's database, roles and records. Irreversible. Only for the platform. */
  async delete(p: Project): Promise<void> {
    await this.#pool.query(`drop database if exists "${p.dbName}" with (force)`);
    for (const role of [p.roles.data, p.roles.exec, p.roles.owner]) await this.#pool.query(`drop role if exists "${role}"`);
    await this.#pool.query('delete from cloud.approvals where project_id = $1', [p.id]);
    await this.#pool.query('delete from cloud.checks where project_id = $1', [p.id]);
    await this.#pool.query('delete from cloud.projects where id = $1', [p.id]);
  }

  async get(id: string): Promise<Project | null> {
    if (!/^[a-z0-9]{10}$/.test(id)) return null;
    {
      const r = (await this.#pool.query('select * from cloud.projects where id = $1', [id])).rows[0];
      if (!r) return null;
      return {
        id: r.id,
        name: r.name,
        dbName: r.db_name,
        roles: { owner: r.owner_role, exec: r.exec_role, data: r.data_role },
        dataPassword: decrypt(this.#cfg.masterKey, r.data_password),
        authProjectId: r.auth_project_id ?? null,
        authOwner: r.auth_owner ?? this.#auth.defaultOwner,
        approvedContract: r.approved_contract,
        hosted: r.hosted === true || (r.external_id !== null && r.external_id !== undefined),
      };
    }
  }

  // Checks a bsk_ admin key and returns its project.
  async authorize(adminKey: unknown): Promise<Project | null> {
    if (typeof adminKey !== 'string') return null;
    const m = /^bsk_([a-z0-9]{10})_[A-Za-z0-9_-]{43}$/.exec(adminKey);
    if (!m) return null;
    const hash: string | undefined = (await this.#pool.query('select admin_key_hash from cloud.projects where id = $1', [m[1]])).rows[0]?.admin_key_hash;
    if (!hash || !sameHash(adminKey, hash)) return null;
    return this.get(m[1]);
  }

  // The key in the owner's data map link. Made once, kept encrypted so the
  // same link keeps working.
  async ownerViewKey(p: Project): Promise<string> {
    const row = (await this.#pool.query('select owner_view_key from cloud.projects where id = $1', [p.id])).rows[0];
    if (row?.owner_view_key) return decrypt(this.#cfg.masterKey, row.owner_view_key);
    const key = randomSecret();
    await this.#pool.query('update cloud.projects set owner_view_key = $2 where id = $1 and owner_view_key is null', [p.id, encrypt(this.#cfg.masterKey, key)]);
    const again = (await this.#pool.query('select owner_view_key from cloud.projects where id = $1', [p.id])).rows[0];
    return decrypt(this.#cfg.masterKey, again.owner_view_key);
  }

  async checkOwnerViewKey(id: string, key: unknown): Promise<Project | null> {
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(key)) return null;
    const p = await this.get(id);
    if (!p) return null;
    const row = (await this.#pool.query('select owner_view_key from cloud.projects where id = $1', [id])).rows[0];
    if (!row?.owner_view_key) return null;
    return sameHash(key, sha256(decrypt(this.#cfg.masterKey, row.owner_view_key))) ? p : null;
  }

  // Live numbers for the owner's map. Read with the admin login, never shown
  // to app code, and only counts and column names, never anyone's data.
  async stats(p: Project): Promise<{
    tables: Record<string, { active: number; archived: number }>;
    files: { count: number; bytes: number };
    admins: number;
    recent: { at: string; table: string; op: string; columns: string[] }[];
  }> {
    const c = await connect(withDb(this.#cfg.adminUrl, p.dbName));
    try {
      const tables: Record<string, { active: number; archived: number }> = {};
      const names = (await c.query('select table_name from basalt.registry order by table_name')).rows.map((r) => r.table_name as string);
      for (const t of names) {
        if (!/^[a-z][a-z0-9_]{0,40}$/.test(t)) continue;
        const r = (await c.query(`select count(*) filter (where archived_at is null)::int as active, count(*) filter (where archived_at is not null)::int as archived from app."${t}"`)).rows[0];
        tables[t] = r;
      }
      const files = (await c.query('select count(*)::int as count, coalesce(sum(size), 0)::bigint as bytes from basalt.files')).rows[0];
      const admins = (await c.query('select count(*)::int as n from basalt.admins')).rows[0].n;
      const recent = (await c.query(`select at, table_name as "table", op, coalesce(columns, '{}') as columns from basalt.audit order by at desc limit 8`)).rows;
      return { tables, files: { count: files.count, bytes: Number(files.bytes) }, admins, recent };
    } finally {
      await c.end();
    }
  }

  /**
   * Copies the sessions Basalt Auth ended into the app's database, so their tokens stop working
   * there right away instead of at expiry. Safe to run often and from several Cloud instances.
   */
  async syncRevocations(p: Project): Promise<number> {
    if (!p.authProjectId) return 0;
    const c = await connect(withDb(this.#cfg.adminUrl, p.dbName));
    try {
      const last: Date | null = (await c.query('select basalt.revocations_synced_to() as t')).rows[0]?.t ?? null;
      // Re-read a short overlap so revocations committed slightly out of order are still caught.
      let page = await this.#auth.revocations(p.authProjectId, { since: last ? new Date(last.getTime() - 30_000) : undefined }, p.authOwner);
      let synced = 0;
      for (let i = 0; i < 100; i++) {
        if (page.revocations.length) {
          await c.query('select basalt.record_revocations($1::uuid[], $2::timestamptz[], $3::timestamptz)', [
            page.revocations.map((r) => r.sessionId),
            page.revocations.map((r) => r.revokedAt),
            page.revocations[page.revocations.length - 1]!.revokedAt,
          ]);
          synced += page.revocations.length;
        }
        if (!page.hasMore || !page.nextCursor) break;
        page = await this.#auth.revocations(p.authProjectId, { cursor: page.nextCursor }, p.authOwner);
      }
      return synced;
    } finally {
      await c.end();
    }
  }

  async linkedProjectIds(): Promise<string[]> {
    return (await this.#pool.query('select id from cloud.projects where auth_project_id is not null order by created_at')).rows.map((r) => r.id);
  }

  dataUrl(p: Project): string {
    return `postgres://${p.roles.data}:${encodeURIComponent(p.dataPassword)}@${this.#cfg.dbHost}/${p.dbName}`;
  }

  // Applies a contract to the app's database. Throws a plain message if the
  // change isn't allowed (see data/src/migrate.ts).
  async apply(p: Project, contract: unknown): Promise<Contract> {
    const parsed = parseContract(contract);
    await migrate(withDb(this.#cfg.adminUrl, p.dbName), contract);
    await this.#pool.query('update cloud.projects set approved_contract = $2 where id = $1', [p.id, JSON.stringify(contract)]);
    return parsed;
  }

  // Starts an approval. Any older pending one for the same app is replaced.
  async requestApproval(p: Project, contract: unknown): Promise<{ id: string; token: string }> {
    const id = randomId(16);
    const token = randomSecret();
    const c = await this.#pool.connect();
    try {
      await c.query('begin');
      await c.query(`update cloud.approvals set status = 'replaced', decided_at = now() where project_id = $1 and status = 'pending' and kind = 'rules'`, [p.id]);
      await c.query('insert into cloud.approvals (id, project_id, token_hash, contract) values ($1, $2, $3, $4)', [id, p.id, sha256(token), JSON.stringify(contract)]);
      await c.query('commit');
    } catch (err) {
      await c.query('rollback').catch(() => {});
      throw err;
    } finally {
      c.release();
    }
    return { id, token };
  }

  // Asks the owner to make someone an admin who can see and change every row.
  async requestAdmin(p: Project, uid: string, label: string): Promise<{ id: string; token: string }> {
    const id = randomId(16);
    const token = randomSecret();
    await this.#pool.query(
      `insert into cloud.approvals (id, project_id, token_hash, kind, admin_uid, admin_label) values ($1, $2, $3, 'admin', $4, $5)`,
      [id, p.id, sha256(token), uid, label],
    );
    return { id, token };
  }

  async addAdmin(p: Project, uid: string): Promise<void> {
    const c = await connect(withDb(this.#cfg.adminUrl, p.dbName));
    try {
      await c.query('select basalt.add_admin($1)', [uid]);
    } finally {
      await c.end();
    }
  }

  async getApproval(id: string, token: unknown): Promise<Approval | null> {
    if (!/^[a-z0-9]{16}$/.test(id) || typeof token !== 'string') return null;
    const r = (await this.#pool.query('select * from cloud.approvals where id = $1', [id])).rows[0];
    if (!r || !sameHash(token, r.token_hash)) return null;
    return {
      id: r.id,
      projectId: r.project_id,
      kind: r.kind,
      contract: r.contract,
      admin: r.admin_uid ? { uid: r.admin_uid, label: r.admin_label } : undefined,
      status: r.status,
      expired: r.status === 'pending' && Date.now() - new Date(r.created_at).getTime() > APPROVAL_DAYS * 86_400_000,
    };
  }

  async pendingApproval(projectId: string): Promise<{ id: string } | null> {
    const r = (await this.#pool.query(`select id from cloud.approvals where project_id = $1 and status = 'pending' and kind = 'rules' order by created_at desc limit 1`, [projectId])).rows[0];
    return r ? { id: r.id } : null;
  }

  /**
   * Claims the decision before anything is applied, so two taps at the same moment can't both act.
   * Returns false if it was already decided (or expired).
   */
  async decide(approval: Approval, status: 'approved' | 'rejected'): Promise<boolean> {
    const r = await this.#pool.query(
      `update cloud.approvals set status = $2, decided_at = now() where id = $1 and status = 'pending' and created_at > now() - make_interval(days => $3)`,
      [approval.id, status, APPROVAL_DAYS],
    );
    return r.rowCount === 1;
  }

  /** Puts a claimed approval back when applying it failed, so the owner can try again. */
  async reopen(approval: Approval): Promise<void> {
    await this.#pool.query(`update cloud.approvals set status = 'pending', decided_at = null where id = $1 and status = 'approved'`, [approval.id]);
  }

  // Guard results, shown on the owner's safety receipt.
  // findings is null when no code scan was sent. Only the last 20 checks are kept.
  async saveCheck(projectId: string, contractHash: string, results: unknown, findings: unknown[] | null): Promise<void> {
    await this.#pool.query('insert into cloud.checks (project_id, contract_hash, results, findings) values ($1, $2, $3, $4)', [projectId, contractHash, JSON.stringify(results), findings === null ? null : JSON.stringify(findings)]);
    await this.#pool.query('delete from cloud.checks where project_id = $1 and id not in (select id from cloud.checks where project_id = $1 order by id desc limit 20)', [projectId]);
  }

  async latestCheck(projectId: string): Promise<{ results: any[]; findings: any[] | null; at: string; contractHash: string | null } | null> {
    const r = (await this.#pool.query('select results, findings, created_at, contract_hash from cloud.checks where project_id = $1 order by id desc limit 1', [projectId])).rows[0];
    return r ? { results: r.results, findings: r.findings, at: r.created_at.toISOString(), contractHash: r.contract_hash } : null;
  }
}
