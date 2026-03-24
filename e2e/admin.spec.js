// @ts-check
const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');

test.describe('Admin Pages', () => {

  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('admin users page loads', async ({ page }) => {
    await page.goto('/admin/users');
    await expect(page.locator('h1:has-text("User Management")')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('th:has-text("NAME")')).toBeVisible();
    await expect(page.locator('th:has-text("EMAIL")')).toBeVisible();
  });

  test('admin key accounts page loads', async ({ page }) => {
    await page.goto('/admin/key-accounts');
    await page.waitForTimeout(2000);
    await expect(page.locator('h1')).toBeVisible({ timeout: 10_000 });
  });

  test('admin sub distributors page loads', async ({ page }) => {
    await page.goto('/admin/sub-distributors');
    await page.waitForTimeout(2000);
    await expect(page.locator('h1')).toBeVisible({ timeout: 10_000 });
  });

  test('site assignments page loads', async ({ page }) => {
    await page.goto('/admin/site-assignments');
    await page.waitForTimeout(2000);
    await expect(page.locator('h1')).toBeVisible({ timeout: 10_000 });
  });

  test('groups page loads', async ({ page }) => {
    await page.goto('/ar/groups');
    await page.waitForTimeout(2000);
    await expect(page.locator('h1:has-text("Groups")')).toBeVisible({ timeout: 10_000 });
  });
});
