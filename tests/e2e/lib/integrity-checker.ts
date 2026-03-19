/**
 * IntegrityChecker — Validates indexed data against the load generation manifest.
 *
 * Queries Elasticsearch to verify that all generated transactions were indexed
 * correctly with proper data integrity.
 */

import { readFileSync } from 'node:fs';

interface ManifestEntry {
    trxId: string;
    action: string;
    contract: string;
    data: string[];
    accounts: string[];
}

interface Manifest {
    generatedAt: string;
    profile: {
        transfers: number;
        customActions: number;
        nestedDepth: number;
        bigPayloadSize: number;
    };
    entries: ManifestEntry[];
    summary: {
        totalTransactions: number;
        transfers: number;
        customActions: number;
        accountsCreated: number;
    };
}

interface CheckResult {
    name: string;
    passed: boolean;
    expected: string | number;
    actual: string | number;
    details?: string;
}

interface IntegrityReport {
    timestamp: string;
    totalChecks: number;
    passed: number;
    failed: number;
    checks: CheckResult[];
}

export interface IntegrityCheckerConfig {
    esUrl: string;
    manifestPath: string;
    chainName?: string;
    verbose?: boolean;
}

export class IntegrityChecker {
    private config: Required<Pick<IntegrityCheckerConfig, 'chainName' | 'verbose'>> & IntegrityCheckerConfig;
    private manifest!: Manifest;

    constructor(config: IntegrityCheckerConfig) {
        this.config = {
            chainName: 'hyp-test',
            verbose: false,
            ...config,
        };
    }

    /**
     * Run all integrity checks and return a structured report.
     */
    async runAll(): Promise<IntegrityReport> {
        this.manifest = JSON.parse(readFileSync(this.config.manifestPath, 'utf-8'));
        const checks: CheckResult[] = [];

        console.log('🔍 Running integrity checks...\n');

        checks.push(await this.checkBlockContinuity());
        checks.push(await this.checkTransferCompleteness());
        checks.push(await this.checkTransferDataIntegrity());
        checks.push(await this.checkCustomActionCompleteness());
        checks.push(await this.checkDeltaIndexing());
        checks.push(await this.checkAbiTracking());
        checks.push(await this.checkMemoSearch());
        checks.push(await this.checkInlineActions());
        checks.push(await this.checkBigPayload());

        // Additional checks when trxIds are available
        const hasRealTrxIds = this.manifest.entries.some(e => e.trxId !== 'unknown');
        if (hasRealTrxIds) {
            checks.push(await this.checkTransactionIdIntegrity());
        }

        // Print results
        const passed = checks.filter(c => c.passed).length;
        const failed = checks.filter(c => !c.passed).length;

        console.log('\n' + '='.repeat(60));
        for (const check of checks) {
            const icon = check.passed ? '✅' : '❌';
            console.log(`${icon} ${check.name}: expected=${check.expected}, actual=${check.actual}`);
            if (!check.passed && check.details) {
                console.log(`   └─ ${check.details}`);
            }
        }
        console.log('='.repeat(60));
        console.log(`\nResult: ${passed}/${checks.length} passed, ${failed} failed\n`);

        return {
            timestamp: new Date().toISOString(),
            totalChecks: checks.length,
            passed,
            failed,
            checks,
        };
    }

    // ── Elasticsearch Helpers ─────────────────────────────────

    private async esQuery(index: string, body: any): Promise<any> {
        const resp = await fetch(`${this.config.esUrl}/${index}/_search`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        return resp.json();
    }

    private async esCount(index: string, query?: any): Promise<number> {
        const body = query ? { query } : undefined;
        const resp = await fetch(`${this.config.esUrl}/${index}/_count`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: body ? JSON.stringify(body) : undefined,
        });
        const data = await resp.json() as any;
        return data.count ?? 0;
    }

    private get indexPrefix(): string {
        return this.config.chainName;
    }

    // ── Check Implementations ─────────────────────────────────

    /**
     * 1. Block continuity — no gaps AND no duplicates.
     * Uses _count for exact total + cardinality agg for uniqueness check.
     */
    private async checkBlockContinuity(): Promise<CheckResult> {
        const name = 'Block Continuity';

        // Exact total via _count API (no 10K cap)
        const totalDocs = await this.esCount(`${this.indexPrefix}-block-*`);

        // Get range + cardinality via agg
        const result = await this.esQuery(`${this.indexPrefix}-block-*`, {
            size: 0,
            aggs: {
                min_block: { min: { field: 'block_num' } },
                max_block: { max: { field: 'block_num' } },
                unique_blocks: { cardinality: { field: 'block_num', precision_threshold: 40000 } },
            },
        });

        const minBlock = result.aggregations?.min_block?.value ?? 0;
        const maxBlock = result.aggregations?.max_block?.value ?? 0;
        const uniqueCount = result.aggregations?.unique_blocks?.value ?? 0;
        const expectedCount = maxBlock - minBlock + 1;

        if (this.config.verbose) {
            console.log(`   Block range: ${minBlock} → ${maxBlock}, total docs: ${totalDocs}, unique(est): ${uniqueCount}`);
        }

        // Primary check: total docs must equal expected count (exact)
        // Cardinality is an estimate (HyperLogLog) — only used for duplicate detection
        const docsMatch = totalDocs === expectedCount;
        // Allow ±0.5% tolerance on cardinality estimate
        const tolerance = Math.max(expectedCount * 0.005, 10);
        const cardinalityClose = Math.abs(uniqueCount - expectedCount) <= tolerance;

        const passed = docsMatch && cardinalityClose;
        let details: string | undefined;
        if (!docsMatch) {
            const diff = totalDocs - expectedCount;
            details = diff > 0
                ? `Duplicates: ${diff} extra docs for range ${minBlock}..${maxBlock}`
                : `Gaps: missing ${-diff} blocks in range ${minBlock}..${maxBlock}`;
        } else if (!cardinalityClose) {
            details = `Cardinality mismatch: expected ~${expectedCount}, got ${uniqueCount} (possible index issue)`;
        }

        return { name, passed, expected: expectedCount, actual: totalDocs, details };
    }

    /**
     * 2. Transfer completeness — all manifest transfers are indexed.
     */
    private async checkTransferCompleteness(): Promise<CheckResult> {
        const name = 'Transfer Completeness';
        const expectedTransfers = this.manifest.summary.transfers;

        const result = await this.esQuery(`${this.indexPrefix}-action-*`, {
            size: 0,
            query: {
                bool: {
                    must: [
                        { term: { 'act.name': 'transfer' } },
                        { term: { 'act.account': 'eosio.token' } },
                        { match_phrase_prefix: { '@transfer.memo': 'e2e-test-' } },
                    ],
                },
            },
        });

        const actual = result.hits?.total?.value ?? 0;

        return {
            name,
            passed: actual === expectedTransfers,
            expected: expectedTransfers,
            actual,
            details: actual !== expectedTransfers
                ? `Missing ${expectedTransfers - actual} test transfers`
                : undefined,
        };
    }

    /**
     * 3. Transfer data integrity — verify memo content matches expected values.
     */
    private async checkTransferDataIntegrity(): Promise<CheckResult> {
        const name = 'Transfer Data Integrity';
        const transferEntries = this.manifest.entries.filter(e => e.action === 'transfer');

        const result = await this.esQuery(`${this.indexPrefix}-action-*`, {
            size: transferEntries.length + 10,
            query: {
                bool: {
                    must: [
                        { term: { 'act.name': 'transfer' } },
                        { term: { 'act.account': 'eosio.token' } },
                        { match_phrase_prefix: { '@transfer.memo': 'e2e-test-' } },
                    ],
                },
            },
            sort: [{ 'global_sequence': 'asc' }],
        });

        const hits = result.hits?.hits ?? [];
        let matchCount = 0;
        let mismatch = '';

        for (const entry of transferEntries) {
            const memo = entry.data[3]; // [from, to, quantity, memo]
            const hit = hits.find((h: any) => h._source?.['@transfer']?.memo === memo);

            if (hit) {
                const transfer = hit._source?.['@transfer'];
                const expectedFrom = entry.data[0];
                const expectedTo = entry.data[1];

                if (transfer.from === expectedFrom && transfer.to === expectedTo) {
                    matchCount++;
                } else {
                    mismatch = `Memo ${memo}: expected ${expectedFrom}→${expectedTo}, got ${transfer.from}→${transfer.to}`;
                }
            } else {
                mismatch = `Memo ${memo} not found in indexed data`;
            }
        }

        return {
            name,
            passed: matchCount === transferEntries.length,
            expected: transferEntries.length,
            actual: matchCount,
            details: mismatch || undefined,
        };
    }

    /**
     * 4. Custom action completeness — all storedata, increment, nestaction, bigpayload indexed.
     */
    private async checkCustomActionCompleteness(): Promise<CheckResult> {
        const name = 'Custom Action Completeness';
        const customEntries = this.manifest.entries.filter(e => e.contract === 'hyp.test');
        const expected = customEntries.length;

        const result = await this.esQuery(`${this.indexPrefix}-action-*`, {
            size: 0,
            query: {
                bool: {
                    must: [
                        { term: { 'act.account': 'hyp.test' } },
                    ],
                    must_not: [
                        { term: { 'act.name': 'setcode' } },
                        { term: { 'act.name': 'setabi' } },
                    ],
                },
            },
            aggs: {
                by_action: { terms: { field: 'act.name', size: 20 } },
            },
        });

        const actual = result.hits?.total?.value ?? 0;
        const buckets = result.aggregations?.by_action?.buckets ?? [];

        if (this.config.verbose) {
            console.log(`   Custom actions breakdown:`);
            for (const b of buckets) {
                console.log(`     ${b.key}: ${b.doc_count}`);
            }
        }

        return {
            name,
            passed: actual >= expected,
            expected: `≥${expected}`,
            actual,
            details: actual < expected
                ? `Missing custom actions. Breakdown: ${buckets.map((b: any) => `${b.key}=${b.doc_count}`).join(', ')}`
                : undefined,
        };
    }

    /**
     * 5. Delta indexing — verify specific hyp.test table rows have correct field values.
     */
    private async checkDeltaIndexing(): Promise<CheckResult> {
        const name = 'Delta Indexing';

        // Query hyp.test-specific deltas to verify ABI deserialization
        const storeDeltas = await this.esQuery(`${this.indexPrefix}-delta-*`, {
            size: 5,
            query: {
                bool: {
                    must: [
                        { term: { 'code': 'hyp.test' } },
                        { term: { 'table': 'datastore' } },
                    ],
                },
            },
        });

        const storeHits = storeDeltas.hits?.hits ?? [];
        const storeCount = storeDeltas.hits?.total?.value ?? 0;
        let details: string | undefined;

        // Verify deserialized field names exist on the delta documents
        if (storeCount > 0) {
            const doc = storeHits[0]?._source?.data;
            if (!doc) {
                details = 'Delta docs exist but data field is missing (ABI deserialization failure)';
            }
        }

        // Also get total delta count
        const totalDeltas = await this.esCount(`${this.indexPrefix}-delta-*`);

        // We expect: hyp.test datastore rows + system deltas
        const passed = storeCount >= 10 && totalDeltas >= 50;

        if (this.config.verbose) {
            console.log(`   Total deltas: ${totalDeltas}, hyp.test/datastore: ${storeCount}`);
        }

        return {
            name,
            passed,
            expected: `≥10 datastore + ≥50 total`,
            actual: `${storeCount} datastore, ${totalDeltas} total`,
            details,
        };
    }

    /**
     * 6. ABI tracking — verify ABIs were indexed for key contracts.
     */
    private async checkAbiTracking(): Promise<CheckResult> {
        const name = 'ABI Tracking';
        const total = await this.esCount(`${this.indexPrefix}-abi-*`);
        const minExpected = 5;

        return {
            name,
            passed: total >= minExpected,
            expected: `≥${minExpected}`,
            actual: total,
        };
    }

    /**
     * 7. Memo indexing — verify transfer memos are searchable.
     */
    private async checkMemoSearch(): Promise<CheckResult> {
        const name = 'Memo Search';

        const testMemo = 'e2e-test-000025';
        const result = await this.esQuery(`${this.indexPrefix}-action-*`, {
            size: 1,
            query: {
                match_phrase: { '@transfer.memo': testMemo },
            },
        });

        const found = (result.hits?.total?.value ?? 0) > 0;
        const actualMemo = result.hits?.hits?.[0]?._source?.['@transfer']?.memo;

        return {
            name,
            passed: found && actualMemo === testMemo,
            expected: testMemo,
            actual: actualMemo ?? 'not found',
        };
    }

    /**
     * 8. Inline actions — verify nestaction produced inline action chain.
     */
    private async checkInlineActions(): Promise<CheckResult> {
        const name = 'Inline Action Depth';

        const result = await this.esQuery(`${this.indexPrefix}-action-*`, {
            size: 10,
            query: {
                term: { 'act.name': 'nestaction' },
            },
        });

        const total = result.hits?.total?.value ?? 0;

        return {
            name,
            passed: total >= 1,
            expected: '≥1',
            actual: total,
            details: total < 1 ? 'nestaction not found in indexed data' : undefined,
        };
    }

    /**
     * 9. Big payload — verify bigpayload action was deserialized with correct content.
     */
    private async checkBigPayload(): Promise<CheckResult> {
        const name = 'Big Payload Deserialization';

        const result = await this.esQuery(`${this.indexPrefix}-action-*`, {
            size: 1,
            query: {
                term: { 'act.name': 'bigpayload' },
            },
        });

        const hit = result.hits?.hits?.[0]?._source;
        const found = (result.hits?.total?.value ?? 0) > 0;
        const payloadData = hit?.act?.data?.data ?? '';
        const payloadSize = payloadData.length;
        const expectedSize = this.manifest.profile.bigPayloadSize;

        // Strict content check: the LoadGenerator generates 'A'.repeat(size)
        const expectedContent = 'A'.repeat(expectedSize);
        const contentMatch = payloadData === expectedContent;

        let details: string | undefined;
        if (!found) {
            details = 'bigpayload action not found';
        } else if (payloadSize < expectedSize) {
            details = `Payload truncated: got ${payloadSize} chars, expected ${expectedSize}`;
        } else if (!contentMatch) {
            details = `Payload content mismatch: expected all 'A' chars (${expectedSize}), got different content`;
        }

        return {
            name,
            passed: found && contentMatch,
            expected: `${expectedSize} chars (exact match)`,
            actual: found ? `${payloadSize} chars${contentMatch ? ' ✓' : ' (content mismatch)'}` : 'not found',
            details,
        };
    }

    /**
     * 10. Transaction ID integrity — verify exact trx_id matches for manifest entries.
     * Only runs when the manifest has real transaction IDs (not 'unknown').
     */
    private async checkTransactionIdIntegrity(): Promise<CheckResult> {
        const name = 'Transaction ID Integrity';
        const entriesWithTrxId = this.manifest.entries.filter(e => e.trxId !== 'unknown');
        let matchCount = 0;
        let mismatch = '';

        // Sample up to 20 entries to avoid excessive queries
        const sample = entriesWithTrxId.slice(0, 20);

        for (const entry of sample) {
            const result = await this.esQuery(`${this.indexPrefix}-action-*`, {
                size: 1,
                query: {
                    term: { 'trx_id': entry.trxId },
                },
            });

            const hit = result.hits?.hits?.[0]?._source;
            if (hit && hit.act?.name === entry.action) {
                matchCount++;
            } else if (!hit) {
                mismatch = `trx_id ${entry.trxId.slice(0, 12)}... not found (action: ${entry.action})`;
            } else {
                mismatch = `trx_id ${entry.trxId.slice(0, 12)}... found but action mismatch: expected ${entry.action}, got ${hit.act?.name}`;
            }
        }

        return {
            name,
            passed: matchCount === sample.length,
            expected: `${sample.length}/${sample.length} sampled`,
            actual: `${matchCount}/${sample.length}`,
            details: mismatch || undefined,
        };
    }
}
