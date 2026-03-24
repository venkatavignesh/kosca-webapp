// @ts-check
const { test, expect } = require('@playwright/test');

test.describe('Authentication', () => {

  test('login page renders correctly', async ({ page }) => {
    await page.goto('/login');
    await expect(page.locator('h2')).toContainText('Kosca Distribution LLP');
    await expect(page.locator('input[name="email"]')).toBeVisible();
    await expect(page.locator('input[name="password"]')).toBeVisible();
    await expect(page.locator('button[type="submit"]')).toContainText('Sign in');
  });

  test('invalid login shows error', async ({ page }) => {
    await page.goto('/login');
    await page.fill('input[name="email"]', 'bad@kosca.in');
    await page.fill('input[name="password"]', 'wrongpassword');
    await page.click('button[type="submit"]');
    await expect(page.locator('text=Invalid email or password')).toBeVisible();
  });

  test('successful login redirects to dashboard', async ({ page }) => {
    await page.goto('/login');
    await page.fill('input[name="email"]', 'e2e-admin@kosca.in');
    await page.fill('input[name="password"]', 'Test@1234');
    await page.click('button[type="submit"]');
    await page.waitForURL('**/ar');
    await expect(page).toHaveURL(/\/ar$/);
  });

  test('unauthenticated access redirects to login', async ({ page }) => {
    await page.goto('/ar');
    await expect(page).toHaveURL(/\/login/);
  });

  test('logout redirects to login', async ({ page }) => {
    // Login first
    await page.goto('/login');
    await page.fill('input[name="email"]', 'e2e-admin@kosca.in');
    await page.fill('input[name="password"]', 'Test@1234');
    await page.click('button[type="submit"]');
    await page.waitForURL('**/ar');

    // Logout
    await page.goto('/logout');
    await expect(page).toHaveURL(/\/login/);

    // Confirm can't access protected page
    await page.goto('/ar');
    await expect(page).toHaveURL(/\/login/);
  });
});
