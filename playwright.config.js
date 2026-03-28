// @ts-check
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
    testDir: './e2e',
    timeout: 30_000,
    expect: { timeout: 10_000 },
    fullyParallel: false, // run sequentially so video tells a story
    retries: 0,
    reporter: [
        ['html', { open: 'never' }], // generates playwright-report/
        ['list'], // console output
    ],
    use: {
        baseURL: 'http://localhost:3001',
        headless: true,
        screenshot: 'on', // screenshot after every test
        video: 'retain-on-failure', // record video only for failing tests
        trace: 'retain-on-failure', // full trace only for failing tests
        viewport: { width: 1440, height: 900 },
        actionTimeout: 8_000,
        navigationTimeout: 15_000,
    },
    projects: [
        {
            name: 'chromium',
            use: { browserName: 'chromium' },
        },
    ],
});
