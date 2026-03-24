// @ts-check
const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');

test.describe('Upload Page', () => {

  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('upload page loads with form', async ({ page }) => {
    await page.goto('/ar/upload');
    await page.waitForTimeout(2000);
    await expect(page.locator('h1')).toBeVisible({ timeout: 10_000 });
    // Two upload sections: AR Report and Customer Master
    await expect(page.locator('text=AR Report').first()).toBeVisible();
    await expect(page.locator('text=Customer Master').first()).toBeVisible();
  });

  test('upload page shows auto-sync status', async ({ page }) => {
    await page.goto('/ar/upload');
    await page.waitForTimeout(2000);
    await expect(page.locator('text=Auto-Sync').first()).toBeVisible();
    await expect(page.locator('text=Sync Now').first()).toBeVisible();
  });

  test('upload page shows expected column headers', async ({ page }) => {
    await page.goto('/ar/upload');
    await page.waitForTimeout(2000);
    await expect(page.locator('text=EXPECTED COLUMN HEADERS').first()).toBeVisible();
  });
});
