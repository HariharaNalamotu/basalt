import { test, expect } from '@playwright/test';

test('home page shows the Pulse brand and class types', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/Pulse/);
  await expect(page.getByRole('heading', { name: 'Find your pulse.' })).toBeVisible();
});

test('timetable is visible to signed-out visitors and asks them to sign in', async ({ page }) => {
  await page.goto('/#/classes');
  await expect(page.getByRole('heading', { name: 'Classes' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sign in to book' }).first()).toBeVisible();
});
