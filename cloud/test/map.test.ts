// The owner's data map. No database needed.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseContract } from '../../data/src/index.ts';
import { renderMap } from '../src/map.ts';

const contract = parseContract({ tables: { bookings: { fields: { service: { type: 'text' } } } } });
const stats = (admins: { label: string }[]) => ({ tables: { bookings: { active: 1, archived: 0 } }, files: { count: 0, bytes: 0 }, admins, recent: [] });

test('names each admin, not just how many there are, and says how to remove one', () => {
  const html = renderMap('Salon', contract, stats([{ label: 'owner@salon.example' }, { label: '<b>maria</b>' }]));
  assert.match(html, /Admins \(2\)/);
  assert.match(html, /owner@salon\.example/);
  assert.match(html, /&lt;b&gt;maria&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<b>maria<\/b>/);
  assert.match(html, /ask Claude to add or remove them/);
});

test('says plainly when nobody is an admin', () => {
  const html = renderMap('Salon', contract, stats([]));
  assert.match(html, /Admins \(0\)/);
  assert.match(html, /Nobody is an admin/);
});

test('the legend only lists kinds of access the map shows', () => {
  const html = renderMap('Salon', contract, stats([]));
  assert.doesNotMatch(html, /read only, when assigned/);
  const shared = parseContract({ tables: { jobs: { fields: { note: { type: 'text' }, stylist: { type: 'user' } }, shareWith: 'stylist' } } });
  assert.match(renderMap('Salon', shared, { ...stats([]), tables: { jobs: { active: 1, archived: 0 } } }), /read only, when assigned/);
});

test('"Cannot access" labels leave room before the data boxes', () => {
  const html = renderMap('Salon', contract, stats([]));
  const label = Number(/<text x="(\d+)"[^>]*>Cannot access</.exec(html)![1]);
  const box = Number(/<rect x="(\d+)" y="[^"]*" width="168" height="52"/.exec(html)![1]);
  // "Cannot access" at 15px is about 105px wide; keep at least 24px clear of the box.
  assert.ok(box - (label + 105) >= 24, `label ends at ${label + 105}, box starts at ${box}`);
});
