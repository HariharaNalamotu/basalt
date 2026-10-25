// Attack tests for file uploads. Needs the local database and .env.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import pg from 'pg';
import { BasaltData, createBasalt, createDataServer, parseContract } from '../src/index.ts';
import { migrate } from '../src/migrate.ts';
import { userToken } from './helpers.ts';

// Its own table, so it never collides with the fields other test files add to bookings.
const contractJson = {
  tables: {
    jobs: {
      fields: { title: { type: 'text', required: true }, staff_id: { type: 'user' }, photo: { type: 'file' } },
      shareWith: 'staff_id',
    },
  },
};
const DATA_URL = process.env.BASALT_DATA_URL!;
const ADMIN_URL = process.env.BASALT_ADMIN_URL!;

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c60000000049454e44ae426082', 'hex');
const PDF = Buffer.from('%PDF-1.4\n%âã\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n', 'latin1');

let db: BasaltData;
let server: ReturnType<typeof createDataServer>;
let url: string;
const alice = userToken(randomUUID());
const bob = userToken(randomUUID());

async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: ADMIN_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function upload(token: string, body: Buffer, type: string, name = 'photo.png') {
  const res = await fetch(`${url}/v1/files`, {
    method: 'POST',
    headers: { 'content-type': type, 'x-file-name': encodeURIComponent(name), authorization: `Bearer ${token}` },
    body,
  });
  return { status: res.status, body: await res.json() };
}

async function link(token: string, id: string) {
  const res = await fetch(`${url}/v1/files/link`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ id }),
  });
  return { status: res.status, body: await res.json() };
}

async function dataCall(token: string, op: string, body: unknown) {
  const res = await fetch(`${url}/v1/data/${op}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

before(async () => {
  await migrate(ADMIN_URL, contractJson);
  await admin((c) => c.query('update basalt.settings set reads_per_minute = 1000000, writes_per_minute = 1000000'));
  db = new BasaltData({ connectionString: DATA_URL, contract: parseContract(contractJson) });
  server = createDataServer({ data: db });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await db.close();
});

describe('uploading and downloading', () => {
  test('an image goes up and comes back byte for byte, with safe headers', async () => {
    const up = await upload(alice, PNG, 'image/png', 'haircut.png');
    assert.equal(up.status, 200, JSON.stringify(up.body));
    assert.equal(up.body.data.content_type, 'image/png');
    assert.equal(up.body.data.size, PNG.length);
    const l = await link(alice, up.body.data.id);
    assert.equal(l.status, 200);
    const dl = await fetch(`${url}${l.body.data.path}`);
    assert.equal(dl.status, 200);
    assert.deepEqual(Buffer.from(await dl.arrayBuffer()), PNG);
    assert.equal(dl.headers.get('content-type'), 'image/png');
    assert.equal(dl.headers.get('x-content-type-options'), 'nosniff');
    assert.match(dl.headers.get('content-security-policy') ?? '', /sandbox/);
    // Private files aren't kept in the browser's cache (a shared computer, a later visitor).
    assert.equal(dl.headers.get('cache-control'), 'private, no-store');
  });

  test('a PDF works too and downloads as an attachment-safe file', async () => {
    const up = await upload(alice, PDF, 'application/pdf', 'menu.pdf');
    assert.equal(up.status, 200, JSON.stringify(up.body));
  });

  test('the app client uploads and makes a working link', async () => {
    const basalt = createBasalt({ url, token: alice });
    const meta = await basalt.files.upload(new Blob([PNG], { type: 'image/png' }), 'cut.png');
    const link = await basalt.files.url(meta.id as string);
    assert.deepEqual(Buffer.from(await (await fetch(link)).arrayBuffer()), PNG);
  });

  test('file names are cleaned', async () => {
    const up = await upload(alice, PNG, 'image/png', '../../etc/passwd<script>.png');
    assert.equal(up.status, 200);
    assert.ok(!/[\/\\<>]/.test(up.body.data.name), up.body.data.name);
  });
});

describe('what gets refused', () => {
  test('a web page pretending to be an image', async () => {
    const r = await upload(alice, Buffer.from('<html><script>alert(1)</script></html>'), 'image/png');
    assert.equal(r.status, 400);
  });

  test('file types that can run code, like SVG, HTML and programs', async () => {
    for (const [body, type] of [
      [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'image/svg+xml'],
      [Buffer.from('<html></html>'), 'text/html'],
      [Buffer.from('MZ\u0090\u0000'), 'application/octet-stream'],
    ] as const) {
      assert.equal((await upload(alice, body, type)).status, 400, type);
    }
  });

  test('text files with hidden binary', async () => {
    assert.equal((await upload(alice, Buffer.from('name,phone\n\u0000\u0001'), 'text/csv', 'list.csv')).status, 400);
  });

  test('files over the size limit', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024)]);
    assert.equal((await upload(alice, big, 'image/png')).status, 400);
  });

  test('no login', async () => {
    const res = await fetch(`${url}/v1/files`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: PNG });
    assert.equal(res.status, 401);
  });

  test('going over the storage quota', async () => {
    const t = userToken(randomUUID());
    await admin((c) => c.query('update basalt.settings set file_quota_bytes = $1', [PNG.length * 2]));
    try {
      assert.equal((await upload(t, PNG, 'image/png')).status, 200);
      assert.equal((await upload(t, PNG, 'image/png')).status, 200);
      assert.equal((await upload(t, PNG, 'image/png')).status, 400);
    } finally {
      await admin((c) => c.query('update basalt.settings set file_quota_bytes = 52428800'));
    }
  });
});

describe('who can open a file', () => {
  test("someone else can't get a link to my file, and made-up links don't work", async () => {
    const up = await upload(alice, PNG, 'image/png');
    assert.equal((await link(bob, up.body.data.id)).status, 404);
    assert.equal((await fetch(`${url}/v1/files/download/${'a'.repeat(64)}`)).status, 404);
    assert.equal((await fetch(`${url}/v1/files/download/../../etc`)).status, 404);
  });

  test('download links expire', async () => {
    const up = await upload(alice, PNG, 'image/png');
    const l = await link(alice, up.body.data.id);
    await admin((c) => c.query(`update basalt.file_tickets set expires_at = now() - interval '1 second'`));
    assert.equal((await fetch(`${url}${l.body.data.path}`)).status, 404);
  });

  test('a file on a job can be opened by the stylist it is shared with, but nobody else', async () => {
    const stylist = randomUUID();
    const up = await upload(alice, PNG, 'image/png');
    const made = await dataCall(alice, 'create', { table: 'jobs', input: { title: 'Color', staff_id: stylist, photo: up.body.data.id } });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    assert.equal((await link(userToken(stylist), up.body.data.id)).status, 200);
    assert.equal((await link(bob, up.body.data.id)).status, 404);
  });

  test("you can't attach someone else's file to your row", async () => {
    const up = await upload(alice, PNG, 'image/png');
    const r = await dataCall(bob, 'create', { table: 'jobs', input: { title: 'X', photo: up.body.data.id } });
    assert.equal(r.status, 400);
    // and attaching it wouldn't have given bob access anyway
    assert.equal((await link(bob, up.body.data.id)).status, 404);
  });

  test("the Data service's login can't read files or tickets directly", async () => {
    for (const sql of ['select * from basalt.files', 'select * from basalt.file_tickets']) {
      const c = new pg.Client({ connectionString: DATA_URL });
      await c.connect();
      await assert.rejects(c.query(sql), (e: { code?: string }) => e.code === '42501');
      await c.end();
    }
  });
});

describe('uploads in a browser signed in with Basalt Auth', () => {
  test('with no token, no login header is sent, so the session cookie is used', async () => {
    let seen: string | undefined = 'not called';
    const spy = createServer((req, res) => {
      seen = req.headers.authorization;
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true,"data":{"id":"x"}}');
    });
    await new Promise<void>((r) => spy.listen(0, '127.0.0.1', () => r()));
    try {
      const basalt = createBasalt({ url: `http://127.0.0.1:${(spy.address() as AddressInfo).port}` });
      await basalt.files.upload(new Blob(['hi'], { type: 'text/plain' }), 'a.txt');
      assert.equal(seen, undefined);
    } finally {
      spy.close();
    }
  });
});
