import { defineConfig } from '@playwright/test';

// On Basalt Host the platform sets baseURL, https and access headers for each test environment.
export default defineConfig({
  testDir: './e2e',
  use: { baseURL: process.env.BASE_URL ?? 'http://localhost:5173' },
});
