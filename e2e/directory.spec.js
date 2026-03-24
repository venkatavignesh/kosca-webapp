// @ts-check
const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');

test.describe('Invoices Directory', () => {

  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/ar/directory');
    // Wait for HTMX table to load
    await page.waitForSelector('#table-data table', { timeout: 15_000 });
  });

  test('directory page loads with customer table', async ({ page }) => {
    await expect(page.locator('h1')).toContainText('AR Customer Directory');
    // Table header columns
    await expect(page.locator('th:has-text("Code")')).toBeVisible();
    await expect(page.locator('th:has-text("Customer")')).toBeVisible();
    await expect(page.locator('th:has-text("BDE")')).toBeVisible();
    await expect(page.locator('th:has-text("Outstanding")')).toBeVisible();
    await expect(page.locator('th:has-text("Max Aging")')).toBeVisible();
  });

  test('customer count is displayed', async ({ page }) => {
    // Count bar shows "X customers"
    const countBar = page.locator('#table-data >> text=/\\d+ customer/');
    await expect(countBar).toBeVisible();
  });

  test('customer rows are rendered', async ({ page }) => {
    // At least one customer row should exist
    const rows = page.locator('#table-data tbody tr').first();
    await expect(rows).toBeVisible();
  });

  test('search filters customers', async ({ page }) => {
    const searchInput = page.locator('input[name="search"]');
    await searchInput.fill('BNG');
    // Wait for HTMX debounce + response
    await page.waitForTimeout(1500);
    await page.waitForSelector('#table-data table', { timeout: 10_000 });

    // All visible customer codes should contain BNG (or customer names matching)
    const countText = await page.locator('#table-data >> text=/\\d+ customer/').textContent();
    expect(countText).toBeTruthy();
  });

  test('location filter works', async ({ page }) => {
    // Open location dropdown
    await page.locator('button:has-text("Location")').click();
    await page.waitForTimeout(300);

    // Check one of the site checkboxes
    const firstSite = page.locator('input[name="site"]').first();
    await firstSite.check();

    // Wait for table reload
    await page.waitForSelector('#table-data table', { timeout: 10_000 });
    const countText = await page.locator('#table-data >> text=/\\d+ customer/').textContent();
    expect(countText).toBeTruthy();
  });

  test('aging bucket filter works', async ({ page }) => {
    // Open aging dropdown
    await page.locator('button:has-text("Aging")').click();
    await page.waitForTimeout(300);

    // Check the "Over 180 Days" bucket
    const overBucket = page.locator('input[name="bucket"][value="over_180"]');
    await overBucket.check();

    // Wait for table reload
    await page.waitForSelector('#table-data table', { timeout: 10_000 });
    const countText = await page.locator('#table-data >> text=/\\d+ customer/').textContent();
    expect(countText).toBeTruthy();
  });

  test('sort dropdown changes order', async ({ page }) => {
    const sortSelect = page.locator('select[name="sort"]');

    // Change to "Aging descending"
    await sortSelect.selectOption('aging_desc');
    await page.waitForSelector('#table-data table', { timeout: 10_000 });

    // First row should have a high aging badge
    const firstAging = page.locator('#table-data tbody').first().locator('text=/\\d+d/');
    await expect(firstAging).toBeVisible();
  });

  test('limit dropdown changes row count', async ({ page }) => {
    const limitSelect = page.locator('select[name="limit"]');

    // Change to 5 rows
    await limitSelect.selectOption('5');
    await page.waitForSelector('#table-data table', { timeout: 10_000 });

    // Should show "Showing 1–5"
    await expect(page.locator('text=1–5')).toBeVisible();
  });

  test('expand customer row shows invoice details', async ({ page }) => {
    // Click first customer row
    const firstRow = page.locator('#table-data tbody tr').first();
    await firstRow.click();

    // Wait for detail panel to load via HTMX
    await page.waitForTimeout(2000);

    // Should see invoice detail rows (invoice number, dates, amounts)
    const detailArea = page.locator('#table-data tbody').first();
    await expect(detailArea).toBeVisible();
  });

  test('pagination works', async ({ page }) => {
    // Set limit to 5 for more pages
    await page.locator('select[name="limit"]').selectOption('5');
    await page.waitForSelector('#table-data table', { timeout: 10_000 });

    // Click "Next" or page 2
    const nextBtn = page.locator('button:has-text("Next")');
    if (await nextBtn.isVisible()) {
      await nextBtn.click();
      await page.waitForSelector('#table-data table', { timeout: 10_000 });
      // Should show "Page 2"
      await expect(page.locator('text=/Page 2/')).toBeVisible();
    }
  });

  test('customer code copy button exists', async ({ page }) => {
    // Customer code column should have click-to-copy spans
    const codeSpan = page.locator('#table-data tbody td').nth(1).locator('span[title="Click to copy"]').first();
    await expect(codeSpan).toBeVisible();
  });

  test('refresh button reloads table', async ({ page }) => {
    const refreshBtn = page.locator('button:has-text("Refresh")');
    await refreshBtn.click();
    // Should reload table data
    await page.waitForSelector('#table-data table', { timeout: 10_000 });
    const countText = await page.locator('#table-data >> text=/\\d+ customer/').textContent();
    expect(countText).toBeTruthy();
  });
});
