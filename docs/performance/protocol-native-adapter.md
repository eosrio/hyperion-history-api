# Antelope private ABI alias observation

The provider foundation adds a private ABI-name lookup around the existing native
decoder. This bounded local observation checks the added path with equivalent
decoded output. It does not qualify the worker runtime or establish a production
bottleneck, capacity, leak bound or optimization benefit.

[The retained report](evidence/protocol-adapter-20261019/observation.json) was
collected on 2026-10-19 with Node 24.19.0, V8 13.6.233.17-node.51, Windows x64,
an AMD Ryzen 9 9950X3D (32 logical CPUs) and `@eosrio/node-abieos`
4.2.0-f7d5b45. It retains executable/native-binary hashes, the pre-commit source
HEAD and tracked-diff digest, and hashes of the actual adapter source, emitted
JavaScript, script, package manifest and npm lockfile. Artifacts were emitted by
TypeScript 7.0.2 after a clean locked dependency install.

The ABI-correct fixture includes a precision-sensitive uint64, name, asset and
string. Both methods decode the same native-encoded bytes and must exactly match
the expected object before and after every trial. After 5,000 warmups per method,
five alternating pairs run 20,000 decodes per method. Every decoded output
contributes to a checked accumulator. Timings include the native call, JSON
parsing, accumulator and, for the adapter, its alias lookup.

| Method | Trial count | Decodes | Observed ns/decode range | Mean ns/decode |
|---|---:|---:|---:|---:|
| Direct native facade | 5 | 100,000 | 1,520.86–1,682.98 | 1,570.55 |
| Private ABI alias facade | 5 | 100,000 | 1,519.16–1,563.51 | 1,540.43 |

The ranges overlap. Shared-host scheduling, JIT/GC variation and short trials
prevent attribution of their small difference; no performance pass threshold or
speedup claim is assigned. Each trial retains process CPU deltas and before/after
RSS, heap, external and array-buffer snapshots. Windows CPU-accounting granularity
is coarse at this duration. These are resource observations, not sampled CPU or
allocation profiles; snapshot changes cannot establish leak freedom. Host
frequency, unrelated workload, event-loop delay and system I/O were not controlled
or sampled. No services or end-to-end queues are exercised.

To reproduce after the canonical install and native TypeScript build:

```sh
node scripts/qualification/protocol-antelope-overhead.mjs observation.json
```

The script requires the Node 24 control runtime and does not run in CI as a timing
threshold. CI checks the retained report checksum. Session/provider isolation,
failed ABI replacement and repeated session close are separate correctness
regressions in `protocol-provider.test.ts`. Representative guarded replay,
sampling/allocation profiles and Linux qualification remain separate work.
