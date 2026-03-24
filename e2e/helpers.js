// Shared login helper for E2E tests
async function login(page, email = 'e2e-admin@kosca.in', password = 'Test@1234') {
  await page.goto('/login');
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL('**/ar**');
}

module.exports = { login };
