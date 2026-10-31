# Portable mapping retry eligibility engineering control

Issue: [#403](https://github.com/eosrio/hyperion-history-api/issues/403).
This is a source/component experiment. The production controller option defaults to **0 ms**;
the worker does not select the experimental policy. Root still owns policy selection and the
original physical Wire/MongoDB replay. Existing profiles, dependencies, source window, eight-frame
drain budget, worker 100 ms schedule and physical deadlines are unchanged.

The actual declarative mapping result can issue a private rejection only after its exact failure
target was successfully marked and its original proof-consumer scope remains active. The signal
belongs to that runtime, process promise, original error and scope. Error messages, codes, copied
errors and caller flags cannot select eligibility. Uncertain marking, source/ABI/proof/application
failures and fences retain immediate recovery. Cancellation after marking preserves the original
mapping error.

`mappingRetryEligibilityMs` accepts integers 0..1000 at the internal controller constructor. An
eligible pause keeps only a deadline and a 64-character digest of at most 32 KiB of exact fresh
recovery data, with at most one record per fixed projection. Every drain still reads recovery and
binds its fresh attempt before considering a pause. Changed binding/checkpoint/pending/gap,
unavailable recovery, lifecycle invalidation or stop discards it. Existing worker owner/fork/config
notifications clear timing, including an in-flight marker's old epoch. Due attempts execute the
original full source selection, canonical/ABI, owner and proof checks. A pause emits no progress,
checkpoint, ACK, readiness or serving grant. An already-held operation still needs to settle.

The regression first failed against unchanged 6021 emitted controller/runtime: the failed target
was prepared six times rather than two under a fixed controlled monotonic schedule. Both healthy
lanes still finished 48 frames through 1291; the invalid checkpoint remained 1243 and target 1244.
The fixture verifies original retained Wire frame hashes, its on-chain ABI deployment and official
row oracle. Source/proof and adapter ports are controlled; those checks do not qualify physical
backend durability or live source authority.

Native Node 24.22.1 and 26.4.0 also ran five alternating default 0/1000 ms pairs on the same independent
wall-clock offered arrivals 0/100/200/300/400/1100/2100 ms. Each of the ten pairs recorded:

| Observation per pair | Default 0 | Experimental 1000 |
|---|---:|---:|
| Invalid target preparations/failure markers | 7 | 2 |
| Total source preparations/admissions | 119 | 114 |
| Proof-port revalidations | 231 | 226 |
| Fresh recovery reads | 126 | 121 |
| Healthy applications | 112 | 112 |
| Actual scoped attempts | 119 | 119 |

All ten pairs observed an actual due retry at least 1000 ms after the previous successful failure
marker. Healthy checkpoints reached 1299, with the invalid checkpoint 1243/pending 1244 unchanged.
The separate controlled-clock regression verifies the due path with fresh source/proof and attempt
bindings. The earlier six-arrival samples remain retained: expiry placement produced one or two
invalid preparations in the short window, rather than always exercising a due retry.

The later-arrival window medians were 2266.06/2262.29 ms on Node 24 and 2230.22/2227.14 ms on Node 26
(default/experimental). These are paced, controlled component windows with up to 479.68 ms arrival
lateness. They show reduced repeated preparation, **not a meaningful elapsed or integrated gain**.
CPU samples, allocation/GC, OS/native I/O and physical ES/Mongo/HTTP attribution remain unmeasured.
The failed r80 physical workload and earlier failed receipts retain their original outcomes.

Reproduce after normal locked installation and artifact emission:

```sh
node --test tests/unit/portable-mapping-retry-native.mjs
node scripts/qualification/portable-mapping-retry.mjs
node scripts/qualification/portable-mapping-retry.mjs --with-due-arrival
```

The scripts use only owned temporary fixture directories and normal child completion. The native
controls cover interval bounds, uncertain writes, foreign/stale errors, recovery changes, actual
worker lifecycle handlers, held operations and stop. Bun controls additionally exercise the actual
MongoDB adapter and Fastify affected-query behavior through controlled transport ports: 503 remains
retryable while paused; fresh application is required before 200 serving resumes. Raw receipts,
input/emission inventories, all failed pilots and all paired samples accompany the formal patch.
