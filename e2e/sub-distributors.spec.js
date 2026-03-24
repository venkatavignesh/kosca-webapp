// @ts-check
const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');

test.describe('Sub Distributors Directory', () => {

  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('sub distributors page loads', async ({ page }) => {
    await page.goto('/ar/sub-distributors');
    // Route redirects to /ar/directory?subOnly=1
    await page.waitForSelector('#table-data', { timeout: 15_000 });
  });

  test('sub distributors table has data', async ({ page }) => {
    await page.goto('/ar/sub-distributors');
    await page.waitForSelector('#table-data table', { timeout: 15_000 });
    const rows = page.locator('#table-data tbody tr').first();
    await expect(rows).toBeVisible();
  });
});
