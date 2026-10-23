# Partial Wire worker replay for #288 — 2026-10-23

This is failure and harness-development evidence, not a passing qualification.
The candidate is [PR #289](https://github.com/eosrio/hyperion-history-api/pull/289)
based on `c4f7780459dc2bd2d7ef13016bad35c79fdcaedb`. It used the unchanged
original 1..1480 Wire capture with archive SHA-256
`42d092f3ecf6f428ecdba4825580377acdd27f2818ce445d4f197719e6ab72b7`,
native Node 24.19.0, owned Elasticsearch 9.5.5/RabbitMQ/Redis/MongoDB services,
the production worker launcher and an independently queried current testnet RPC.
The selected `wire-sysio-6508c9e8-native-engineering-v1` provider was installed.

The first run held block 1, then failed at block 33 because the observer watched
`HyperionWorker.publishAdmitted` for an `index_actions` confirmation. The DS
worker uses `publishAdmittedActionWithEvidence` directly. The actual admission,
stored output and DS journal seal were present. The observer was corrected to
record the real owned AMQP `sendToQueue` callback without replacing its result.

The second run held blocks 1 and 33 and verified source-bound RPC block IDs for
138 `get_block` calls. Those calls covered original SHiP irreversible anchors
196419 and 196420; the source frame bytes were not rewritten. It observed 141
broker-confirmed action publications before shutdown, including the block-33
output. The driver released and acknowledged source through block 122 but its
60-second queue-drain wait expired there. The DS worker confirmed block 103
immediately before driver shutdown; after shutdown, the owned broker held 26
ready DS messages and one ready action message with no consumers. No passing
122 checkpoint or complete 1..1480 replay is claimed. The driver's timeout
caused an unsuccessful master shutdown receipt; the separate ownership-checked
service cleanup removed all owned containers, volumes and networks.

The [manifest](manifest.json) records original and published SHA-256 for 1,212
selected files in the [evidence archive](raw-evidence.tar.gz). Native observer,
prefix and bulk bytes are unchanged. Report and console entries replace local
filesystem, test-credential and private RPC-address strings; four entries were
redacted. [SHA256SUMS](SHA256SUMS) verifies the published files. This archive
contains both failed runs and their resource cleanup receipts, not a release
acceptance result.

The next physical run needs a Linux host that can complete the bounded full
worker replay, followed by the live SHiP fork/ACK/hold matrix in #288 and the
separate #277 capacity gates. Existing Elasticsearch history remains in use.
