// The Guard code scan: finds app data kept somewhere other than Basalt.
// Plain unit tests on throwaway folders, no database needed.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { scanFolder } from '../src/scan.ts';

function folder(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'basalt-scan-'));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  return dir;
}

const rules = (dir: string) => scanFolder(dir).map((f) => f.rule);

describe('the code scan', () => {
  test('a clean app that keeps everything in Basalt has no findings', () => {
    const dir = folder({
      'index.html': '<script type="module" src="app.js"></script>',
      'app.js': "import { basalt } from './basalt.js';\nconst db = basalt(getToken);\nawait db.create('bookings', { service: 'Cut' });\nlocalStorage.setItem('theme', 'dark');",
      'basalt.js': "const BASALT_URL = 'https://basalt.example/p/abc';",
      '.gitignore': 'node_modules\n.basalt/\n',
      '.basalt/project.json': '{"adminKey":"bsk_abcdefghij_xxxxxxxxxxxxxxxxxxxx"}',
    });
    assert.deepEqual(scanFolder(dir), []);
  });

  test('app data kept in the browser is flagged with the file and line', () => {
    const dir = folder({
      'src/app.js': "const a = 1;\nlocalStorage.setItem('bookings', JSON.stringify(bookings));",
      'src/cart.tsx': 'sessionStorage.setItem(`cart`, JSON.stringify(items));',
      'src/offline.js': "const req = indexedDB.open('orders');",
    });
    const found = scanFolder(dir);
    assert.deepEqual(found.map((f) => f.rule).sort(), ['browser_storage', 'browser_storage', 'browser_storage']);
    const app = found.find((f) => f.file === 'src/app.js')!;
    assert.equal(app.line, 2);
    assert.match(app.problem, /browser/);
    assert.match(app.fix, /Basalt/);
  });

  test('other data services and local database libraries are flagged', () => {
    const dir = folder({
      'a.js': "import { getFirestore } from 'firebase/firestore';",
      'b.ts': "import { createClient } from '@supabase/supabase-js';",
      'c.js': "const mongoose = require('mongoose');",
      'd.ts': "import Database from 'better-sqlite3';",
      'e.ts': "import { PrismaClient } from '@prisma/client';",
      'f.js': "import { kv } from '@vercel/kv';",
    });
    assert.deepEqual(rules(dir), Array(6).fill('other_database'));
  });

  test('saving data to files on the server is flagged, and so are database files', () => {
    const dir = folder({
      'server.js': "fs.writeFileSync('data/bookings.json', JSON.stringify(all));",
      'save.ts': "await writeFile(path.join(dir, 'customers.csv'), rows);",
      'app.db': 'SQLite format 3',
      'data/store.sqlite': 'SQLite format 3',
    });
    assert.deepEqual(rules(dir).sort(), ['data_file', 'data_file', 'local_file_storage', 'local_file_storage']);
  });

  test('a Basalt key pasted into code, or a .basalt folder git would pick up, is flagged', () => {
    const leaky = folder({
      'config.js': "export const KEY = 'bsk_abcdefghij_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';",
      '.basalt/project.json': '{}',
    });
    assert.deepEqual(rules(leaky).sort(), ['basalt_folder_not_ignored', 'basalt_key_in_code']);
    // The finding never repeats the key itself.
    assert.doesNotMatch(JSON.stringify(scanFolder(leaky)), /aaaaaaaa/);
  });

  test('dependencies, build output and git internals are skipped', () => {
    const dir = folder({
      'node_modules/lib/index.js': "localStorage.setItem('x', y);",
      'dist/app.js': "localStorage.setItem('x', y);",
      '.git/hooks/x.js': "localStorage.setItem('x', y);",
      'app.min.js': "localStorage.setItem('x', y);",
    });
    assert.deepEqual(scanFolder(dir), []);
  });

  test('a harmless setting on a line never hides a real save on the same line', () => {
    const dir = folder({ 'app.js': "localStorage.setItem('theme', 'dark'); localStorage.setItem('customers', JSON.stringify(all));" });
    assert.deepEqual(rules(dir), ['browser_storage']);
  });

  test('a code file too big to read is reported, not treated as clean', () => {
    const dir = folder({ 'bundle.js': `${'// filler\n'.repeat(60000)}localStorage.setItem('orders', x);` });
    assert.deepEqual(rules(dir), ['scan_incomplete']);
    assert.equal(scanFolder(dir)[0].file, 'bundle.js');
  });

  test('a folder with too many files is cut off instead of hanging', () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 2100; i++) files[`f${i}.js`] = i === 2099 ? "localStorage.setItem('orders', x);" : '';
    const found = scanFolder(folder(files));
    assert.ok(found.some((f) => f.rule === 'scan_incomplete'));
  });
});
