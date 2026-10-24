#!/usr/bin/env node
import { createPgDb } from './db/db.js';
import { migrate } from './db/migrate.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}
const db = createPgDb({ connectionString: url, maxConnections: 1 });
try {
  const applied = await migrate(db);
  console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Up to date');
} finally {
  await db.close();
}
