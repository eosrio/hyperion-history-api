# Signed native CPU profile fixture

The compressed base64 holds one exact, source-pinned Node 24.19.0 profile from
the failed `h252-n24-mon-con-r1` engineering comparison. Its sample/delta pair at
index 45 steps backwards by four microseconds. `origin.json` identifies the
original archive, member, failed report and packed/unpacked hashes.

The regression checks post-capture handling without starting services or
repeating a workload. Samples and signed deltas remain unchanged. Unavailable
interval weights are distinct from raw sampled-stack frequency and independent
process CPU. The original run remains failed, and this fixture does not qualify
the full comparison or recovery matrix. See the
[pinned upstream research](../../../docs/performance/v8-profile-timestamps.md).
