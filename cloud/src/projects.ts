import { readdirSync, readFileSync } from 'node:fs';
import { migrate, parseContract, pg, runSql, type Contract } from '../../data/src/index.ts';
import { decrypt, encrypt, randomId, randomSecret, sameHash, sha256 } from './secrets.ts';

// Basalt Cloud's own records live in the cluster's postgres database, in a
// schema only the superuser can reach. Each app gets its own database and its
// own three roles, so no key for one app opens another.

const SQL_DIR = new URL('../../data/sql/', import.meta.url);

export interface CloudConfig {
  // Superuser connection to the postgres database.
  adminUrl: string;
  // Host and port apps' data logins connect to (usually the same server).
  dbHost: string;
  masterKey: string;
}

export interface Project {
  id: string;
  name: string;
  dbName: string;
  roles: { owner: string; exec: string; data: string };
  dataPassword: string;
  jwtSecret: string;
  approvedContract: unknown | null;
}

export interface Approval {
  id: string;
  projectId: string;
  kind: 'rules' | 'admin';
  contract: unknown;
  admin?: { uid: string; label: string };
  status: 'pending' | 'approved' | 'rejected' | 'replaced';
}

function withDb(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

async function connect(url: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return client;
}

export class Projects {
  #cfg: CloudConfig;
  #pool: pg.Pool;

  constructor(cfg: CloudConfig) {
    this.#cfg = cfg;
    this.#pool = new pg.Pool({ connectionString: cfg.adminUrl, max: 5, application_name: 'basalt-cloud' });
    this.#pool.on('error', () => {});
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }

  async init(): Promise<void> {
    const c = await this.#pool.connect();
    try {
      await c.query(`
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
        alter table cloud.approvals alter column contract drop not null;`);
    } finally {
      c.release();
    }
  }

  // Makes a brand new database for one app and locks it down.
  async create(name: string): Promise<{ project: Project; adminKey: string }> {
    const id = randomId();
    const dbName = `app_${id}`;
    const roles = { owner: `${dbName}_owner`, exec: `${dbName}_exec`, data: `${dbName}_data` };
    const dataPassword = randomSecret();
    const jwtSecret = randomSecret(48);
    const adminKey = `bsk_${id}_${randomSecret()}`;

    await this.#pool.query(`create database "${dbName}"`);

    const appDb = await connect(withDb(this.#cfg.adminUrl, dbName));
    try {
      const vars = {
        data_pw: dataPassword,
        jwt_secret: jwtSecret,
        jwt_issuer: '',
        owner_role: roles.owner,
        exec_role: roles.exec,
        data_role: roles.data,
      };
      for (const file of readdirSync(SQL_DIR).filter((f) => f.endsWith('.sql')).sort()) {
        await runSql(appDb, readFileSync(new URL(file, SQL_DIR), 'utf8'), vars);
      }
    } finally {
      await appDb.end();
    }

    {
      await this.#pool.query(
        `insert into cloud.projects (id, name, db_name, owner_role, exec_role, data_role, data_password, jwt_secret, admin_key_hash)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, name, dbName, roles.owner, roles.exec, roles.data, encrypt(this.#cfg.masterKey, dataPassword), encrypt(this.#cfg.masterKey, jwtSecret), sha256(adminKey)],
      );
    }
    return { project: { id, name, dbName, roles, dataPassword, jwtSecret, approvedContract: null }, adminKey };
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
        jwtSecret: decrypt(this.#cfg.masterKey, r.jwt_secret),
        approvedContract: r.approved_contract,
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
    };
  }

  async pendingApproval(projectId: string): Promise<{ id: string } | null> {
    const r = (await this.#pool.query(`select id from cloud.approvals where project_id = $1 and status = 'pending' and kind = 'rules' order by created_at desc limit 1`, [projectId])).rows[0];
    return r ? { id: r.id } : null;
  }

  async decide(approval: Approval, status: 'approved' | 'rejected'): Promise<void> {
    await this.#pool.query(`update cloud.approvals set status = $2, decided_at = now() where id = $1 and status = 'pending'`, [approval.id, status]);
  }
}
