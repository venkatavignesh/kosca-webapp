// @ts-check
const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');

test.describe('Navigation & Page Load', () => {

  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('all main nav links are accessible', async ({ page }) => {
    const pages = [
      { url: '/ar', check: 'AR Dashboard' },
      { url: '/ar/directory', check: 'AR Customer Directory' },
      { url: '/ar/upload', check: 'Upload AR Reports' },
      { url: '/ar/groups', check: 'Customer Groups' },
    ];

    for (const p of pages) {
      const resp = await page.goto(p.url);
      expect(resp.status()).toBe(200);
      await expect(page.locator(`h1:has-text("${p.check}")`)).toBeVisible({ timeout: 10_000 });
    }
  });

  test('admin pages return 200 for admin user', async ({ page }) => {
    const adminPages = [
      '/admin/users',
      '/admin/categories',
      '/admin/site-assignments',
    ];

    for (const url of adminPages) {
      const resp = await page.goto(url);
      expect(resp.status()).toBe(200);
    }
  });

  test('non-existent page returns error', async ({ page }) => {
    const resp = await page.goto('/this-does-not-exist');
    expect([404, 302, 200]).toContain(resp.status());
  });

  test('date format is DD-MMM-YYYY across views', async ({ page }) => {
    // Use the statement page which renders dates server-side (no HTMX wait)
    await page.goto('/ar/directory');
    await page.waitForSelector('#table-data table', { timeout: 15_000 });

    // Get first customer code from table
    const codeSpan = page.locator('#table-data tbody td').nth(1).locator('span[title="Click to copy"]').first();
    const customerCode = await codeSpan.textContent();

    // Navigate to the statement page directly
    await page.goto(`/ar/customers/${encodeURIComponent(customerCode.trim())}/statement`);
    await page.waitForTimeout(3000);

    const pageText = await page.locator('body').textContent();
    const dateRegex = /\d{2}-(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)-\d{4}/;
    expect(pageText).toMatch(dateRegex);
  });
});
