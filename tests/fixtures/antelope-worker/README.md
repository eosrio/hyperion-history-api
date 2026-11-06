# Constructed Antelope worker source

This fixture qualifies the builtin Antelope codec and original emitted callbacks under
History API #321. It is a deterministic engineering input, not a live-chain capture or
a consensus-valid signed block. It does not establish reversible state, capacity,
complete history replay, or release support.

The handshake is the JSON literal from
[Leap v5.0.3 libraries/state_history/abi.cpp](https://github.com/AntelopeIO/leap/blob/d133c6413ce8ce2e96096a0513ec25b4a8dbe837/libraries/state_history/abi.cpp),
commit `d133c6413ce8ce2e96096a0513ec25b4a8dbe837`,
Git blob `d778d0c7fc40c96a070b860400f9d9244f1cba1b`.
The literal is extracted without modifying its definitions and saved with one terminal
newline. Its checksum is in source.json. Upstream licensing is retained in LICENSE.leap.

generate.mjs writes source binary fields independently of the codecs under test. The
block uses the standard header layout and a zero K1 signature with valid ABI encoding;
that signature is deliberately unsuitable for consensus verification. Trace, receipt,
transaction, parent, producer and ordinal inputs are explicit. Separate frames preserve
the distinction between encoded-empty traces and unavailable traces. The counter contract
has an explicitly constructed deployment at block 7 / ABI sequence 3; a controlled
historical ABI search returns those exact bytes. The input and expected uint64 values
are specified independently of the worker's inventory derivation.

After a normal npm installation and build, regeneration is explicit:

~~~sh
node tests/fixtures/antelope-worker/generate.mjs
~~~

Tests read the committed bytes rather than regenerating them. The generator, handshake,
contract ABI and frames have checksums. Native runs additionally report the actual Node
executable, producer revision/configuration, emitted dependency/artifact digest, fixture
and worker-source digests. The independent expected action checks include contract data,
authorization, exact sequence strings, ABI/code counters, return value, transaction and
block identity.

The emitted reader verifies the chain through an ABI-correct status response and retains
original ingress before MainDS. The selected MainDS or DS callback uses native parent/worker
IPC and its real managed lifecycle. The other callback stages and external ES/RabbitMQ/
cache/RPC transports are explicitly controlled. Production retained stores and their
two-copy write receipts, native contract ABI loading, original semantic membership,
fresh-result validators and actual master adjudicator remain active.

The handoff counterexamples reject stale configuration, target UUID and canonical block
identity, including configuration replacement during an awaited target read. A reversible
RPC observation without an admitted source selection remains unresolved. This conservative
result is a coverage boundary, not completed Antelope reversible-source support. The full
master/coordinator source-revocation and pending-worker cases remain owned by #321.

The three modes are handoff, empty and missing. Broker settlement remains unknown even
after a private source-checked association. No reader credit, capacity grant, public
activation, worker architecture or release qualification follows from these cases.
