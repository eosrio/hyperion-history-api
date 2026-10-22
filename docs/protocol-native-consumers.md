# Native action consumers

This is the coordinated worker and serving boundary for #266, following the original-source
[authorization reader](protocol-native-authorization.md). It preserves deployed ABI metadata,
retained raw history and the existing worker/RabbitMQ infrastructure. Installed native-required
profiles remain inactive until the remaining #256/#191/#231 qualification and activation gates pass.

## Metadata and canonical interpretation

Protocol metadata stays outside `act.data` and contract annotations. Schema v1 continues to identify
the existing ABI proof or an incomplete raw source. Schema v2 identifies a native result with
`kind: native`, or a certified observer failure with `kind: incomplete`, `status: incomplete` and
its bounded error. An authorized native result whose value cannot be published also remains raw,
with `kind: native`, `status: incomplete` and a bounded error. Incomplete output grants no value
or decoded-query authority.

Every v2 locator binds the exact three-field source identity, source selection, original occurrence
and lossless receipt identifiers. Its native fields identify the source context, native journal link
and observation/digest, original ABI capture reference, inventory digest and coordinated component
profile. Successful native locators additionally retain the opaque native kind. These are locators,
not executable selection or authority. Strict shape parsing is followed by comparison against a
fresh grant from the host-selected pinned provider; stored names or kinds never choose a decoder.

New native-aware coordinator epochs add `nativeActionInterfaceVersion: 1` to immutable canonical
commits. This expresses a requirement to classify actions, independently of whether native
extraction succeeded. It does not alter the ABI state reducer or poison unrelated account coverage.
Read-only proof views retain that requirement through ancestry, owner recovery and cold reopening.
True legacy commits remain unchanged and retain their existing v1 contract interpretation. A marked
source requires native classification before any v1 decoded contract result can be accepted;
native or incomplete decisions cannot be downgraded to an ABI lookup by stripping v2 fields.

No existing history index or immutable commit is rewritten to install this additive marker.
The `protocol` history mapping remains opaque and requires no full history reindex.

## Original envelopes and values

The authorization reader independently derives complete original occurrence, creator, authorization
and receipt fields while decoding the retained original trace. `verifyEnvelope` checks the source,
representative action, exact decimal sequences, creator, authorization, action digest and counters.
Every retained grouped receipt must be an original member of the same certified first-receiver
origin. Duplicate, invented and independent inline receipts are rejected. Filtered notifications may
be a subset; the representative occurrence must remain present. Locators are compared to fresh
grant-derived metadata. The returned envelope is detached before asynchronous consumer work.

`verifyValue` checks a retained native value by encoding it with the grant's authorized kind back
to its original bytes. Its returned snapshot and the provider's encoder input have separately owned
bytes. `decodeValue` continues to supply a fresh strict decoded value. Canonical authority is checked
around consumption and at final worker/response/cache/send fences. Internal rich values supported
by the reader do not create a new public JSON serialization format.

## Source membership and failure isolation

Independent source admission still compares all final source, selection, input, receipt and grouping
fields against the original unfiltered source and captured filter policy. Schema v2 changes the
representation of that proof locator; it does not remove the comparison. The producer separately
owes fresh native grant, value and canonical publication checks.

A certified incomplete origin may retain its exact raw bytes and grouped original receipts alongside
valid sibling origins. It must carry the incomplete marker and error; decoded data and contract
annotations cannot be substituted for raw output. Sealing that complete source-membership inventory
does not claim decoded predicate completeness, state readiness or full Wire qualification. Existing
projection/query-readiness gates remain separate. Unavailable inputs outside configured verified
ancestry remain unavailable; increasing the window is not historical qualification.

## HTTP, Redis and current streams

The shared action consumer resolves native and contract documents through disjoint metadata paths.
Native-aware sources must classify even schema-v1 documents before deployed ABI decoding. Native
responses reopen the original native journal decision, verify their complete source envelope and
encode retained values back to the original bytes. Existing action, transaction, hex and derived
response handlers use that shared boundary before shaping removes source fields. Raw history stays
available when decoded authority is unavailable.

Redis response capsules use their own version, independently of document metadata. The current
capsule binds its rendered body, proof entries and node-response marker; older capsules miss and
are recomputed. Integrity digests detect changes to a retained capsule but do not authenticate a
fully forged Redis record. Every accepted proof entry still reopens canonical authority. Native
capsules retain private checked envelopes and values where public renderers discard those fields.
Proof capsules never enter public response bodies.

HTTP requests and individual stream batches own cancellation scopes. A disconnected request stops
its outstanding proof reads; one stream recipient disconnecting does not cancel remaining recipients.
Final response, cache and send checks operate on detached snapshots and revalidate source authority.
The internal consumer service can bind an already selected provider to its host. Normal production
construction still uses the unchanged installed-provider loader.

## Qualification boundary

Positive native consumer fixtures use explicitly labelled engineering orchestration of an already
selected pinned provider. Normal production selection retains loader negotiation and refuses the
currently inactive native capability; fixture injection is not installed-package acceptance.
Original Wire inputs remain unchanged, with synthetic notification/incomplete controls labelled
separately. Controlled broker, storage and socket transports are consumer integration evidence.
They do not establish live service, client/proxy reconnect, fork/LIB soak or release acceptance.
