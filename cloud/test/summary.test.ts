// The plain-English rules the owner approves. No database needed.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseContract } from '../../data/src/index.ts';
import { tableSummary } from '../src/summary.ts';

test('a uniqueness rule is explained without database words', () => {
  const c = parseContract({ tables: { bookings: { fields: { starts_at: { type: 'timestamp', required: true }, chair: { type: 'integer', required: true } }, unique: [['starts_at', 'chair']] } } });
  const lines = tableSummary(c.tables.get('bookings')!);
  assert.ok(lines.some((l) => l === 'No two bookings can have the same starts at and chair, whoever made them. Archived ones don\'t count.'), lines.join('\n'));
});
