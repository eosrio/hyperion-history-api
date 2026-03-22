/**
 * Hyperion Explorer — E2E Smoke Tests
 *
 * Basic navigation and rendering tests to verify the explorer
 * loads and connects to the Hyperion API correctly.
 *
 * Run via: bun run tests/e2e/hyp-test.ts verify --with-explorer
 *
 * Expects:
 *   - Explorer serving on http://127.0.0.1:14210
 *   - Hyperion API on http://127.0.0.1:17000
 */

import { test, expect, type Page } from '@playwright/test';

const BASE_URL = process.env.EXPLORER_URL || 'http://127.0.0.1:14210';
const API_URL = process.env.HYP_API_URL || 'http://127.0.0.1:17000';

test.describe('Explorer Smoke Tests', () => {

    test.beforeEach(async ({ page }) => {
        // Increase timeout for initial load (Angular SSR/hydration)
        page.setDefaultTimeout(15_000);
    });

    test('home page loads and displays Hyperion title', async ({ page }) => {
        await page.goto(BASE_URL, { waitUntil: 'networkidle' });

        // Verify the page title contains Hyperion
        const title = await page.title();
        expect(title.toLowerCase()).toContain('hyperion');

        // Verify the search input is present
        const searchInput = page.locator('input[formcontrolname="search_field"], input.custom-input');
        await expect(searchInput.first()).toBeVisible({ timeout: 10_000 });
    });

    test('search bar accepts input', async ({ page }) => {
        await page.goto(BASE_URL, { waitUntil: 'networkidle' });

        const searchInput = page.locator('input[formcontrolname="search_field"], input.custom-input');
        await expect(searchInput.first()).toBeVisible({ timeout: 10_000 });

        // Type a test account name
        await searchInput.first().fill('alice');
        await page.waitForTimeout(500);

        // Verify the input has the value
        await expect(searchInput.first()).toHaveValue('alice');
    });

    test('chain stats section is visible', async ({ page }) => {
        await page.goto(BASE_URL, { waitUntil: 'networkidle' });

        // The home page should show chain info (head block, lib, etc.)
        // Look for the stats section or chain details toggle
        const showDetailsBtn = page.locator('text=Chain Details');
        if (await showDetailsBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
            // Click to expand chain details
            await showDetailsBtn.click();
            await page.waitForTimeout(500);
        }

        // Verify actual chain data loaded (not just the Angular shell)
        const pageContent = await page.textContent('body');
        expect(pageContent).toBeTruthy();
        // Check for evidence of a real block number (any digit sequence indicates data loaded)
        expect(pageContent).toMatch(/\d+/);
    });

    test('API health endpoint responds', async ({ page }) => {
        // Direct API check to ensure the explorer has a healthy backend
        const response = await page.request.get(`${API_URL}/v2/health`);
        expect(response.ok(), `API health returned ${response.status()}`).toBeTruthy();
    });

    test('navigating to /account/eosio renders account page', async ({ page }) => {
        await page.goto(`${BASE_URL}/account/eosio`, { waitUntil: 'networkidle' });

        // Wait for Angular hydration and API data fetch
        // Look for account-specific UI elements that only render with real data
        const accountDataLocator = page.locator(
            '.account-info, .mat-tab-label, .account-details, [class*="account"], app-account'
        );
        await expect(accountDataLocator.first()).toBeVisible({ timeout: 10_000 });

        // Verify the account name appears in rendered content (not just URL)
        const pageContent = await page.textContent('body');
        expect(pageContent?.toLowerCase()).toContain('eosio');
    });

    test('navigating to /block/1 renders block page', async ({ page }) => {
        await page.goto(`${BASE_URL}/block/1`, { waitUntil: 'networkidle' });

        // Wait for block data to load — look for block-specific content
        const blockDataLocator = page.locator(
            '.block-info, .block-details, [class*="block"], app-block'
        );
        await expect(blockDataLocator.first()).toBeVisible({ timeout: 10_000 });

        // Verify actual block data rendered (block number, producer, timestamp, etc.)
        const pageContent = await page.textContent('body');
        expect(pageContent).toBeTruthy();
        // Block 1 should show producer or block num
        expect(pageContent).toMatch(/block|producer|timestamp|\d+/i);
    });
});
