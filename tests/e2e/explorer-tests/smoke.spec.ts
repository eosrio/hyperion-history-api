/**
 * Hyperion Explorer — E2E Smoke & Integration Tests
 *
 * Runs against a live explorer + indexed API stack.
 * Can be executed standalone (after stack is up) or as part of the full pipeline.
 *
 * Run standalone:
 *   bun run tests/e2e/hyp-test.ts explorer test
 *
 * Expects:
 *   - Explorer serving on http://127.0.0.1:14210
 *   - Hyperion API on http://127.0.0.1:17000 (with indexed data)
 */

import { test, expect } from '@playwright/test';

const BASE_URL = process.env.EXPLORER_URL || 'http://127.0.0.1:14210';
const API_URL = process.env.HYP_API_URL || 'http://127.0.0.1:17000';

// ── Helpers ───────────────────────────────────────────────────

/** Fetch a trx_id from the API to use in transaction tests */
async function getTransferTrxId(): Promise<string | null> {
    try {
        const resp = await fetch(`${API_URL}/v2/history/get_actions?act.name=transfer&limit=1`);
        if (!resp.ok) return null;
        const data = await resp.json() as any;
        return data.actions?.[0]?.trx_id ?? null;
    } catch {
        return null;
    }
}

// ── 1. API Backend Health ─────────────────────────────────────

test.describe('API Backend', () => {

    test('health endpoint responds with 200', async ({ request }) => {
        const response = await request.get(`${API_URL}/v2/health`);
        expect(response.ok(), `API health returned ${response.status()}`).toBeTruthy();
        const data = await response.json();
        expect(data.health?.length).toBeGreaterThan(0);
    });

    test('chain info returns valid data', async ({ request }) => {
        const response = await request.post(`${API_URL}/v1/chain/get_info`);
        expect(response.ok()).toBeTruthy();
        const data = await response.json();
        expect(data.chain_id).toBeTruthy();
        expect(data.head_block_num).toBeGreaterThan(0);
    });
});

// ── 2. Home Page ──────────────────────────────────────────────

test.describe('Home Page', () => {

    test.beforeEach(async ({ page }) => {
        page.setDefaultTimeout(15_000);
    });

    test('loads and displays Hyperion title', async ({ page }) => {
        await page.goto(BASE_URL, { waitUntil: 'networkidle' });
        const title = await page.title();
        expect(title.toLowerCase()).toContain('hyperion');
    });

    test('search bar is visible and accepts input', async ({ page }) => {
        await page.goto(BASE_URL, { waitUntil: 'networkidle' });

        const searchInput = page.locator('input[formcontrolname="search_field"], input.custom-input');
        await expect(searchInput.first()).toBeVisible({ timeout: 10_000 });

        await searchInput.first().fill('alice');
        await expect(searchInput.first()).toHaveValue('alice');
    });

    test('chain data loaded (not empty shell)', async ({ page }) => {
        await page.goto(BASE_URL, { waitUntil: 'networkidle' });

        // The pre-header or home content should contain block numbers
        const body = await page.textContent('body');
        expect(body).toBeTruthy();
        // Should contain numeric data (head block, etc.) — proves API data loaded
        expect(body).toMatch(/\d+/);
    });
});

// ── 3. Account Page ───────────────────────────────────────────

test.describe('Account Page', () => {

    test.beforeEach(async ({ page }) => {
        page.setDefaultTimeout(15_000);
    });

    test('eosio account renders with balance and resources', async ({ page }) => {
        await page.goto(`${BASE_URL}/account/eosio`, { waitUntil: 'networkidle' });

        // Wait for #account-content (only rendered when account data loaded)
        const accountContent = page.locator('#account-content');
        await expect(accountContent).toBeVisible({ timeout: 10_000 });

        // Account name should be displayed in the title
        const accTitle = page.locator('.acc-title');
        await expect(accTitle).toContainText('eosio');

        // Balance card should be visible
        const balanceCard = page.locator('#balance-card');
        await expect(balanceCard).toBeVisible();

        // Total Balance label should be present
        await expect(balanceCard).toContainText('Total Balance');
    });

    test('alice account shows tokens', async ({ page }) => {
        await page.goto(`${BASE_URL}/account/alice`, { waitUntil: 'networkidle' });

        const accountContent = page.locator('#account-content');
        await expect(accountContent).toBeVisible({ timeout: 10_000 });

        // Alice should have the account name in the title
        const accTitle = page.locator('.acc-title');
        await expect(accTitle).toContainText('alice');

        // Tokens section should show found tokens
        const tokensSection = page.locator('text=Tokens');
        await expect(tokensSection.first()).toBeVisible({ timeout: 5_000 });
    });

    test('account actions table is populated', async ({ page }) => {
        await page.goto(`${BASE_URL}/account/alice`, { waitUntil: 'networkidle' });

        const accountContent = page.locator('#account-content');
        await expect(accountContent).toBeVisible({ timeout: 10_000 });

        // Actions section header should be visible
        await expect(page.locator('text=Actions').first()).toBeVisible();

        // The mat-table should have rendered rows
        const actionRows = page.locator('.actions-table tr.mat-mdc-row, .actions-table mat-row');
        // Wait for at least one action row (alice has transfers)
        await expect(actionRows.first()).toBeVisible({ timeout: 10_000 });
    });

    test('non-existent account shows "Account not found"', async ({ page }) => {
        await page.goto(`${BASE_URL}/account/zzzzzzzzzzz1`, { waitUntil: 'networkidle' });

        // Should show the not-found message
        await expect(page.locator('text=Account not found')).toBeVisible({ timeout: 10_000 });
    });
});

// ── 4. Block Page ─────────────────────────────────────────────

test.describe('Block Page', () => {

    test.beforeEach(async ({ page }) => {
        page.setDefaultTimeout(15_000);
    });

    test('block 1 renders with producer and block ID', async ({ page }) => {
        await page.goto(`${BASE_URL}/block/1`, { waitUntil: 'networkidle' });

        // Block number should be visible ("Block 1")
        await expect(page.locator('text=Block').first()).toBeVisible({ timeout: 10_000 });

        // Producer label should be displayed
        await expect(page.locator('text=Producer').first()).toBeVisible();

        // Block ID should be shown
        await expect(page.locator('text=Block ID').first()).toBeVisible();
    });

    test('block page shows transactions table', async ({ page }) => {
        // Use a higher block number that likely has transactions from the load phase
        // Try block 10 first (system block, should have at least system txs)
        await page.goto(`${BASE_URL}/block/10`, { waitUntil: 'networkidle' });

        // Check for "Transaction" or "Transactions" text
        const txLabel = page.locator('text=/Transaction/');
        await expect(txLabel.first()).toBeVisible({ timeout: 10_000 });
    });

    test('block navigation (previous/next) works', async ({ page }) => {
        await page.goto(`${BASE_URL}/block/5`, { waitUntil: 'networkidle' });

        // Wait for block to load
        await expect(page.locator('text=Block ID').first()).toBeVisible({ timeout: 10_000 });

        // Click "Next Block"
        const nextBtn = page.locator('text=Next Block');
        await expect(nextBtn).toBeVisible();
        await nextBtn.click();

        // URL should change
        await page.waitForURL(`${BASE_URL}/block/**`, { timeout: 5_000 });
        // The page should still show block content
        await expect(page.locator('text=Block ID').first()).toBeVisible({ timeout: 10_000 });
    });

    test('non-existent block shows "Block not found"', async ({ page }) => {
        await page.goto(`${BASE_URL}/block/99999999`, { waitUntil: 'networkidle' });

        await expect(page.locator('text=Block not found')).toBeVisible({ timeout: 10_000 });
    });
});

// ── 5. Transaction Page ───────────────────────────────────────

test.describe('Transaction Page', () => {

    test.beforeEach(async ({ page }) => {
        page.setDefaultTimeout(15_000);
    });

    test('valid transaction renders with actions', async ({ page }) => {
        const trxId = await getTransferTrxId();
        test.skip(!trxId, 'No transfer trx_id found in API — skipping');

        await page.goto(`${BASE_URL}/transaction/${trxId}`, { waitUntil: 'networkidle' });

        // Transaction title should be visible
        await expect(page.locator('text=Transaction').first()).toBeVisible({ timeout: 10_000 });

        // The trx_id should be displayed in the page
        const body = await page.textContent('body');
        expect(body).toContain(trxId!.substring(0, 8));

        // CPU and NET usage should be shown
        await expect(page.locator('text=CPU').first()).toBeVisible();
        await expect(page.locator('text=NET').first()).toBeVisible();

        // Block number link should be present
        await expect(page.locator('text=Block number').first()).toBeVisible();

        // Actions table should have at least one row
        const actionRows = page.locator('.actions-table tr.mat-mdc-row, .actions-table mat-row');
        await expect(actionRows.first()).toBeVisible({ timeout: 5_000 });
    });

    test('non-existent transaction shows "Transaction not found"', async ({ page }) => {
        const fakeId = 'a'.repeat(64);
        await page.goto(`${BASE_URL}/transaction/${fakeId}`, { waitUntil: 'networkidle' });

        await expect(page.locator('text=Transaction not found')).toBeVisible({ timeout: 10_000 });
    });
});

// ── 6. Search Navigation ──────────────────────────────────────

test.describe('Search Navigation', () => {

    test.beforeEach(async ({ page }) => {
        page.setDefaultTimeout(15_000);
    });

    test('searching for account name navigates to account page', async ({ page }) => {
        await page.goto(BASE_URL, { waitUntil: 'networkidle' });

        const searchInput = page.locator('input[formcontrolname="search_field"], input.custom-input');
        await expect(searchInput.first()).toBeVisible({ timeout: 10_000 });

        await searchInput.first().fill('alice');
        await searchInput.first().press('Enter');

        // Should navigate to the account page
        await page.waitForURL(`${BASE_URL}/account/alice`, { timeout: 10_000 });
        const accountContent = page.locator('#account-content');
        await expect(accountContent).toBeVisible({ timeout: 10_000 });
    });

    test('searching for block number navigates to block page', async ({ page }) => {
        await page.goto(BASE_URL, { waitUntil: 'networkidle' });

        const searchInput = page.locator('input[formcontrolname="search_field"], input.custom-input');
        await expect(searchInput.first()).toBeVisible({ timeout: 10_000 });

        await searchInput.first().fill('5');
        await searchInput.first().press('Enter');

        // Should navigate to the block page
        await page.waitForURL(`${BASE_URL}/block/5`, { timeout: 10_000 });
        await expect(page.locator('text=Block ID').first()).toBeVisible({ timeout: 10_000 });
    });
});

// ── 7. Cross-page Navigation ──────────────────────────────────

test.describe('Cross-page Navigation', () => {

    test.beforeEach(async ({ page }) => {
        page.setDefaultTimeout(15_000);
    });

    test('clicking a block link on account page navigates to block page', async ({ page }) => {
        await page.goto(`${BASE_URL}/account/alice`, { waitUntil: 'networkidle' });

        const accountContent = page.locator('#account-content');
        await expect(accountContent).toBeVisible({ timeout: 10_000 });

        // Find a block number link in the actions table
        const blockLink = page.locator('.actions-table a[href*="/block/"]');
        if (await blockLink.count() > 0) {
            await blockLink.first().click();
            await page.waitForURL(`${BASE_URL}/block/**`, { timeout: 5_000 });
            await expect(page.locator('text=Block ID').first()).toBeVisible({ timeout: 10_000 });
        }
    });

    test('clicking a tx link on account page navigates to transaction page', async ({ page }) => {
        await page.goto(`${BASE_URL}/account/alice`, { waitUntil: 'networkidle' });

        const accountContent = page.locator('#account-content');
        await expect(accountContent).toBeVisible({ timeout: 10_000 });

        // Find a transaction link in the actions table
        const txLink = page.locator('.actions-table a[href*="/transaction/"]');
        if (await txLink.count() > 0) {
            await txLink.first().click();
            await page.waitForURL(`${BASE_URL}/transaction/**`, { timeout: 5_000 });
            await expect(page.locator('text=Transaction').first()).toBeVisible({ timeout: 10_000 });
        }
    });
});
