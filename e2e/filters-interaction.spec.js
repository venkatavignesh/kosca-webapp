// @ts-check
const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');

test.describe('Filter Interactions', () => {

  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/ar/directory');
    await page.waitForSelector('#table-data table', { timeout: 15_000 });
  });

  test('group badge click filters by group', async ({ page }) => {
    // Find a group badge (violet badge with hx-get containing group=)
    const groupBadge = page.locator('#table-data span[hx-get*="group="]').first();
    if (await groupBadge.isVisible({ timeout: 3000 }).catch(() => false)) {
      await groupBadge.click();
      await page.waitForSelector('#table-data table', { timeout: 10_000 });

      // Violet pill should appear in count bar
      await expect(page.locator('#table-data .bg-violet-100').first()).toBeVisible();
      // Hidden input for group should exist
      await expect(page.locator('input[name="group"]').first()).toBeAttached();
    }
  });

  test('BDE badge click filters by BDE', async ({ page }) => {
    // Find a BDE badge (green badge with hx-get containing psr=)
    const bdeBadge = page.locator('#table-data span[hx-get*="psr="]').first();
    if (await bdeBadge.isVisible({ timeout: 3000 }).catch(() => false)) {
      await bdeBadge.click();
      await page.waitForSelector('#table-data table', { timeout: 10_000 });

      // Green pill should appear
      await expect(page.locator('#table-data .bg-green-100').first()).toBeVisible();
      // Hidden input for psr_badge should exist
      await expect(page.locator('input[name="psr_badge"]')).toBeAttached();
    }
  });

  test('group + BDE filters coexist', async ({ page }) => {
    const groupBadge = page.locator('#table-data span[hx-get*="group="]').first();
    if (await groupBadge.isVisible({ timeout: 3000 }).catch(() => false)) {
      await groupBadge.click();
      await page.waitForSelector('#table-data table', { timeout: 10_000 });

      const bdeBadge = page.locator('#table-data span[hx-get*="psr="]').first();
      if (await bdeBadge.isVisible({ timeout: 3000 }).catch(() => false)) {
        await bdeBadge.click();
        await page.waitForSelector('#table-data table', { timeout: 10_000 });

        // At least the BDE pill should be visible
        await expect(page.locator('#table-data .bg-green-100').first()).toBeVisible();
      }
    }
  });

  test('clearing group filter preserves BDE filter', async ({ page }) => {
    const bdeBadge = page.locator('#table-data span[hx-get*="psr="]').first();
    if (await bdeBadge.isVisible({ timeout: 3000 }).catch(() => false)) {
      await bdeBadge.click();
      await page.waitForSelector('#table-data table', { timeout: 10_000 });

      const groupBadge = page.locator('#table-data span[hx-get*="group="]').first();
      if (await groupBadge.isVisible({ timeout: 3000 }).catch(() => false)) {
        await groupBadge.click();
        await page.waitForSelector('#table-data table', { timeout: 10_000 });

        // Clear group by clicking x on violet pill
        const groupClearBtn = page.locator('#table-data .bg-violet-100 button').first();
        if (await groupClearBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
          await groupClearBtn.click();
          await page.waitForSelector('#table-data table', { timeout: 10_000 });

          // BDE pill should still be there
          await expect(page.locator('#table-data .bg-green-100').first()).toBeVisible();
        }
      }
    }
  });

  test('clearing BDE filter preserves group filter', async ({ page }) => {
    const groupBadge = page.locator('#table-data span[hx-get*="group="]').first();
    if (await groupBadge.isVisible({ timeout: 3000 }).catch(() => false)) {
      await groupBadge.click();
      await page.waitForSelector('#table-data table', { timeout: 10_000 });

      const bdeBadge = page.locator('#table-data span[hx-get*="psr="]').first();
      if (await bdeBadge.isVisible({ timeout: 3000 }).catch(() => false)) {
        await bdeBadge.click();
        await page.waitForSelector('#table-data table', { timeout: 10_000 });

        const bdeClearBtn = page.locator('#table-data .bg-green-100 button').first();
        if (await bdeClearBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
          await bdeClearBtn.click();
          await page.waitForSelector('#table-data table', { timeout: 10_000 });

          // Group pill should still be there
          await expect(page.locator('#table-data .bg-violet-100').first()).toBeVisible();
        }
      }
    }
  });

  test('pagination preserves filters', async ({ page }) => {
    await page.locator('select[name="limit"]').selectOption('5');
    await page.waitForSelector('#table-data table', { timeout: 10_000 });

    await page.fill('input[name="search"]', 'BNG');
    await page.waitForTimeout(1500);
    await page.waitForSelector('#table-data table', { timeout: 10_000 });

    const nextBtn = page.locator('#table-data button:has-text("Next")');
    if (await nextBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      if (!(await nextBtn.isDisabled())) {
        await nextBtn.click();
        await page.waitForSelector('#table-data table', { timeout: 10_000 });

        const searchVal = await page.locator('input[name="search"]').inputValue();
        expect(searchVal).toBe('BNG');
      }
    }
  });

  test('category tabs (Key/Sub/Non-Key) work', async ({ page }) => {
    const keyTab = page.locator('button:has-text("Key")').first();
    if (await keyTab.isVisible({ timeout: 3000 }).catch(() => false)) {
      await keyTab.click();
      await page.waitForSelector('#table-data', { timeout: 10_000 });
      await page.waitForTimeout(2000);
      // Table should reload
      const tableData = page.locator('#table-data');
      const content = await tableData.textContent();
      expect(content.length).toBeGreaterThan(0);
    }
  });
});
