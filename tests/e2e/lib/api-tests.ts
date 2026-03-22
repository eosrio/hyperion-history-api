/**
 * API Test Suite — Tests Hyperion v2 History and State API endpoints.
 *
 * Run with: bun run tests/e2e/api-tests.ts
 * Requires: Hyperion API running on port 17000, with indexed test data.
 */

export interface APITestSuiteConfig {
    apiUrl?: string;
    chainName?: string;
}

const TEST_ACCOUNTS = ['alice', 'bob', 'carol', 'dave'];

interface TestResult {
    name: string;
    endpoint: string;
    passed: boolean;
    status?: number;
    details?: string;
    durationMs: number;
}

class APITestSuite {
    private results: TestResult[] = [];
    private apiUrl: string;
    private chainName: string;

    constructor(config: APITestSuiteConfig = {}) {
        this.apiUrl = config.apiUrl ?? process.env.HYP_API_URL ?? 'http://127.0.0.1:17000';
        this.chainName = config.chainName ?? 'hyp-test';
    }

    /**
     * Run all API tests and return results.
     */
    async runAll(): Promise<TestResult[]> {
        console.log(`\n🧪 Running Hyperion API tests against ${this.apiUrl}\n`);

        // ── Health & Info ──────────────────────────────────────
        await this.test('Health Check', 'GET /v2/health', async () => {
            const resp = await this.get('/v2/health');
            this.assert(resp.status === 200, `Expected 200, got ${resp.status}`);
            const data = await resp.json();
            this.assert(data.health?.length > 0, 'Health array should not be empty');
        });

        await this.test('Chain Info Proxy', 'POST /v1/chain/get_info', async () => {
            const resp = await this.post('/v1/chain/get_info', {});
            this.assert(resp.status === 200, `Expected 200, got ${resp.status}`);
            const data = await resp.json();
            this.assert(!!data.chain_id, 'Should return chain_id');
            this.assert(data.head_block_num > 0, 'Should have head_block_num > 0');
        });

        // ── v2 History ────────────────────────────────────────

        await this.test('Get Actions — all', 'GET /v2/history/get_actions', async () => {
            const resp = await this.get('/v2/history/get_actions?limit=10');
            this.assert(resp.status === 200, `Expected 200, got ${resp.status}`);
            const data = await resp.json();
            this.assert(data.actions?.length > 0, 'Should return actions');
            this.assert(typeof data.total?.value === 'number', 'Should have total value');
        });

        await this.test('Get Actions — account filter', 'GET /v2/history/get_actions?account=alice', async () => {
            const resp = await this.get('/v2/history/get_actions?account=alice&limit=5');
            this.assert(resp.status === 200, `Expected 200, got ${resp.status}`);
            const data = await resp.json();
            this.assert(data.actions?.length > 0, 'Alice should have actions');
            // All actions should involve alice
            for (const a of data.actions) {
                const involved = a.act?.authorization?.some((auth: any) => auth.actor === 'alice') ||
                    a.act?.data?.from === 'alice' || a.act?.data?.to === 'alice' ||
                    a.act?.data?.owner === 'alice' || a.act?.data?.user === 'alice' ||
                    a.notified?.includes('alice');
                this.assert(involved, `Action ${a.global_sequence} should involve alice`);
            }
        });

        await this.test('Get Actions — act.name filter', 'GET /v2/history/get_actions?act.name=transfer', async () => {
            const resp = await this.get('/v2/history/get_actions?act.name=transfer&limit=5');
            this.assert(resp.status === 200, `Expected 200, got ${resp.status}`);
            const data = await resp.json();
            this.assert(data.actions?.length > 0, 'Should have transfer actions');
            for (const a of data.actions) {
                this.assert(a.act?.name === 'transfer', `Action name should be transfer, got ${a.act?.name}`);
            }
        });

        await this.test('Get Actions — pagination', 'GET /v2/history/get_actions?skip&limit', async () => {
            const page1 = await (await this.get('/v2/history/get_actions?limit=3&skip=0')).json();
            const page2 = await (await this.get('/v2/history/get_actions?limit=3&skip=3')).json();
            this.assert(page1.actions?.length === 3, 'Page 1 should have 3 actions');
            this.assert(page2.actions?.length === 3, 'Page 2 should have 3 actions');
            // Pages should not overlap
            const ids1 = new Set(page1.actions.map((a: any) => a.global_sequence));
            const ids2 = new Set(page2.actions.map((a: any) => a.global_sequence));
            for (const id of ids2) {
                this.assert(!ids1.has(id), `Action ${id} should not appear in both pages`);
            }
        });

        await this.test('Get Transaction', 'GET /v2/history/get_transaction', async () => {
            // First get a transaction ID from actions
            const actionsResp = await (await this.get('/v2/history/get_actions?act.name=transfer&limit=1')).json();
            const trxId = actionsResp.actions?.[0]?.trx_id;
            this.assert(!!trxId, 'Should have a trx_id to look up');

            const resp = await this.get(`/v2/history/get_transaction?id=${trxId}`);
            this.assert(resp.status === 200, `Expected 200, got ${resp.status}`);
            const data = await resp.json();
            this.assert(data.trx_id === trxId, `trx_id should match: ${data.trx_id} vs ${trxId}`);
            this.assert(data.actions?.length > 0, 'Transaction should have actions');
        });

        await this.test('Get Deltas', 'GET /v2/history/get_deltas', async () => {
            const resp = await this.get('/v2/history/get_deltas?code=eosio.token&table=accounts&limit=5');
            this.assert(resp.status === 200, `Expected 200, got ${resp.status}`);
            const data = await resp.json();
            this.assert(data.deltas?.length > 0, 'Should return account deltas');
        });

        await this.test('Get Creator', 'GET /v2/history/get_creator', async () => {
            const resp = await this.get('/v2/history/get_creator?account=alice');
            this.assert(resp.status === 200, `Expected 200, got ${resp.status}`);
            const data = await resp.json();
            this.assert(data.creator === 'eosio', `Creator should be eosio, got ${data.creator}`);
            this.assert(data.account === 'alice', `Account should be alice, got ${data.account}`);
        });

        await this.test('Get ABI Snapshot', 'GET /v2/history/get_abi_snapshot', async () => {
            const resp = await this.get('/v2/history/get_abi_snapshot?contract=eosio.token&block=500&fetch=true');
            this.assert(resp.status === 200, `Expected 200, got ${resp.status}`);
            const data = await resp.json();
            this.assert(!!data.abi, 'Should return ABI data');
        });

        // ── v2 State ──────────────────────────────────────────

        await this.test('Get Tokens', 'GET /v2/state/get_tokens', async () => {
            const resp = await this.get('/v2/state/get_tokens?account=alice');
            this.assert(resp.status === 200, `Expected 200, got ${resp.status}`);
            const data = await resp.json();
            this.assert(data.tokens?.length > 0, 'Alice should have tokens');
            const tstToken = data.tokens.find((t: any) => t.symbol === 'TST');
            this.assert(!!tstToken, 'Alice should have TST token');
        });

        await this.test('Get Account', 'GET /v2/state/get_account', async () => {
            const resp = await this.get('/v2/state/get_account?account=alice');
            this.assert(resp.status === 200, `Expected 200, got ${resp.status}`);
            const data = await resp.json();
            this.assert(data.account?.account_name === 'alice', `Account should be alice, got ${data.account?.account_name}`);
        });

        await this.test('Get Key Accounts', 'GET /v2/state/get_key_accounts', async () => {
            // First get alice's public key via chain API
            const accountInfo = await (await this.post('/v1/chain/get_account', { account_name: 'alice' })).json();
            const pubKey = accountInfo?.permissions?.[0]?.required_auth?.keys?.[0]?.key;
            this.assert(!!pubKey, 'Should get alice public key from chain');

            const resp = await this.get(`/v2/state/get_key_accounts?public_key=${pubKey}`);
            this.assert(resp.status === 200, `Expected 200, got ${resp.status}`);
            const data = await resp.json();
            this.assert(data.account_names?.includes('alice'), 'Should find alice by public key');
        });

        // ── v1 Compatibility ──────────────────────────────────

        await this.test('v1 Get Block', 'POST /v1/chain/get_block', async () => {
            const resp = await this.post('/v1/chain/get_block', { block_num_or_id: 2 });
            this.assert(resp.status === 200, `Expected 200, got ${resp.status}`);
            const data = await resp.json();
            this.assert(data.block_num === 2 || data.block_num === '2', `Block number should be 2, got ${data.block_num}`);
        });

        await this.test('v1 Get Actions', 'POST /v1/history/get_actions', async () => {
            const resp = await this.post('/v1/history/get_actions', {
                account_name: 'alice',
                pos: -1,
                offset: -5,
            });
            this.assert(resp.status === 200, `Expected 200, got ${resp.status}`);
            const data = await resp.json();
            this.assert(data.actions?.length > 0, 'Should return legacy format actions');
        });

        // ── Regression Tests ───────────────────────────────────

        await this.test('Duplicate Actions in Same TX (#148)', 'GET /v2/history/get_actions?act.data.memo=dup-test-148', async () => {
            // Look for the duplicate-action TX via the unique memo
            const resp = await this.get('/v2/history/get_actions?act.name=transfer&act.data.memo=dup-test-148&limit=10');
            this.assert(resp.status === 200, `Expected 200, got ${resp.status}`);
            const data = await resp.json();
            // There should be at least 2 actions with this memo (the two duplicates)
            // Each action generates notification traces, so we check unique global_sequences
            const actions = data.actions ?? [];
            const globalSeqs = new Set(actions.map((a: any) => a.global_sequence));
            this.assert(
                globalSeqs.size >= 2,
                `Expected ≥2 unique actions for duplicate TX, got ${globalSeqs.size} (total: ${actions.length})`
            );
        });

        // ── Negative / Error Path Tests ────────────────────────

        await this.test('Error — Non-existent Transaction', 'GET /v2/history/get_transaction?id=invalid', async () => {
            const resp = await this.get('/v2/history/get_transaction?id=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
            // Should return 404 or an error response, not crash
            this.assert(resp.status === 404 || resp.status === 200, `Expected 404 or 200, got ${resp.status}`);
            const data = await resp.json();
            if (resp.status === 200) {
                this.assert(!data.trx_id || data.executed === false, 'Should indicate transaction not found');
            }
        });

        await this.test('Error — Malformed Account Name', 'GET /v2/history/get_actions?account=INVALID!!!', async () => {
            const resp = await this.get('/v2/history/get_actions?account=THIS_IS_INVALID!!!');
            // Should return 400 (Bad Request) with a JSON error, not crash
            this.assert(resp.status === 400 || resp.status === 200, `Unexpected status ${resp.status}`);
            const contentType = resp.headers.get('content-type') ?? '';
            this.assert(contentType.includes('json'), `Error should be JSON, got ${contentType}`);
        });

        await this.test('Error — Extreme Pagination Limit', 'GET /v2/history/get_actions?limit=999999', async () => {
            const resp = await this.get('/v2/history/get_actions?limit=999999');
            // Hyperion may cap the limit (200) or reject it (400)
            // A 500 would indicate an OOM/crash — that should NOT pass
            this.assert(
                resp.status === 200 || resp.status === 400,
                `Expected 200 or 400, got ${resp.status}`
            );
            if (resp.status === 200) {
                const data = await resp.json();
                this.assert(data.actions?.length <= 1000, `Limit should be capped, got ${data.actions?.length} results`);
            }
        });

        await this.test('Error — Invalid Block Number', 'POST /v1/chain/get_block (invalid)', async () => {
            const resp = await this.post('/v1/chain/get_block', { block_num_or_id: 99999999 });
            // v1 chain proxy may return the upstream error with any status (200 with error body, or 4xx/5xx)
            const data = await resp.json();
            // If 200, the body should contain an error indicator from the chain
            if (resp.status === 200) {
                this.assert(
                    data.error || data.code === 500 || !data.block_num,
                    'Expected error body for non-existent block'
                );
            } else {
                this.assert(
                    resp.status === 400 || resp.status === 404 || resp.status === 500,
                    `Expected error status, got ${resp.status}`
                );
            }
        });

        await this.test('Error — Missing Required Params', 'GET /v2/history/get_creator (no account)', async () => {
            const resp = await this.get('/v2/history/get_creator');
            // Should return 400 or 500, not crash
            this.assert(resp.status === 400 || resp.status === 500, `Expected error for missing account, got ${resp.status}`);
        });

        // Print summary
        const passed = this.results.filter(r => r.passed).length;
        const failed = this.results.filter(r => !r.passed).length;

        console.log('\n' + '='.repeat(60));
        for (const r of this.results) {
            const icon = r.passed ? '✅' : '❌';
            const time = `${r.durationMs}ms`;
            console.log(`${icon} [${time}] ${r.name}`);
            if (!r.passed && r.details) {
                console.log(`   └─ ${r.details}`);
            }
        }
        console.log('='.repeat(60));
        console.log(`\nResult: ${passed}/${this.results.length} passed, ${failed} failed\n`);

        return this.results;
    }

    // ── Helpers ──────────────────────────────────────────────

    private async get(path: string): Promise<Response> {
        return fetch(`${this.apiUrl}${path}`);
    }

    private async post(path: string, body: any): Promise<Response> {
        return fetch(`${this.apiUrl}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    }

    private assert(condition: boolean, message: string): void {
        if (!condition) {
            throw new Error(message);
        }
    }

    private async test(name: string, endpoint: string, fn: () => Promise<void>): Promise<void> {
        const start = Date.now();
        try {
            await fn();
            this.results.push({
                name,
                endpoint,
                passed: true,
                durationMs: Date.now() - start,
            });
        } catch (e: any) {
            this.results.push({
                name,
                endpoint,
                passed: false,
                details: e.message,
                durationMs: Date.now() - start,
            });
        }
    }
}

export { APITestSuite };
