# Worker end-association observations

This is an evidence slice of [#332](https://github.com/eosrio/hyperion-history-api/issues/332),
following the corrected Node 24 capture at `29057aaa`. Its projection operation's
`ProofConsumerFencedError` differs from the final run rejection, `Invalid worker attempt end
association`. The original end request/reply and validator operands were not retained. Matching
fence-time and final description digests are different boundaries and do not identify a failed
validator field. That historical failure and its unknown cause remain unchanged.

The guarded native observer now installs `worker-end-diagnostics.mjs` through the existing
rejection observer. It wraps the original synchronous supervisor `handle` and `reply` methods,
without changing their arguments, return values, synchronous throws, validation or end issuance.
No production worker method, transport, deadline, source, durability or activation default changes.

## Boundaries and limits

Rows bind the original request ID, attempt ID, physical child description and parent
epoch/incarnation. They retain the received association operands, the current entry's descriptor
and binding digests, and the original reply input. Client/challenge credentials are omitted;
unexpected summary keys remain visible while their values are redacted. These are allowlisted
operand views, not raw IPC frames or capabilities.

Only a boolean acknowledgement flag and the `returned`/`threw` root-result values survive
summary capture. Malformed recognized values and non-object summaries retain a redacted type
description, so an issued credential inside an invalid array, string or nested value is excluded.

The first eight normal ends are sampled. Later normal ends have an explicit omission count and
perform no operand copying or digest work. Up to 128 failed ends remain eligible independently
of that success window. Normal sampled operands are copied at original handle entry. A later
failed association is copied before its original synchronous error reply: the original guard
has no await and changes no end entry before this failure. The row records its boundary.
The supported inputs are serialized plain IPC objects; the observer never invokes getters,
proxies or `toJSON` to capture metadata.

The comparison vector describes mismatching captured operands, not new validation authority.
It does not claim every original short-circuited clause ran. Original replies still govern the
method result. A reply input says nothing about delivery, client receipt, broker settlement,
source authority or semantic completion. An unknown client return remains unknown even when
the parent constructed a successful end reply.

Captures allow 32 nested original calls, 2,048 metadata nodes, depth 16 and 16 KiB strings,
inside the existing 64 KiB row and 24 MiB process budgets. Failed capture, missing parent hooks,
failure omissions, changed bounds or disagreement between records and summary counts fails
the diagnostic audit independently of raw software shutdown. Sink failures cannot replace an
original result/error. Older captures do not acquire this coverage retroactively.
Every end-record PID enters this census, including records without a start or summary; missing
coverage stays incomplete, and invalid process IDs fail the audit.

## Controls

```sh
npm ci --allow-git=all
npm run typecheck
npm run build
node tests/unit/worker-end-association.mjs invalid-binding
bun test tests/unit/worker-end-association.test.ts tests/unit/worker-rejection-provenance.test.ts
```

Select native Node 24 and 26 through `HYPERION_NATIVE_NODE` when using the Bun wrapper. A single
issued attempt, original managed IPC and the real supervisor/client reproduce the actual error
class with a deliberately altered end field. The old observer fails the missing-record assertion
in under two seconds. This controlled alteration does not identify the production cause.

The controls cover binding/descriptor/operation/summary mismatches, a failure after the success
window, a normal end, a lost reply, copy mutation and sink failure. Direct original-supervisor
controls additionally preserve getters, arguments, returns and synchronous errors, with explicit
capture/budget failures. They have no service, source-proof or full-worker qualification authority.
A new owned service capture must still retain the actual failing operands before #332 can close.
