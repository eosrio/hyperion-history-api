import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
    testDir: '.',
    fullyParallel: false,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 1 : 0,
    workers: 1,
    timeout: 30_000,
    expect: {
        timeout: 10_000,
    },
    reporter: [
        ['list'],
        ['json', { outputFile: '../reports/explorer-test-report.json' }],
    ],
    use: {
        baseURL: process.env.EXPLORER_URL || 'http://127.0.0.1:14210',
        trace: 'on-first-retry',
        screenshot: 'only-on-failure',
    },
    projects: [
        {
            name: 'chromium',
            use: { ...devices['Desktop Chrome'] },
        },
    ],
});
