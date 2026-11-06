# Bounded canonical JSON ASCII accounting

Scoped component work for [#368](https://github.com/eosrio/hyperion-history-api/issues/368),
based on `d08b4127fe434a8fb408e149b23d8fa9b6206abe`. The original full Wire/MongoDB
profile1 failed the unchanged cursor813 check at804. Its stage and CPU evidence identified
canonical JSON processing as a significant DS cost. This report does not close that replay gate.

The helper still validates well-formed UTF-16, counts quotes, checks all descriptors/prototypes,
and enforces the original byte/node/depth and number policies. It refuses the minimum string
size before a scan or encoded allocation. Printable ASCII without quotes/backslashes is counted
by length; the original general string loop and native JSON encoder remain unchanged.
There is no cached source/authority result or skipped storage/ownership/durability check.

## Actual inputs and comparison

The existing guarded `tests/fixtures/portable-state-worker/prepare.py` verified the original
archive `42d092f3ecf6f428ecdba4825580377acdd27f2818ce445d4f197719e6ab72b7`
and all1488 members before extraction. The benchmark independently checks the selected member
hashes against its pinned manifest. Frame803 is12429bytes/24858hex characters;805 is20899bytes/
41798hex characters. Retained-field JSON subsets use those exact frameHex and schemaJson bytes;
they are pure serializer workloads, not fabricated proof or valid whole admission records.
The parsed captured SHIP ABI and a mixed Unicode/control case cover additional string shapes.

Each native runtime compares the original normally emitted function with the candidate emitted
function in the same process. Original-vs-original controls precede the candidate comparison.
Setup/correctness/warmup are separate:64 warmup calls, then five ABBA rounds,1024calls per batch,
ten batch observations per variant/input. Intrinsic work counters run only AFTER all timed batches;
the original41798 character visits for frame805 become0, with the original native encoder still
called once. An impossible lower bound invokes neither regex nor encoded allocation.

These are p50 batch-normalized wall microseconds/call, not individual-request latency percentiles:

| Node | Input | Original | Candidate | Original/candidate |
|---|---|---:|---:|---:|
| 24 | retained-frame803 | 168.883 | 133.958 | 1.261x |
| 24 | retained-frame805 | 207.674 | 154.098 | 1.348x |
| 24 | captured-ship-abi | 686.486 | 680.564 | 1.009x |
| 24 | mixed-unicode-controls | 2.753 | 2.785 | 0.988x |
| 26 | retained-frame803 | 166.460 | 124.184 | 1.340x |
| 26 | retained-frame805 | 207.407 | 135.991 | 1.525x |
| 26 | captured-ship-abi | 618.925 | 607.382 | 1.019x |
| 26 | mixed-unicode-controls | 2.546 | 2.464 | 1.033x |

The retained-field subsets improve in these finite comparisons; the parsed ABI is roughly
unchanged. The tiny mixed case varies by runtime and its CPU counter quantizes to zero.
Original-vs-original p50 wall ratios were about0.9996–1.0051. CPU/wall distributions, raw batch
rows, RSS/heap boundaries, exact outputs/UTF8 hashes, runtime binaries and provenance are in
[the evidence record](evidence/bounded-json-ascii-20261027.json).
No full-worker or Linux speedup follows from a shared Windows warm component experiment.

## Correctness and reproduction

Nine native tests pass on Node24.19.0 and26.4.0 before and after the change. They check every
well-formed single UTF16 code unit against independent native JSON encoding and UTF8 byte lengths,
plus ASCII keys/values, escapes/final newlines, surrogate pairs/malformed input, refusal order,
getters/toJSON, symbols/prototypes/sparse arrays/cycles, node/depth limits and number policies.
The focused Bun1.4.4 suite passes134tests/706 Bun expect calls. Whole project262-file and qualification
typechecks plus normal builds on both native majors pass; npm locks and dependency pins are unchanged.

For a new comparison, save the original emitted helper from a normal baseline build, build the
candidate normally, prepare the existing fixture into a NEW output directory, then run each
explicit Node24/26 binary with:

```text
node scripts/qualification/bounded-json-ascii.mjs --baseline /path/to/baseline/bounded-json.mjs --candidate /path/to/candidate/build/indexer/helpers/bounded-json.js --source /path/to/prepared/source --output /new/report.json --major 24
```

Use major26 with its actual binary. NODE_OPTIONS/NODE_PATH must be empty, and the output must
be new. The runner imports the real functions, validates exact output/hash and one-byte-under
refusal against an independent UTF8 oracle, and sets no performance pass threshold or delays.
Initial valid short batches and the excluded counter-before-warmup pilot remain retained in
the qualification delivery; the machine record identifies them explicitly. Functional equivalence
is a passing control, not a manufactured performance RED. Independent review and the full original
1..1480 replay with all fault/durability/fork/isolation oracles remain required.
