# Bounded retained-string encoding experiment

This source successor changes primitive JSON string encoding reuse only. It does
not cache objects, metadata, reads, source proofs or authority. Up to eight escaped
strings are retained, with a conservative 512 KiB total UTF-16 allocation bound
and a 64 KiB encoded-entry cutoff. Retained strings are decoded from owned bounded
bytes so a sliced or rope input cannot retain a larger parent string. The 512 KiB
figure covers string payloads; metadata cardinality is capped at eight records
and VM bookkeeping bytes are not measured. Every use debits its complete encoded byte
count against the current caller's budget; visitor node/depth, accessors, cycles,
number policy and all native/source checks still execute.

Actual full Build `41894246103` at PR head `cb53a837`, executed merge source
`218d6b3469fc1f92f46ebcdee915967f3c36c54a`, tree `ae00701f`, failed the original
180-second retained Wire deadline on Node 24 at block 1127. Its callback returned
at 232.085 seconds after abort. Node 26 passed that step at 163.798 seconds before
later matrix cancellation. The original failed verdict is retained. Native and
finite workflows passed both majors, independently of the full-build failure.

Offline attribution of the actual failed Node 24 CPU profile assigns 46.434
sampled seconds to canonical JSON inclusive, 18.736 to string encoding self,
22.651 to string encoding inclusive and 23.399 to visitor self. The string scope
is an upper bound: samples do not identify which arguments are long escaped
strings. Visitor self includes object descriptors, validation, sorting and
assembly, which this experiment does not cache. No full-workload benefit follows
from these figures.

A pure Windows encoding control repeated the actual 32,580-byte Wire schema
context 3,000 times. Exact output equality held; three observations were
294.6–304.6 ms before and 9.9–12.5 ms with reuse. This measures only encoding of
that repeated input. It is not a Linux/native fixture or an end-to-end speedup.
Focused controls additionally cover later smaller byte budgets, nested wrapper
bytes, Unicode/control escapes, malformed UTF-16 error order, mutable objects,
numeric policy, accessor/cycle refusal and cache eviction/retention bounds.

The current source/emission closure records this explicit source delta from
`cb53a837`; historical SDK49 sources and their predicates remain frozen. The
original retained 1..1480 workload, 180-second deadline, CPU sampling and all
assertions are unchanged. Fresh genuine Linux CI is required before this source
can establish any retained-workload result. Full AtomicAssets/AtomicMarket parity
and managed-host qualification remain separate.

## Cold-input correction

The original ca781f10 experiment also measured substantial adverse costs: 1,000
unique schema strings took 1,702.3 ms versus 101.6 ms before caching, and 32-way
churn took 2,376.7 ms versus 115.5 ms. A 65,535-code-unit string that could never
fit a 65,536-byte encoded entry still performed one cache lookup before a small
caller budget refused it. These outcomes remain recorded; the warm measurement
alone did not describe cache costs.

This successor bypasses hashing and cache lookup when length, UTF-8 size or the
caller's remaining minimum-byte bound proves ineligibility. Eligible strings use
a fixed-size SHA-256 lookup key. Exact original-string equality is still required
before reuse, including under deliberately colliding digest controls. A first
complete encoding retains only the digest; another complete encoding promotes
the entry to owned input/encoded strings. All pending/promoted entries share the
same eight-record and 512 KiB string-payload limits, including digest bytes.

Three pure Windows observations alternate measurement order. For 1,000 calls,
warm schema encoding took 17.1–18.6 ms versus 123.5–180.5 ms without caching.
Unique cold input took 163.4–229.5 ms versus 151.8–198.2 ms (about 6–18% overhead);
32-way churn took 210.5–237.6 ms versus 174.6–221.5 ms (about 7–21% overhead).
These are encoding-only observations, not Linux end-to-end qualification. The
oversized/refused control proves zero hashing and zero cache probes; small timing
samples are not used as a performance assertion. Original failed CI outcomes and
the unchanged 180-second workload deadline remain authoritative.
