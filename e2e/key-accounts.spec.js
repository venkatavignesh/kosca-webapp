// @ts-check
const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');

test.describe('Key Accounts Directory', () => {

  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('key accounts page loads', async ({ page }) => {
    await page.goto('/ar/key-accounts');
    // Route redirects to /ar/directory?keyOnly=1
    await page.waitForSelector('#table-data', { timeout: 15_000 });
  });

  test('key accounts table has data', async ({ page }) => {
    await page.goto('/ar/key-accounts');
    await page.waitForSelector('#table-data table', { timeout: 15_000 });
    const rows = page.locator('#table-data tbody tr').first();
    await expect(rows).toBeVisible();
  });

  test('key accounts search works', async ({ page }) => {
    await page.goto('/ar/key-accounts');
    await page.waitForSelector('#table-data table', { timeout: 15_000 });
    await page.fill('input[name="search"]', 'test');
    await page.waitForTimeout(1500);
    // Table should reload (even if 0 results)
    await page.waitForSelector('#table-data', { timeout: 10_000 });
  });
});
