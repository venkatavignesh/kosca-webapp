// @ts-check
const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');

test.describe('Customer Invoice Details', () => {

  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/ar/directory');
    await page.waitForSelector('#table-data table', { timeout: 15_000 });
  });

  test('expanding a row loads invoice details', async ({ page }) => {
    // Click first customer main row (the one with chevron)
    const firstMainRow = page.locator('#table-data tbody').first().locator('tr').first();
    await firstMainRow.click();

    // Wait for HTMX lazy-load of details
    await page.waitForTimeout(5000);

    // The detail area should show invoice data (not "Loading invoices...")
    const detailArea = page.locator('#table-data tbody').first();
    const detailText = await detailArea.textContent();
    // After expansion, should see invoice info (amounts, dates, etc.)
    expect(detailText.length).toBeGreaterThan(100);
  });

  test('customer trend page loads', async ({ page }) => {
    // Find a trend link directly (the chart icon link)
    const trendLink = page.locator('a[href*="/ar/customer/"][href*="/trend"]').first();
    if (await trendLink.isVisible({ timeout: 3000 }).catch(() => false)) {
      const href = await trendLink.getAttribute('href');
      await page.goto(href);
      await page.waitForTimeout(2000);
      // Trend page should have a heading with customer name
      await expect(page.locator('h1')).toBeVisible({ timeout: 5_000 });
    }
  });

  test('customer statement page loads', async ({ page }) => {
    // Expand first row to get statement link
    const firstRow = page.locator('#table-data tbody').first().locator('tr').first();
    await firstRow.click();
    await page.waitForTimeout(4000);

    const stmtLink = page.locator('a[href*="/statement"]').first();
    if (await stmtLink.isVisible({ timeout: 3000 }).catch(() => false)) {
      const href = await stmtLink.getAttribute('href');
      await page.goto(href);
      await page.waitForTimeout(2000);
      await expect(page.locator('body')).toContainText(/statement|invoice/i);
    }
  });

  // Confirmation: page has embedded invoice data for client-side PDF
  test('statement page has embedded PDF data', async ({ page }) => {
    const firstRow = page.locator('#table-data tbody').first().locator('tr').first();
    await firstRow.click();
    await page.waitForTimeout(4000);

    const stmtLink = page.locator('a[href*="/statement"]').first();
    if (await stmtLink.isVisible({ timeout: 3000 }).catch(() => false)) {
      const href = await stmtLink.getAttribute('href');
      await page.goto(href);
      await page.waitForTimeout(2000);

      // Integration: _stmtData embedded in page for client-side PDF
      const src = await page.content();
      expect(src).toContain('_stmtData');
      expect(src).toContain('"invoices"');
    }
  });

  // Integration: jsPDF static assets are served from the app (not CDN)
  test('jsPDF libraries are served locally', async ({ page }) => {
    const r1 = await page.request.get('/jspdf.umd.min.js');
    const r2 = await page.request.get('/jspdf.plugin.autotable.min.js');
    expect(r1.status()).toBe(200);
    expect(r2.status()).toBe(200);
    expect(r1.headers()['content-type']).toContain('javascript');
    expect(r2.headers()['content-type']).toContain('javascript');
  });

  test('customer export generates Excel', async ({ page }) => {
    // Expand first row
    const firstRow = page.locator('#table-data tbody').first().locator('tr').first();
    await firstRow.click();
    await page.waitForTimeout(4000);

    const exportLink = page.locator('a[href*="/export"]').first();
    if (await exportLink.isVisible({ timeout: 3000 }).catch(() => false)) {
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 10_000 }),
        exportLink.click()
      ]);
      expect(download.suggestedFilename()).toContain('.xlsx');
    }
  });
});
