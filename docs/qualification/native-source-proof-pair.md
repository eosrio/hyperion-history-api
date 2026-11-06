# Worker-local canonical/native source opening

This is the bounded implementation experiment for [#360](https://github.com/eosrio/hyperion-history-api/issues/360).
It targets duplicate certificate/ancestry walks in the actual DS callback. It does not close the
full Wire/MongoDB replay, capacity, fork/serving or release gates in #277 and #191.

## Authority and lifetime

The worker-only `ProtocolNativeActionReader.forWorker` factory constructs the unchanged native
reader, including its independent `asReadOnly()` ABI issuer. DS uses that actual issuer for both
native and contract operations. A joint `waitForOpen` performs one fresh canonical opening and
the existing native retained-source, original-byte replay, entire occurrence/decision inventory
and membership checks. It returns the two existing owned handles only after final scope,
signal and current canonical authority validation. No old-view adoption, view getter or
source/selection cache is added.

The final handoff also checks the **current** head against the original configured opening window.
Ordinary consumption may survive monotone head progress; that does not authorize a new opening
at distance 257 under the default 256 bound. A source opening at distance 256 which advances to 257
during native verification is refused. Owner/generation/fork revocation remains fail-closed.
The final read remains inside the native reader's existing maximum of eight active openings.
The ABI reader's physical-read budget, operation tracking, cancellation and drainage are retained.

Standalone/API native constructors still create independent read-only issuers and keep their
existing opening/consumption semantics. Non-native worker paths, original publication checks,
confirmed handoffs, queue/prefetch/credit budgets and source ACK paths are unchanged.

## Component controls

`tests/unit/protocol-native-consumer-worker.mjs --measure-proof-pair` runs the original captured
Wire prefix through block 397 using emitted reader/parser/DS/admission code. It retains original
native values at 33/122/397, raw-incomplete tamper handling, exact persistent/mandatory publication
bytes, journal membership, cache/stream equality and final-confirm owner revocation without ACK.
The archive remains pinned to SHA256
`42d092f3ecf6f428ecdba4825580377acdd27f2818ce445d4f197719e6ab72b7`.

The opt-in bridge forwards measured document reads through the pinned Elasticsearch client and
an owned loopback HTTP socket to the existing controlled immutable/CAS fixture. It records logical
requests, actual HTTP attempts, document identities and response-body bytes. Metadata reads use
the existing controlled transport and are counted separately. These are not real Elasticsearch
server measurements, durability tests or full-service results.

On native Node 24.19.0 and 26.4.0, the unchanged production baseline passed all business controls
with two openings. Requiring one opening then failed on both, after those controls passed.
The paired path passes with one opening. At the three stable source heads, each callback has:

| Observation | Baseline | Paired |
| --- | ---: | ---: |
| Certificate manifests | 2 | 1 |
| Commit manifests (source equals head) | 2 | 1 |
| Logical document reads / actual HTTP attempts | 187 / 187 | 182 / 182 |
| Controlled metadata reads | 298 | 288 |

The original native verification and required consumption/publication authority checks remain;
the pair adds a final new-opening bound check. Fewer GETs here do not establish production CPU,
latency or throughput gains, nor identify the cause of a failed full replay. Nested stage times
must not be added as independent elapsed time. Lagged production profiling remains separate.

`tests/unit/protocol-native-worker-pair.mjs` runs under native Node 24/26. It exercises copies,
foreign readers and scopes, replacement attempts, changed source/selection, real coordinator
owner/fork/revoke transitions, whole-source/native-byte mismatches, the 256→257 handoff, and eight
held final openings. It enumerates every actual read/metadata callback in a successful opening;
each position is independently held for caller cancellation, scope fencing with late success,
and scope fencing with late rejection. A real physical callback must settle before its scope
gets an authentic drained end. The existing queued-Wire256/257 and mixed native/contract worker
fixtures remain independent controls.

Run normal emission first, then the focused wrapper with the selected native Node executable:

```sh
npm run typecheck
npm run build
bun check -p scripts/qualification/tsconfig.json
HYPERION_NATIVE_NODE=node bun test ./tests/unit/protocol-native-worker-pair.test.ts
```

Implementation checks do not select or activate a production optimization. The unchanged full
real-service replay and physical-worker stage/resource comparison remain required before any
qualification or release claim.
