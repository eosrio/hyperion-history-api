# Composed Wire replay source candidate

This engineering-only source assembly combines the reviewed final-query observer and bounded
canonical string cache (#435), immutable chunk bulk transport (#436), and resumable historical
ABI activation (#437). Its explicit profile is
`stateful-owner-v2-7412889-e691f44-replay-bulk-history-v1-engineering`.
The adjacent source manifest binds the runtime input files and exact emitted caller inventory.
Existing Wire69, Wire32, string-cache, genesis, individual-batch and bulk profiles keep their pins;
they refuse this changed source instead of being silently relabeled.

The runtime source merge is `2a5cbe117577412f5eb8b7995b34d1411901cc30`.
SDK741, Wiree691 and both committed npm lockfiles remain unchanged. This does not include the
separate all-CBFB Atomic shipping proposal. Root installation uses the existing supported steps;
no CI-only duplicate SDK layout or dependency upgrade is introduced here.

The workload remains the original blocks1..1480,900-second replay,60-second phases,
90-second cleanup,300-second build and180-second managed deadline. Full current-tree source
admission, a fresh guarded Linux build and real MongoDB/Elasticsearch replay must precede runtime
acceptance. Component controls do not establish final-query completion, physical durability,
historical activation/recovery, full testnet sync, Atomic API parity or public deployment.

The frozen `wire119-final-observer-source-v1` file remains an observation-source record; its
production-emission selector describes its own predecessor. A composed run uses the new profile
and complete source input inventory, never that predecessor selector as current authority.
