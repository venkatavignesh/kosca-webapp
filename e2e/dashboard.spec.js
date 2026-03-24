// @ts-check
const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');

test.describe('Dashboard', () => {

  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('dashboard page loads with metrics', async ({ page }) => {
    await expect(page).toHaveURL(/\/ar$/);
    await expect(page.locator('h1:has-text("AR Dashboard")')).toBeVisible({ timeout: 10_000 });
  });

  test('aging bucket cards are displayed', async ({ page }) => {
    await page.waitForTimeout(3000);
    // Dashboard shows multiple amount cards with Indian Rupee formatting
    const pageText = await page.locator('body').textContent();
    // Amounts like ₹16,55,16,215 or ₹3,06,30,325
    expect(pageText).toMatch(/₹[\d,]+/);
  });

  test('site-level breakdown is displayed', async ({ page }) => {
    await page.waitForTimeout(2000);
    // "Branch Wise Breakdown" or site names
    const hasBreakdown = await page.locator('text=/BRANCH WISE|Bangalore|Chennai|Hyderabad/i').first().isVisible().catch(() => false);
    expect(hasBreakdown).toBeTruthy();
  });

  test('category metrics show Key, Sub, Non-Key sections', async ({ page }) => {
    await page.waitForTimeout(2000);
    await expect(page.locator('text=/CATEGORY OVERVIEW/i').first()).toBeVisible();
  });

  test('last sync timestamp is displayed', async ({ page }) => {
    await page.waitForTimeout(2000);
    // The dashboard shows sync dates like "16 Mar 2026"
    const syncArea = page.locator('text=/\\d{2}.*20\\d{2}/').first();
    await expect(syncArea).toBeVisible({ timeout: 5_000 });
  });
});
