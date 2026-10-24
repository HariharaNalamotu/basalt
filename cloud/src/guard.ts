import { createHmac } from 'node:crypto';
import type { Contract, FieldSpec, TableSpec } from '../../data/src/index.ts';

// Guard: before an app goes live, act like two different people (and a
// stranger with no login) against the app's own data API and check that
// nobody can reach anyone else's data. Runs only against the app it was
// started for, with that app's test logins. Each check says in plain words
// what it tried.
//
// A check only passes on a clear refusal (a 4xx answer that says no). Errors,
// timeouts and odd answers are "couldn't tell", never safe.

export interface CheckResult {
  id: string;
  title: string;
  passed: boolean;
  detail: string;
  table?: string;
}

export interface GuardTarget {
  url: string; // the app's data API, like https://basalt.example/p/<id>
  tokenA: string; // test person A
  tokenB: string; // test person B
  userA: string; // A's user id
  forged: string; // a token for A signed with the wrong key
  expired: string; // A's token, already expired
}

interface Reply {
  status: number;
  ok: boolean;
  answered: boolean; // a JSON reply in Basalt's shape came back
  data: any;
}

const MAX_TABLES = 20;

// Re-signs an HS256 token with another key, optionally changing claims. Used to
// make the forged and expired logins from a real one.
export function resign(token: string, secret: string, claims: Record<string, unknown> = {}): string {
  const [h, p] = token.split('.');
  const payload = { ...JSON.parse(Buffer.from(p ?? '', 'base64url').toString('utf8')), ...claims };
  const unsigned = `${h}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  return `${unsigned}.${createHmac('sha256', secret).update(unsigned).digest('base64url')}`;
}

async function send(url: string, path: string, init: RequestInit): Promise<Reply> {
  try {
    const res = await fetch(`${url}${path}`, { ...init, method: 'POST', signal: AbortSignal.timeout(10_000) });
    const json: any = await res.json().catch(() => null);
    const answered = typeof json?.ok === 'boolean';
    return { status: res.status, ok: res.ok && json?.ok === true, answered, data: json?.data };
  } catch {
    return { status: 0, ok: false, answered: false, data: null };
  }
}

function post(url: string, path: string, body: unknown, token?: string): Promise<Reply> {
  return send(url, path, {
    headers: { 'content-type': 'application/json', ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
    body: JSON.stringify(body),
  });
}

const op = (name: string) => `/v1/data/${name}`;

// A clear "no": the app understood the request and refused it.
function refused(r: Reply): boolean {
  return r.answered && !r.ok && r.status >= 400 && r.status < 500 && r.status !== 429;
}

function unsure(r: Reply): string {
  if (r.status === 0) return "Couldn't tell: the app didn't answer.";
  if (r.status === 429) return "Couldn't tell: the app said it was too busy.";
  return `Couldn't tell: the app answered with an error (${r.status}).`;
}

const SAMPLE_TEXT = { email: 'a@b.co', phone: '5550100', url: 'http://a.co', postal_code: '94103', slug: 'a' };
const OTHER_TEXT = { email: 'b@b.co', phone: '5550199', url: 'http://b.co', postal_code: '10001', slug: 'b' };

function sample(spec: FieldSpec, userA: string, fileId: string | null): unknown {
  switch (spec.type) {
    case 'text':
      return spec.format ? SAMPLE_TEXT[spec.format] : 'Basalt check'.slice(0, spec.maxLength);
    case 'integer':
    case 'number':
      return Math.min(Math.max(1, spec.min ?? 1), spec.max ?? Number.MAX_SAFE_INTEGER);
    case 'boolean':
      return true;
    case 'timestamp':
      return new Date().toISOString();
    case 'user':
      return userA;
    case 'file':
      return fileId;
  }
}

// A value unlikely to be taken already, for fields the table keeps unique across everyone.
function freshSample(spec: FieldSpec, userA: string, fileId: string | null): unknown {
  const tag = Math.random().toString(36).slice(2, 8);
  switch (spec.type) {
    case 'text': {
      const byFormat = { email: `c${tag}@b.co`, phone: `555${Math.floor(1e6 + Math.random() * 8e6)}`, url: `http://${tag}.co`, postal_code: tag.slice(0, 5), slug: `c${tag}` };
      return spec.format ? byFormat[spec.format] : `Basalt check ${tag}`.slice(0, spec.maxLength);
    }
    case 'timestamp':
      // Far from any real booking: a random minute in 2099.
      return new Date(Date.UTC(2099, 0, 1) + Math.floor(Math.random() * 5e5) * 60_000).toISOString();
    case 'integer':
    case 'number': {
      const lo = spec.min ?? 1;
      const hi = spec.max ?? lo + 1e6;
      return lo + Math.floor(Math.random() * (hi - lo + 1));
    }
    default:
      return sample(spec, userA, fileId);
  }
}

function sampleInput(table: TableSpec, userA: string, fileId: string | null): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  const unique = new Set((table.unique ?? []).flat());
  for (const [name, spec] of table.fields) {
    // Optional people and files stay empty, so the test row is A's alone.
    if ((spec.type === 'user' || spec.type === 'file') && !spec.required) continue;
    input[name] = unique.has(name) ? freshSample(spec, userA, fileId) : sample(spec, userA, fileId);
  }
  return input;
}

// A different valid value for one field, for the "change someone else's entry" check.
function change(table: TableSpec): { field: string; value: unknown } | null {
  for (const [field, spec] of table.fields) {
    const was = sample(spec, '', null);
    switch (spec.type) {
      case 'text':
        return { field, value: spec.format ? OTHER_TEXT[spec.format] : 'Changed'.slice(0, spec.maxLength) };
      case 'boolean':
        return { field, value: false };
      case 'timestamp':
        return { field, value: '2001-01-01T00:00:00.000Z' };
      case 'integer':
      case 'number': {
        const n = was as number;
        if (spec.max === undefined || n + 1 <= spec.max) return { field, value: n + 1 };
        if (spec.min === undefined || n - 1 >= spec.min) return { field, value: n - 1 };
      }
    }
  }
  return null;
}

function same(a: unknown, b: unknown): boolean {
  if (typeof b === 'string' && /^\d{4}-\d\d-\d\dT/.test(b) && typeof a === 'string') return Date.parse(a) === Date.parse(b);
  return a === b;
}

function rowsOf(r: Reply): any[] | null {
  return r.ok && Array.isArray(r.data?.rows) ? r.data.rows : null;
}

export async function runChecks(contract: Contract, t: GuardTarget): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const add = (id: string, title: string, passed: boolean, detail: string, table?: string) => results.push({ id, title, passed, detail, ...(table ? { table } : {}) });
  const tables = [...contract.tables.values()].slice(0, MAX_TABLES);
  const first = tables[0].name;

  // Logins that should never work.
  const stranger: [string, string, string | undefined][] = [
    ['no_login', 'Someone with no login', undefined],
    ['bad_token', 'A made up login', 'not-a-real-token'],
    ['forged_token', 'A forged login for a real person', t.forged],
    ['expired_token', 'An expired login', t.expired],
  ];
  for (const [id, title, token] of stranger) {
    const r = await post(t.url, op('list'), { table: first }, token);
    add(id, title, refused(r), r.ok ? 'Got data back without a valid login.' : refused(r) ? 'Was turned away.' : unsure(r));
  }

  const sys = await post(t.url, op('list'), { table: 'pg_authid' }, t.tokenB);
  add('unknown_table', "Reading the database's own tables", refused(sys), sys.ok ? "The database's internal tables answered." : refused(sys) ? 'Refused.' : unsure(sys));

  // A test file, only when the app takes uploads.
  const usesFiles = tables.some((x) => [...x.fields.values()].some((f) => f.type === 'file'));
  let fileId: string | null = null;
  if (usesFiles) {
    const up = await send(t.url, '/v1/files', {
      headers: { 'content-type': 'text/plain', 'x-file-name': 'basalt-check.txt', authorization: `Bearer ${t.tokenA}` },
      body: 'Basalt safety check',
    });
    fileId = up.ok && typeof up.data?.id === 'string' ? up.data.id : null;
    if (!fileId) {
      add('other_person_file', "Downloading someone else's file", false, "Couldn't upload a test file, so this wasn't checked.");
    } else {
      const link = await post(t.url, '/v1/files/link', { id: fileId }, t.tokenB);
      add('other_person_file', "Downloading someone else's file", refused(link), link.ok ? "Person B got a download link for person A's file." : refused(link) ? 'Refused.' : unsure(link));
    }
  }

  for (const table of tables) {
    const name = table.name;
    const made = await post(t.url, op('create'), { table: name, input: sampleInput(table, t.userA, fileId) }, t.tokenA);
    const id: string | undefined = made.ok && typeof made.data?.id === 'string' ? made.data.id : undefined;
    // Positive control: the owner can read their own entry, so a refusal below means something.
    const mine = id ? await post(t.url, op('get'), { table: name, id }, t.tokenA) : null;
    if (!id || !mine?.ok || mine.data?.id !== id) {
      add('setup', 'Saving a test entry', false, "Couldn't save and read back a test entry as its owner, so this part wasn't checked.", name);
      continue;
    }

    const get = await post(t.url, op('get'), { table: name, id }, t.tokenB);
    const gotIt = get.ok && get.data?.id === id;
    add('other_person_get', "Opening someone else's entry", !gotIt && (refused(get) || get.ok), gotIt ? "Person B opened person A's entry." : refused(get) || get.ok ? 'Person B got "not found".' : unsure(get), name);

    const list = await post(t.url, op('list'), { table: name }, t.tokenB);
    const rows = rowsOf(list);
    const listed = rows?.some((r) => r?.id === id) ?? false;
    add('other_person_list', "Listing everyone's entries", rows !== null && !listed, listed ? "Person A's entry showed up in person B's list." : rows ? "Person B's list only had their own entries." : unsure(list), name);

    const c = change(table);
    if (!c) {
      add('other_person_update', "Changing someone else's entry", false, "Couldn't tell: this kind of entry has no field the check knows how to change.", name);
    } else {
      const upd = await post(t.url, op('update'), { table: name, id, input: { [c.field]: c.value } }, t.tokenB);
      const after = await post(t.url, op('get'), { table: name, id }, t.tokenA);
      const changed = upd.ok || (after.ok && same(after.data?.[c.field], c.value));
      if (changed) add('other_person_update', "Changing someone else's entry", false, "Person B changed person A's entry.", name);
      else if (!refused(upd)) add('other_person_update', "Changing someone else's entry", false, unsure(upd), name);
      else {
        // The same change must work for the owner, or the refusal proves nothing.
        const own = await post(t.url, op('update'), { table: name, id, input: { [c.field]: c.value } }, t.tokenA);
        add('other_person_update', "Changing someone else's entry", own.ok, own.ok ? 'Refused, and the entry was untouched.' : "Couldn't tell: the owner couldn't make the same change either.", name);
      }
    }

    const arc = await post(t.url, op('archive'), { table: name, id }, t.tokenB);
    add('other_person_archive', "Removing someone else's entry", refused(arc), arc.ok ? "Person B removed person A's entry." : refused(arc) ? 'Refused.' : unsure(arc), name);

    const fake = await post(t.url, op('create'), { table: name, input: { ...sampleInput(table, t.userA, fileId), owner_id: t.userA } }, t.tokenB);
    const faked = fake.ok && fake.data?.owner_id === t.userA;
    add('fake_owner', "Saving an entry in someone else's name", !faked && (refused(fake) || fake.ok), faked ? 'Person B saved an entry that says person A made it.' : refused(fake) || fake.ok ? 'Refused.' : unsure(fake), name);
    if (fake.ok && typeof fake.data?.id === 'string') await post(t.url, op('archive'), { table: name, id: fake.data.id }, t.tokenB);

    const textField = [...table.fields].find(([, s]) => s.type === 'text')?.[0];
    if (textField) {
      const inj = await post(t.url, op('list'), { table: name, where: { [textField]: "x' or '1'='1" } }, t.tokenB);
      const injRows = rowsOf(inj);
      const leaked = injRows?.some((r) => r?.id === id) ?? false;
      const ok = !leaked && (injRows !== null || refused(inj));
      add('filter_injection', 'A search that tries to sneak in database code', ok, leaked ? "The search returned person A's entry." : ok ? 'Treated as plain text, nothing leaked.' : unsure(inj), name);
    }

    // Clean up, so the owner's counts don't change.
    const done = await post(t.url, op('archive'), { table: name, id }, t.tokenA);
    if (!done.ok) add('cleanup', 'Tidying up the test entry', false, "The test entry couldn't be archived. It's marked Basalt check.", name);
  }
  return results;
}
