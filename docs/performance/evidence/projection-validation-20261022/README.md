# Projection validation evidence: 2026-10-22

Measurement plumbing for [#252](https://github.com/eosrio/hyperion-history-api/issues/252),
captured from HAPI `d95d797fc3de8c695e2817a2952eedebeb4b3241`.
This package contains four native Linux Node 22.23.3/24.19.0 kernel count/timing reports
and one sequential Node 24 worker pilot pair: measurement on/off, CPU sampling off.
The three selected tables are empty through block 288; undo has 256 descriptors and
coverage floor 32. These captures qualify the harness plumbing only.

Five fresh runs per four measurement/CPU conditions (20 total) remain **pending** and
are outside this package. The pilot pair is excluded from that comparison. One pair
cannot estimate overhead, rank runtimes, establish capacity or justify an optimization.
Full [#246](https://github.com/eosrio/hyperion-history-api/issues/246) recovery/finality,
populated-table cost, live Wire consensus and release qualification remain open.

## Verify without private paths, source archives or services

Use ordinary Python 3.11+ with only its standard library. Choose a fresh output
directory whose parent exists. Do not use Python `-O`:

```sh
python reproduce/verify-public.py . /existing/parent/new-252-audit
```

This checks the complete `SHA256SUMS`, regular-only archive inventories, retained
source-member hashes, declared report omissions, and byte-identical deterministic
raw-archive reconstruction. Nested fixture bytes are authenticated before decoding
or expansion, and gzip output is bounded to the expected size plus one under a
256 KiB ceiling. Eight regression controls run before the three audit adaptations:

- Kernel fixture/negative-input hashes, independent JSON-subset BSON reconstruction,
  all raw named coverage counters and calibrations, one/three-call scaling, missing
  counters, timing/CPU arithmetic and clipped/unioned GC intervals.
- Actual worker PID/parent and phase ACK ownership, all 33,116 span/counter records,
  loaded-metadata cardinalities, physical/API state and revision/finality/undo oracles,
  source/broker acknowledgments and captured cleanup.
- The exact 612 retained payload files, the control pilot's matching code/input/runtime
  receipts and empty observer output, and all seven protected PID/startTicks plus
  runtime/plan identities before/after the pilots.

The audits never extract archive paths, invoke Git, reexecute a validator, start a
service or rerun a performance workload. Outputs go only to the new directory.
Individual verifiers accept the same package/output arguments. `reproduce/build-public-evidence.py`
is a custodian derivation recipe requiring the original private inputs and original
audit sources; public verification does not require those inputs.

## Contents and provenance

`raw-evidence.tar.gz` contains `cases/CASE/`: exact projection observer JSONs,
resource/process observer JSONL, bulk requests/responses, both physical/API stages,
source/broker/progress and cleanup receipts. `report.json` keeps that name and retains
its diagnostic paths, while seven configuration/environment JSON pointers are omitted.
Each omission has a canonical-value size/hash; the report carries its original member
identity and hash. Resource/process member suffixes stay unchanged. One known relative
error-log symlink per original archive is inventoried and skipped, never followed.

`manifest.json` lists every original pilot member, its action, all retained member
hashes, and script adaptation receipts. Disposable credential-bearing service state,
configuration, container inspections and human/service logs are omitted. No original
full private pilot archive is published. Their whole-archive and omitted member/value
hashes are captured provenance receipts: a reader can rehash all retained original
bytes and inspect derivations, but cannot reconstruct a secret-containing original
archive from this package.

`retained-emission.tar.gz` is byte-identical to the separately retained archive:
607 unchanged pre-run pinned files plus five pre-pilot kernel code/library witnesses,
612 payload files in total. It was captured **after both pilots**, then byte-checked
against those earlier receipts. `source-witnesses/` separately retains two exact TS
Git blobs retrieved later and matching the pre-pilot kernel source receipts. Full
dependency trees, native runtime binaries, the original 1,484 source files and the
historical kernel-origin archives are outside this package; their captured identities
remain explicit. Public audits verify the retained fixture/code, rather than claiming
to rehash unavailable historical archives.

`audits/` preserves the independent audits unchanged. The original worker audit's
`emissionInventory` notes payload verification as pending at that point. Its later
`emission-control-original.json` supersedes that limitation with the 612-file check;
the chronological original is deliberately preserved. `summary.json` holds the pilot
scope and phase-start tables. Raw counts, overlapping elapsed spans, descriptor visits,
sample weights and process CPU have distinct units; nested load/validation scopes
must not be added. The kernel's forward/reverse timing passes share process/heap
history and are not independent repetitions or production performance evidence.
