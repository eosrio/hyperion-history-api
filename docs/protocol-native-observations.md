# Retained protocol-native observations

[ProtocolNativeObservationStore](../src/indexer/protocol/native-observation-store.ts) stores detached
native labels separately from ABI reduction. The index suffix is `protocol-native-actions-v1`;
the existing original ABI capture, context, selection and observation-link records remain references.
Native records contain no decoded values or duplicated block/trace sections.

`prepare(selectionId, record)` takes a bounded detached snapshot, normalizes component order,
validates the selected context/profile/source/capture references, then durably writes the record and
selection link. It rereads both native bundles and all retained references before returning
`{linkId, link, record, selection, context, abiObservation, abiLink}`.
Identical delivery retries reassert bytes under the existing all-copy CAS receipt rules.
Changed outcomes for the same source identity conflict. A successful GET never rescues a deficient
write receipt; storage, reference, configuration and durability failures escape to the caller.

`readSelection(selectionId, signal?)` resolves the same opening without writes when constructed with
`undefined, {readOnly:true}` as the final two constructor arguments. The same optional signal
reaches all nested storage reads. Pre-aborted reads do no I/O; cancellation takes precedence over
late success and translated errors, preserving the caller's exact reason.

Observation IDs use `h45natobs1:` and the accepted
`hyperion-native-action-observation-v1` source/context/profile/capture domain.
Selection links use `h45srcnat1:` and `hyperion-source-native-observation-v1`.
Outcomes, inventory and delivery/session/head/LIB metadata do not alter observation identity.
Complete canonical payload digests bind the stored outcomes.

Default bounds are exported as frozen `protocolNativeObservationBounds`: 512 KiB chunks,
64 MiB payloads and 128 chunks. Links are limited to 64 KiB. Observed facts pass SDK validation,
require a nonnull inventory with matching first-receiver count, and require present original block
and trace sections. Whole-source incomplete evidence may retain a valid inventory or null.
ABI extraction may independently remain incomplete.

The host derives inventory, matches every origin/raw digest and supplies source-vector decision
order. This store preserves that order; its schema/count checks cannot prove source completeness.
Neither PREPARE nor readback establishes canonical membership, authorizes decoding, activates a
profile or qualifies the Wire testnet. The internal [native authorization reader](protocol-native-authorization.md)
separately verifies original source and canonical occurrence authority. Worker/API/cache/stream
acceptance, including #231, remains separate work.
