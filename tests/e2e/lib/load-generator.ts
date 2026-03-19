/**
 * LoadGenerator — Creates deterministic transaction patterns on the test chain
 * and records them in a manifest for later integrity verification.
 *
 * Uses `cleos` inside the nodeos container for all transaction submission.
 */

import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const CONTAINER = 'hyp-test-nodeos';

export interface ManifestEntry {
    trxId: string;
    action: string;
    contract: string;
    data: Record<string, any>;
    blockNum?: number;
    accounts: string[];  // all accounts involved
}

export interface LoadManifest {
    generatedAt: string;
    profile: LoadProfile;
    entries: ManifestEntry[];
    summary: {
        totalTransactions: number;
        transfers: number;
        customActions: number;
        accountsCreated: number;
    };
}

export interface LoadProfile {
    transfers: number;
    customActions: number;
    nestedDepth: number;
    bigPayloadSize: number;
}

const DEFAULT_PROFILE: LoadProfile = {
    transfers: 100,
    customActions: 50,
    nestedDepth: 3,
    bigPayloadSize: 1024,
};

export class LoadGenerator {
    private profile: LoadProfile;
    private manifest: ManifestEntry[] = [];
    private verbose: boolean;
    private nonceCounter = 0;

    constructor(profile: Partial<LoadProfile> = {}, verbose = false) {
        this.profile = { ...DEFAULT_PROFILE, ...profile };
        this.verbose = verbose;
    }

    /**
     * Run a cleos command inside the nodeos container and return the output.
     */
    private cleos(args: string): string {
        // Merge stderr into stdout — cleos prints the execution trace to stderr
        const cmd = `docker exec ${CONTAINER} cleos -u http://127.0.0.1:8888 ${args} 2>&1`;
        try {
            const result = execSync(cmd, { stdio: 'pipe', timeout: 30000 });
            return result?.toString().trim() ?? '';
        } catch (err: any) {
            const output = err.stderr?.toString() ?? err.stdout?.toString() ?? err.message;
            if (this.verbose) console.error(`   cleos error: ${output}`);
            throw new Error(`cleos failed: ${output}`);
        }
    }

    /**
     * Push an action and record the trx_id in the manifest.
     * When useNonce is true, appends a unique nonce value to prevent duplicate transaction errors.
     */
    private pushAction(contract: string, action: string, data: string, auth: string, extraAccounts: string[] = [], useNonce = false): string {
        let output: string;

        if (useNonce) {
            // Use cleos push action with -x (expiration) and a nonce embedded via the data itself
            // The simplest approach: append nonce to the shell command via --force-unique
            output = this.cleos(`push action ${contract} ${action} '${data}' -p ${auth} --force-unique`);
        } else {
            output = this.cleos(`push action ${contract} ${action} '${data}' -p ${auth}`);
        }

        // Extract trx_id from cleos output
        const trxMatch = output.match(/executed transaction:\s+([a-f0-9]+)/);
        const trxId = trxMatch?.[1] ?? 'unknown';

        // Extract block number
        const blockMatch = output.match(/#(\d+)/);
        const blockNum = blockMatch ? parseInt(blockMatch[1]) : undefined;

        // Parse the auth account
        const authAccount = auth.split('@')[0];

        this.manifest.push({
            trxId,
            action,
            contract,
            data: JSON.parse(data),
            blockNum,
            accounts: [authAccount, ...extraAccounts],
        });

        return trxId;
    }

    /**
     * Generate token transfers with unique memos.
     */
    private async generateTransfers(): Promise<void> {
        console.log(`   💸 Generating ${this.profile.transfers} transfers...`);
        const accounts = ['alice', 'bob', 'carol', 'dave'];
        let count = 0;

        for (let i = 0; i < this.profile.transfers; i++) {
            const from = accounts[i % accounts.length];
            const to = accounts[(i + 1) % accounts.length];
            const amount = ((i + 1) * 0.0001).toFixed(4);
            const memo = `e2e-test-${i.toString().padStart(6, '0')}`;

            try {
                this.pushAction(
                    'eosio.token', 'transfer',
                    `["${from}", "${to}", "${amount} TST", "${memo}"]`,
                    `${from}@active`,
                    [from, to, 'eosio.token']
                );
                count++;
            } catch {
                if (this.verbose) console.log(`      ⚠ Transfer ${i} failed`);
            }
        }
        console.log(`      ✓ ${count}/${this.profile.transfers} transfers`);
    }

    /**
     * Generate custom hyp.test contract actions.
     */
    private async generateCustomActions(): Promise<void> {
        console.log(`   🧪 Generating ${this.profile.customActions} custom actions...`);
        const accounts = ['alice', 'bob', 'carol', 'dave'];
        let count = 0;

        for (let i = 0; i < this.profile.customActions; i++) {
            const acct = accounts[i % accounts.length];

            try {
                // storedata — creates a delta entry
                this.pushAction(
                    'hyp.test', 'storedata',
                    `["${acct}", "key-${i}", "value-${i}-${Date.now()}"]`,
                    `${acct}@active`
                );
                count++;
            } catch {
                if (this.verbose) console.log(`      ⚠ storedata ${i} failed`);
            }
        }
        console.log(`      ✓ ${count}/${this.profile.customActions} storedata actions`);
    }

    /**
     * Generate nested inline actions to test depth indexing.
     */
    private async generateNestedActions(): Promise<void> {
        const depth = this.profile.nestedDepth;
        console.log(`   🔄 Generating nested actions (depth=${depth})...`);

        try {
            this.pushAction(
                'hyp.test', 'nestaction',
                `["alice", ${depth}, 0, "nested-test-${Date.now()}"]`,
                'hyp.test@active',
                ['alice']
            );
            console.log(`      ✓ Nested action depth=${depth}`);
        } catch (err: any) {
            console.log(`      ⚠ Nested action failed: ${err.message?.substring(0, 80)}`);
        }
    }

    /**
     * Generate increment actions for counter delta tracking.
     */
    private async generateIncrements(): Promise<void> {
        const count = 20;
        console.log(`   📊 Generating ${count} increment actions...`);
        let success = 0;

        for (let i = 0; i < count; i++) {
            const acct = ['alice', 'bob', 'carol', 'dave'][i % 4];
            try {
                this.pushAction(
                    'hyp.test', 'increment',
                    `["${acct}"]`,
                    'hyp.test@active',
                    [acct],
                    true  // useNonce: identical data needs --force-unique
                );
                success++;
            } catch {
                // Silently skip
            }
        }
        console.log(`      ✓ ${success}/${count} increments`);
    }

    /**
     * Generate a large payload action for deserialization testing.
     */
    private async generateBigPayload(): Promise<void> {
        const size = this.profile.bigPayloadSize;
        console.log(`   📦 Generating big payload (${size} bytes)...`);

        const payload = 'A'.repeat(size);
        try {
            this.pushAction(
                'hyp.test', 'bigpayload',
                `["alice", "${payload}"]`,
                'alice@active'
            );
            console.log(`      ✓ Big payload ${size} bytes`);
        } catch (err: any) {
            console.log(`      ⚠ Big payload failed: ${err.message?.substring(0, 80)}`);
        }
    }

    /**
     * Run the full load generation pipeline.
     */
    async generate(): Promise<LoadManifest> {
        console.log('\n📝 Starting load generation...\n');

        await this.generateTransfers();
        await this.generateCustomActions();
        await this.generateNestedActions();
        await this.generateIncrements();
        await this.generateBigPayload();

        const transferCount = this.manifest.filter(e => e.action === 'transfer').length;
        const customCount = this.manifest.filter(e => e.contract === 'hyp.test').length;

        const loadManifest: LoadManifest = {
            generatedAt: new Date().toISOString(),
            profile: this.profile,
            entries: this.manifest,
            summary: {
                totalTransactions: this.manifest.length,
                transfers: transferCount,
                customActions: customCount,
                accountsCreated: 0,
            },
        };

        console.log(`\n✅ Load generation complete: ${loadManifest.summary.totalTransactions} transactions`);
        console.log(`   Transfers: ${transferCount}, Custom: ${customCount}\n`);

        return loadManifest;
    }

    /**
     * Save the manifest to disk.
     */
    static saveManifest(manifest: LoadManifest, dir: string): string {
        mkdirSync(dir, { recursive: true });
        const path = join(dir, 'manifest.json');
        writeFileSync(path, JSON.stringify(manifest, null, 2));
        console.log(`📋 Manifest saved to ${path}`);
        return path;
    }
}
