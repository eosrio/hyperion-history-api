/**
 * ContractDeployer — Bootstraps the developer chain with system contracts,
 * custom test contracts, test accounts, and initial token distribution.
 *
 * Uses `cleos` inside the nodeos container for all on-chain operations.
 */

import { execSync } from 'node:child_process';
import type { ChainEndpoints } from './chain-manager.js';

// Default development key (matches genesis.json initial_key)
const DEV_PRIVATE_KEY = '5KQwrPbwdL6PhXujxW37FSSQZ1JiwsST4cqQzDeyXtP79zkvFD3';
const DEV_PUBLIC_KEY = 'EOS6MRyAjQq8ud7hVNYcfnVPJqcVpscN5So8BhtHuGYqET5GDW5CV';

// Container name for exec commands
const CONTAINER = 'hyp-test-nodeos';

export interface DeploymentResult {
    accounts: string[];
    contracts: { name: string; account: string }[];
    tokenSymbol: string;
    systemReady: boolean;
}

export interface ContractDeployerConfig {
    tokenSymbol?: string;
    tokenMaxSupply?: string;
    tokenInitialIssue?: string;
    verbose?: boolean;
}

export class ContractDeployer {
    private endpoints: ChainEndpoints;
    private config: Required<ContractDeployerConfig>;

    // Test accounts to create
    private readonly testAccounts = [
        'alice', 'bob', 'carol', 'dave',
        'producer1', 'producer2', 'producer3',
    ];

    constructor(endpoints: ChainEndpoints, config: ContractDeployerConfig = {}) {
        this.endpoints = endpoints;
        this.config = {
            tokenSymbol: config.tokenSymbol ?? 'TST',
            tokenMaxSupply: config.tokenMaxSupply ?? '1000000000.0000',
            tokenInitialIssue: config.tokenInitialIssue ?? '100000000.0000',
            verbose: config.verbose ?? false,
        };
    }

    /**
     * Run a cleos command inside the nodeos container.
     */
    private cleos(args: string): string {
        const cmd = `docker exec ${CONTAINER} cleos -u http://127.0.0.1:8888 ${args}`;
        try {
            const result = execSync(cmd, {
                stdio: this.config.verbose ? 'inherit' : 'pipe',
                timeout: 30000,
            });
            return result?.toString().trim() ?? '';
        } catch (err: any) {
            const output = err.stderr?.toString() ?? err.stdout?.toString() ?? err.message;
            if (this.config.verbose) {
                console.error(`   cleos error: ${output}`);
            }
            throw new Error(`cleos failed: ${output}`);
        }
    }

    /**
     * Check if a cleos error message indicates a safe, expected state.
     */
    private isExpectedError(msg: string): boolean {
        const safePatterns = [
            'already exists',
            'already activated',
            'already unlocked',
            'already imported',
            'name is already taken',
            'already an existing account',
            'duplicate transaction',
            'Cannot create wallet',
        ];
        return safePatterns.some(p => msg.toLowerCase().includes(p.toLowerCase()));
    }

    /**
     * Import a private key into the cleos wallet.
     */
    private async setupWallet(): Promise<void> {
        console.log('🔑 Setting up wallet...');
        try {
            this.cleos('wallet create --to-console');
        } catch (err: any) {
            if (!this.isExpectedError(err.message)) {
                // Wallet may not exist yet, try to unlock
                try {
                    this.cleos('wallet unlock --password PW5KExxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
                } catch (unlockErr: any) {
                    if (!this.isExpectedError(unlockErr.message)) {
                        throw unlockErr;
                    }
                }
            }
        }
        try {
            this.cleos(`wallet import --private-key ${DEV_PRIVATE_KEY}`);
        } catch (err: any) {
            if (!this.isExpectedError(err.message)) throw err;
        }
    }

    /**
     * Deploy system contracts: eosio.token, eosio.msig, eosio.system
     */
    private async deploySystemContracts(): Promise<void> {
        console.log('📦 Deploying system contracts...');

        // Create system accounts
        const systemAccounts = [
            'eosio.bpay', 'eosio.msig', 'eosio.names', 'eosio.ram',
            'eosio.ramfee', 'eosio.saving', 'eosio.stake', 'eosio.token',
            'eosio.vpay', 'eosio.rex', 'eosio.fees',
        ];

        for (const acct of systemAccounts) {
            try {
                this.cleos(`create account eosio ${acct} ${DEV_PUBLIC_KEY} ${DEV_PUBLIC_KEY}`);
                console.log(`   ✓ Created ${acct}`);
            } catch (err: any) {
                if (this.isExpectedError(err.message)) {
                    console.log(`   - ${acct} (already exists)`);
                } else {
                    throw new Error(`Failed to create system account ${acct}: ${err.message}`);
                }
            }
        }

        // Deploy eosio.token
        console.log('   📝 Deploying eosio.token...');
        this.cleos('set contract eosio.token /contracts/system/eosio.token');

        // Deploy eosio.msig
        console.log('   📝 Deploying eosio.msig...');
        this.cleos('set contract eosio.msig /contracts/system/eosio.msig');

        // Activate PREACTIVATE_FEATURE via producer API (must come BEFORE eosio.boot)
        console.log('   ⚙️  Activating PREACTIVATE_FEATURE...');
        try {
            // Activate PREACTIVATE_FEATURE via producer API
            execSync(`docker exec ${CONTAINER} curl -sf -X POST http://127.0.0.1:8888/v1/producer/schedule_protocol_feature_activations -d '{"protocol_features_to_activate": ["0ec7e080177b2c02b278d5088611686b49d739925a92d9bfcacd7fc6b74053bd"]}'`, {
                stdio: this.config.verbose ? 'inherit' : 'pipe',
            });
        } catch (err: any) {
            if (!this.isExpectedError(err.message)) {
                console.warn(`   ⚠️  PREACTIVATE_FEATURE activation failed: ${err.message}`);
            }
        }

        await this.waitBlocks(3);

        // Now deploy eosio.boot (provides the 'activate' action for remaining features)
        console.log('   📝 Deploying eosio.boot...');
        this.cleos('set contract eosio /contracts/system/eosio.boot');

        await this.waitBlocks(2);

        // Dynamically activate ALL supported protocol features in dependency order
        console.log('   ⚙️  Activating all supported protocol features...');
        try {
            const featuresJson = execSync(
                `docker exec ${CONTAINER} curl -sf http://127.0.0.1:8888/v1/producer/get_supported_protocol_features`,
                { stdio: 'pipe' }
            ).toString();
            const features = JSON.parse(featuresJson) as Array<{
                feature_digest: string;
                specification: Array<{ name: string; value: string }>;
                dependencies: string[];
            }>;

            // Build a map of digest -> feature info
            const featureMap = new Map<string, { name: string; digest: string; deps: string[] }>();
            for (const f of features) {
                const name = f.specification.find(s => s.name === 'builtin_feature_codename')?.value ?? 'unknown';
                featureMap.set(f.feature_digest, { name, digest: f.feature_digest, deps: f.dependencies ?? [] });
            }

            // Topological sort to respect dependencies
            const activated = new Set<string>();
            // PREACTIVATE_FEATURE is already activated via producer API
            const preactivateDigest = '0ec7e080177b2c02b278d5088611686b49d739925a92d9bfcacd7fc6b74053bd';
            activated.add(preactivateDigest);

            const activateInOrder = (digest: string): void => {
                if (activated.has(digest)) return;
                const feature = featureMap.get(digest);
                if (!feature) return;
                // Activate dependencies first
                for (const dep of feature.deps) {
                    activateInOrder(dep);
                }
                try {
                    this.cleos(`push action eosio activate '["${digest}"]' -p eosio@active`);
                    console.log(`      ✓ ${feature.name}`);
                    activated.add(digest);
                } catch (err: any) {
                    if (this.isExpectedError(err.message)) {
                        console.log(`      - ${feature.name} (already activated)`);
                        activated.add(digest);
                    } else {
                        console.warn(`      ⚠️ ${feature.name} failed: ${err.message.slice(0, 100)}`);
                    }
                }
            };

            // Activate all features in dependency order
            for (const [digest] of featureMap) {
                activateInOrder(digest);
            }
        } catch (err) {
            console.error('   ⚠️  Could not fetch/activate supported features');
        }

        await this.waitBlocks(3);
        // Deploy eosio.system
        console.log('   📝 Deploying eosio.system...');
        this.cleos('set contract eosio /contracts/system/eosio.system');

        // Create the core token BEFORE system init (init requires the symbol to exist)
        const sym = this.config.tokenSymbol;
        const maxSupply = `${this.config.tokenMaxSupply} ${sym}`;
        const initialIssue = `${this.config.tokenInitialIssue} ${sym}`;
        console.log(`   💰 Creating token ${sym}...`);
        this.cleos(`push action eosio.token create '["eosio", "${maxSupply}"]' -p eosio.token@active`);
        this.cleos(`push action eosio.token issue '["eosio", "${initialIssue}", "initial issue"]' -p eosio@active`);

        // Initialize system contract (requires token to exist)
        console.log('   ⚙️  Initializing eosio.system...');
        this.cleos(`push action eosio init '[0, "4,${this.config.tokenSymbol}"]' -p eosio@active`);

        console.log('   ✅ System contracts deployed');
    }



    /**
     * Create test accounts and distribute tokens.
     */
    private async setupTestAccounts(): Promise<void> {
        console.log('👥 Creating test accounts...');

        const transferAmount = `10000.0000 ${this.config.tokenSymbol}`;

        for (const acct of this.testAccounts) {
            try {
                this.cleos(`system newaccount eosio ${acct} ${DEV_PUBLIC_KEY} ${DEV_PUBLIC_KEY} --stake-net "100.0000 ${this.config.tokenSymbol}" --stake-cpu "100.0000 ${this.config.tokenSymbol}" --buy-ram-kbytes 1024`);
                console.log(`   ✓ Created ${acct}`);
            } catch (err: any) {
                if (this.isExpectedError(err.message)) {
                    console.log(`   - ${acct} (already exists)`);
                } else {
                    throw new Error(`Failed to create test account ${acct}: ${err.message}`);
                }
            }

            // Transfer tokens
            try {
                this.cleos(`push action eosio.token transfer '["eosio", "${acct}", "${transferAmount}", "test setup"]' -p eosio@active`);
            } catch (err: any) {
                if (!this.isExpectedError(err.message)) {
                    console.warn(`   ⚠️  Token transfer to ${acct} failed: ${err.message.slice(0, 100)}`);
                }
            }
        }

        console.log('   ✅ Test accounts ready');
    }

    /**
     * Deploy the custom hyp.test contract.
     */
    private async deployTestContract(): Promise<void> {
        console.log('🧪 Deploying hyp.test contract...');

        // Create contract account
        try {
            this.cleos(`system newaccount eosio hyp.test ${DEV_PUBLIC_KEY} ${DEV_PUBLIC_KEY} --stake-net "100.0000 ${this.config.tokenSymbol}" --stake-cpu "100.0000 ${this.config.tokenSymbol}" --buy-ram-kbytes 4096`);
        } catch (err: any) {
            if (this.isExpectedError(err.message)) {
                console.log('   - hyp.test account already exists');
            } else {
                // Fallback to simple create (system contract may not be ready yet)
                try {
                    this.cleos(`create account eosio hyp.test ${DEV_PUBLIC_KEY} ${DEV_PUBLIC_KEY}`);
                } catch (err2: any) {
                    if (this.isExpectedError(err2.message)) {
                        console.log('   - hyp.test account already exists');
                    } else {
                        throw new Error(`Failed to create hyp.test account: ${err2.message}`);
                    }
                }
            }
        }

        // Deploy contract (compiled during Docker build)
        this.cleos('set contract hyp.test /contracts/custom hyp.test.wasm hyp.test.abi');

        // Give hyp.test@active permission to eosio@active for inline actions
        try {
            this.cleos(`set account permission hyp.test active '{"threshold": 1, "keys": [{"key": "${DEV_PUBLIC_KEY}", "weight": 1}], "accounts": [{"permission": {"actor": "hyp.test", "permission": "eosio.code"}, "weight": 1}]}' owner -p hyp.test@owner`);
        } catch {
            // Permission may already be set
        }

        console.log('   ✅ hyp.test contract deployed');
    }

    /**
     * Wait for N blocks to be produced.
     */
    private async waitBlocks(count: number): Promise<void> {
        await new Promise(resolve => setTimeout(resolve, count * 500 + 200));
    }

    /**
     * Run the full deployment pipeline.
     */
    async deploy(): Promise<DeploymentResult> {
        console.log('\n🏗️  Starting chain bootstrap...\n');

        await this.setupWallet();
        await this.deploySystemContracts();
        await this.setupTestAccounts();
        await this.deployTestContract();

        console.log('\n🎉 Chain bootstrap complete!\n');

        return {
            accounts: ['eosio', 'eosio.token', 'eosio.msig', 'hyp.test', ...this.testAccounts],
            contracts: [
                { name: 'eosio.token', account: 'eosio.token' },
                { name: 'eosio.msig', account: 'eosio.msig' },
                { name: 'eosio.system', account: 'eosio' },
                { name: 'hyp.test', account: 'hyp.test' },
            ],
            tokenSymbol: this.config.tokenSymbol,
            systemReady: true,
        };
    }
}
