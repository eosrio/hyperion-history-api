# Independent #252 native-worker pilot evidence audit

No captured integrity or correctness discrepancy found. Read-only audit of HAPI `d95d797fc3de8c695e2817a2952eedebeb4b3241`, native Linux Node24.19.0, reversible prefix 1-288, measurement-on/CPU-off.

The raw measured archive SHA-256 is `f71f1ca0040cd9b4e874b06146a92c73c9396855c8bfde6b84fa4288c942ee8b`. All 3,381 regular files match its bytes: 3,396 members/46,044,813 uncompressed bytes. One known relative log symlink was inspected and skipped, never materialized.

Actual projection PID 2029126 / parent 2028999 and API PID 2029005 / parent 2026500 match independent process starts. All phase UUIDs/ACKs and module/helper hashes agree. All 33,116 raw spans reconcile with every counter, settlement, duration total/min/max and undo-cardinality sum. Receipts are sealed with zero observer errors, drops, in-flight spans or session-hook overflow. The API's one failed startup load has unavailable cardinality, not a fabricated validation count.

| Role / start phase | Operations | Loads | Metadata reads | Validations | Transaction starts | Descriptor visits per nested scope |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| projection / startup | 1 | 0 | 0 | 0 | 0 | 0 |
| projection / prefix | 4682 | 5547 | 5553 | 5547 | 864 | 758609 |
| projection / held-head | 144 | 144 | 144 | 144 | 0 | 36864 |
| projection / verification | 186 | 186 | 186 | 186 | 0 | 47616 |
| api / startup | 0 | 1 | 1 | 0 | 0 | unavailable |
| api / prefix | 15 | 21 | 21 | 21 | 3 | 5376 |
| api / held-head | 0 | 0 | 0 | 0 | 0 | 0 |
| api / verification | 15 | 21 | 21 | 21 | 3 | 5376 |

Counts are attributed by start phase, not solely per block. Prefix includes initialization and polling. Held-head owner work is 72 recovery plus 72 retained-checkpoint calls; API starts zero operations. Descriptor visits repeat the same successfully validated cardinality in nested load/validation scopes; never add them.

| Role / start phase | Load inclusive ns | Nested synchronous validation ns |
| --- | ---: | ---: |
| projection / prefix | 157663517221 | 100469078921 |
| projection / held-head | 13919562990 | 4964218925 |
| projection / verification | 20082397413 | 7235484366 |
| api / prefix | 987658058 | 929202835 |
| api / verification | 922284843 | 865695746 |

These elapsed spans overlap; they are not process CPU. Owner exit sample records 326.599166s process CPU over 388.686084642s observer elapsed, maxRSS 522624 KiB. First source release to stable is351.375s; the fixed-head wait is10001.750445ms.

Both physical/HTTP stages contain three unchanged empty projections at checkpoint 288, paired revisions, correct finality/count headers, undo 256 / floor 32 and intact receipt/predecessor chains. All 288 source frames and raw broker deliveries are acknowledged, all queues drain;1,484 before/after source hash receipts agree. Captured cleanup succeeds; after both pilots all 7 protected PID/startTicks pairs, runtime/plan hashes remain unchanged, with zero containers/scopes left.

The separate retained emission archive `1b5c31062319386fc981d184f7904a0a9f9b7276bb76d166e737d9c15e3275e6` was captured after both pilots. All 612 payload files/4,563,569 bytes independently match the unchanged pre-run 607-file manifest plus 5 pre-pilot kernel witnesses. This does not archive entire dependency trees or runtime binaries.

Counter-off control archive `a5cf1466dacc3b96cb94784d63151d1da853936e38fb84aefd4c21435335cb05` passes the same captured stages/source/broker/cleanup subset with identical runtime, inputs, plan, oracles and all 513 profile pins; observer output and CPU profiles are absent. Its first-release-to-stable duration is360.694s. One pair does not estimate overhead, improvement or capacity. Synthetic empty-table prefix results do not qualify full recovery/finality or live Wire consensus.
