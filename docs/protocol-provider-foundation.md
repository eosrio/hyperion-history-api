# Protocol provider foundation

This is engineering implementation for [#212](https://github.com/eosrio/hyperion-history-api/issues/212),
not completed Wire testnet support. Canonical ABI coverage and action epochs remain a mandatory
continuation in [#213](https://github.com/eosrio/hyperion-history-api/issues/213). Rust consumer work
and its remaining paths are tracked in [tools #41](https://github.com/eosrio/hyperion-tools/issues/41).

## Selection and installation

Omitting `settings.protocol` preserves the Antelope provider. Wire is an explicit per-chain
engineering selection after installing the exact development dependencies in the npm lockfile:

```json
{
  "settings": {
    "protocol": {
      "provider": "extension",
      "package": "@eosrio/hyperion-wire-plugin",
      "profileId": "wire-sysio-7dede884-engineering-v1"
    }
  }
}
```

The package also declares `wire-sysio-6508c9e8-engineering-v1`. Neither source-pinned engineering
profile selects the final launch node/contracts/genesis. Use `npm ci` with the committed lockfile;
dependency preparation must run so the SDK and protocol package emit their artifacts. On npm
versions that disable Git dependencies by default, `--allow-git=all` is a command-scoped development
override for these explicit immutable pins. It is not an executable update mechanism.

The host reads the inert SDK descriptor and verifies both Node/Rust artifact manifests, every
listed file, executable entry coverage, exact profile/component pins and host/SDK compatibility
before importing the provider factory or native addon. Modified-source artifacts fail activation.
The bundled Rust member is source-only engineering evidence; validating its presence is not
qualification of an installed Rust executable or the final operator distribution.

Each worker selects its provider before constructing binary SHiP requests or decoding affected
input. SHiP sessions own their advertised schemas and lifecycle. Default Antelope retains the
existing native engine through private context aliases; session replacement and preflight cleanup
release their aliases. Executable provider/profile changes require a controlled restart. A rejected
live provider change restores the current configuration and filters. Declarative mapping reload
remains a separate release requirement.

## Implemented paths

- Provider-owned request/result, block, trace, delta and row codecs, including the selected Wire
  timestamp epoch. Request fetch flags follow the advertised request structure; a Wire v1 request
  uses `fetch_finality_data` rather than a legacy block-header flag.
- Every required stream reaches the selected codec before downstream handler selection. Unknown
  streams, including empty streams, fail explicitly. The Wire package declares reasons for known
  streams with no current host projection.
- Primary and secondary KV records preserve complete keys, payer, presence, raw bytes, numeric
  table/index mapping and source identity. A same-source-block/fork account ABI can decode that
  block's final KV state. Updates and deletes use the existing ordered MongoDB and ES delivery paths.
- Every observed Wire account ABI update is retained as a deployment marker, including cleared,
  malformed or unsupported ABI bytes. An unavailable deployment invalidates older contexts and
  remains a barrier to stale selection. Contract failures continue to be isolated.
- New history/state records use the bounded [physical ID policy](protocol-physical-ids.md).
  Existing Antelope IDs, history representations and default behavior remain compatible.

These paths build on existing workers, queues and RabbitMQ. The portable SDK does not expose
native library classes or database operations. The foundation does not replace the shared
projection runtime, backend adapter contracts or domain plugin acceptance requirements.

## ABI safety boundary

A latest Elasticsearch ABI hit does not prove that the ABI applies: queued writes, refresh and
parallel workers can hide a newer deployment. A same-sized schema change can decode successfully
with the wrong field names. Receipt ABI sequences also require source/epoch interpretation,
including changes during an action's execution.

Until #213 supplies canonical coverage and trace-epoch binding, automatic Wire action decoding
retains raw data with `ds_error`; it does not use a latest/current/head ABI. Requests that need
Wire action hex reconstruction return retryable unavailable rather than guessing. Ordinary
retained-history reads remain available. Historical KV lookup similarly refuses an unproved
indexed ABI; only the same-source-block/fork account ABI supplies final-state KV context here.

Missing/invalid contract context produces an error notification containing raw row and source
information while unrelated contracts continue. A durable canonical ABI journal, coverage
frontier, quarantine/recovery readiness and serving gates still need qualification. Do not treat
an IPC error notification or successful isolated fixture as completed recovery or serving safety.

Upgrades preserve existing ES history without a mandatory full reindex. New ABI/protocol fields
are additive. Ensure active target mappings and future templates contain the new disabled
protocol metadata fields before an engineering Wire activation. Initialize or rebuild new state
and ABI coverage projections separately under the accepted recovery contract.

## Validation and limits

The protocol tests execute emitted Node code and actual production methods. They use the
source-pinned captured SHiP frame plus an explicitly synthetic nonempty receipt fixture; the
captured block has no user transactions. The synthetic block is serialization evidence with
unvalidated consensus IDs/roots/signatures, not a deployed-contract or executed-chain capture.

Fixtures cover selection before addon import, artifact/profile rejection, independent native
contexts and cleanup, ABI transitions/barriers, complete primary/secondary writes/deletes, long
physical keys, durable delivery settlement, root-only whitelist behavior, v1 requests and raw
fallbacks. ES, MongoDB and broker services are test doubles in these production-method probes.
The HTTP route tests run the actual route and forbid legacy addon imports for Wire. This is not
a full-service or live-cluster qualification run.

`scripts/qualification/protocol-antelope-overhead.mjs` records a bounded ABI-correct direct-native
versus private-alias observation under Node 24, with alternating warmed trials and resource
samples, retained in the [adapter observation](performance/protocol-native-adapter.md).
Its shared-workstation observations have no performance acceptance threshold and do not
establish full-stack throughput, Bun runtime support or component profiling completion.

The remaining release gates include canonical ABI coverage/action epochs, historical Wire
consumers, full-service durable recovery and fork exercises, the selected new testnet and the
coordinated operator distribution. Passing these engineering checks does not waive those gates.
