import type { Contract, FieldSpec, TableSpec } from '../../data/src/index.ts';

// Guard: before an app goes live, act like two different people (and a
// stranger with no login) against the app's own data API and check that
// nobody can reach anyone else's data. Runs only against the app it was
// started for, with that app's test logins. Each check says in plain words
// what it tried.

export interface CheckResult {
  id: string;
  title: string;
  passed: boolean;
  detail: string;
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
  data: any;
}

async function post(url: string, path: string, body: unknown, token?: string): Promise<Reply> {
  try {
    const res = await fetch(`${url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const json: any = await res.json().catch(() => null);
    return { status: res.status, ok: res.ok && json?.ok === true, data: json?.data };
  } catch {
    return { status: 0, ok: false, data: null };
  }
}

const op = (name: string) => `/v1/data/${name}`;

async function upload(url: string, token: string): Promise<string | null> {
  try {
    const res = await fetch(`${url}/v1/files`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'x-file-name': 'basalt-check.txt', authorization: `Bearer ${token}` },
      body: 'Basalt safety check',
      signal: AbortSignal.timeout(10_000),
    });
    const json: any = await res.json().catch(() => null);
    return json?.ok ? (json.data?.id ?? null) : null;
  } catch {
    return null;
  }
}

function sample(spec: FieldSpec, userA: string, fileId: string | null): unknown {
  switch (spec.type) {
    case 'text': {
      const byFormat = { email: 'check@example.com', phone: '+1 555 0100', url: 'https://example.com', postal_code: '94103', slug: 'basalt-check' };
      return spec.format ? byFormat[spec.format] : 'Basalt check'.slice(0, spec.maxLength);
    }
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

function sampleInput(table: TableSpec, userA: string, fileId: string | null): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const [name, spec] of table.fields) {
    // Leave sharing fields empty so the test row is A's alone.
    if (spec.type === 'user' && name === table.shareWith) continue;
    if (spec.required || spec.type !== 'user') input[name] = sample(spec, userA, fileId);
  }
  return input;
}

function hasRow(list: Reply, id: string): boolean {
  return Array.isArray(list.data?.rows) && list.data.rows.some((r: any) => r?.id === id);
}

export async function runChecks(contract: Contract, t: GuardTarget): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const check = (id: string, title: string, passed: boolean, detail: string) => results.push({ id, title, passed, detail });
  const tables = [...contract.tables.values()];
  // Prefer a table that needs no upload, so most apps never store a check file.
  const table = tables.find((x) => ![...x.fields.values()].some((f) => f.type === 'file' && f.required)) ?? tables[0];
  const needsFile = tables.some((x) => [...x.fields.values()].some((f) => f.type === 'file'));

  const anon = await post(t.url, op('list'), { table: table.name });
  check('no_login', 'Someone with no login', !anon.ok, anon.ok ? 'Got data back without signing in.' : 'Was turned away.');
  const junk = await post(t.url, op('list'), { table: table.name }, 'not-a-real-token');
  check('bad_token', 'A made up login', !junk.ok, junk.ok ? 'A made up login was accepted.' : 'Was turned away.');
  const forged = await post(t.url, op('list'), { table: table.name }, t.forged);
  check('forged_token', 'A forged login for a real person', !forged.ok, forged.ok ? 'A login signed with the wrong key was accepted.' : 'Was turned away.');
  const expired = await post(t.url, op('list'), { table: table.name }, t.expired);
  check('expired_token', 'An expired login', !expired.ok, expired.ok ? 'An expired login still worked.' : 'Was turned away.');

  const fileId = needsFile ? await upload(t.url, t.tokenA) : null;
  const made = await post(t.url, op('create'), { table: table.name, input: sampleInput(table, t.userA, fileId) }, t.tokenA);
  const id: string | undefined = made.ok ? made.data?.id : undefined;
  if (!id) {
    check('setup', 'Saving a test entry', false, "Couldn't save a test entry as a test person, so the checks below couldn't run.");
    return results;
  }

  const get = await post(t.url, op('get'), { table: table.name, id }, t.tokenB);
  check('other_person_get', "Opening someone else's entry", !get.ok || get.data?.id !== id, get.ok && get.data?.id === id ? "Person B opened person A's entry." : 'Person B got "not found".');

  const list = await post(t.url, op('list'), { table: table.name }, t.tokenB);
  check('other_person_list', "Listing everyone's entries", !hasRow(list, id), hasRow(list, id) ? "Person A's entry showed up in person B's list." : "Person B's list only had their own entries.");

  const field = [...table.fields].find(([n, s]) => s.type === 'text' && !s.format && n !== table.shareWith)?.[0];
  const change = field ? { [field]: 'changed by someone else' } : {};
  const upd = await post(t.url, op('update'), { table: table.name, id, input: change }, t.tokenB);
  const after = await post(t.url, op('get'), { table: table.name, id }, t.tokenA);
  const changed = upd.ok || (field !== undefined && after.data?.[field] === 'changed by someone else');
  check('other_person_update', "Changing someone else's entry", !changed, changed ? "Person B changed person A's entry." : 'Refused, and the entry was untouched.');

  const arc = await post(t.url, op('archive'), { table: table.name, id }, t.tokenB);
  check('other_person_archive', "Removing someone else's entry", !arc.ok, arc.ok ? "Person B removed person A's entry." : 'Refused.');

  const fake = await post(t.url, op('create'), { table: table.name, input: { ...sampleInput(table, t.userA, fileId), owner_id: t.userA } }, t.tokenB);
  const faked = fake.ok && fake.data?.owner_id === t.userA;
  check('fake_owner', 'Saving an entry in someone else\'s name', !faked, faked ? 'Person B saved an entry that says person A made it.' : 'Refused.');
  if (fake.ok && fake.data?.id) await post(t.url, op('archive'), { table: table.name, id: fake.data.id }, t.tokenB);

  const sys = await post(t.url, op('list'), { table: 'pg_authid' }, t.tokenB);
  check('unknown_table', "Reading the database's own tables", !sys.ok, sys.ok ? 'The database\'s internal tables answered.' : 'Refused.');

  const textField = [...table.fields].find(([, s]) => s.type === 'text')?.[0];
  const inj = textField ? await post(t.url, op('list'), { table: table.name, where: { [textField]: "x' or '1'='1" } }, t.tokenB) : { ok: false, status: 0, data: null };
  check('filter_injection', 'A search that tries to sneak in database code', !hasRow(inj, id), hasRow(inj, id) ? "The search returned person A's entry." : 'Treated as plain text, nothing leaked.');

  if (needsFile && fileId) {
    const link = await post(t.url, '/v1/files/link', { id: fileId }, t.tokenB);
    check('other_person_file', "Downloading someone else's file", !link.ok, link.ok ? "Person B got a download link for person A's file." : 'Refused.');
  }

  // Clean up: the test entry is archived, so the owner's counts don't change.
  await post(t.url, op('archive'), { table: table.name, id }, t.tokenA);
  return results;
}
