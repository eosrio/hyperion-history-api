# Physical IDs for new protocol history records

The protocol provider retains a complete logical identity, physical record, raw
row bytes and source position. These belong in `_source.protocol`, mapped with
`enabled:false`. New protocol records use bounded physical IDs because
[Elasticsearch limits `_id` to 512 bytes](https://www.elastic.co/docs/reference/elasticsearch/mapping-reference/mapping-id-field).
Existing Antelope records keep their current `_id`, `primary_key` and mappings.
No retained-history reindex is required.

`h45h1:` followed by lowercase SHA-256 hex identifies a history occurrence. Hash
these UTF-8 strings in order, each preceded by its unsigned 64-bit big-endian
byte length:

1. `hyperion-history-document-v1`
2. Protocol package identity (`protocol.id`)
3. Source chain ID
4. Complete logical identity
5. Source block ID
6. Source block number in canonical decimal
7. Source ordinal in canonical decimal

The top-level block number/ID must match the source. Chain and block IDs are
lowercase 32-byte hex; block numbers are positive uint32 and ordinals are uint32.
Unpaired string surrogates and incomplete provenance fail before the bulk write
or acknowledgment. Different forks and source occurrences have distinct IDs;
replaying the same occurrence is idempotent.

New protocol records also use an opaque `primary_key` token: `h45k1:` followed by
the same framed SHA-256 construction over `hyperion-state-key-v1`, protocol
package identity, source chain ID and complete logical identity. MongoDB stores
that token as `@protocol_key` while preserving the complete protocol metadata.
Primary and secondary records have separate provider-defined identities. Actual
compound keys remain untruncated in `protocol.record` and `protocol.logicalIdentity`.
The token is a physical lookup key, not the contract's original primary key.

Profile versions, ABI deployment, payer, presence and decoded values are excluded
from both hashes so a corrected decoding does not duplicate the same occurrence
or state key. Retain those fields in source metadata. This policy applies only to
new protocol records; existing history IDs and API representations stay intact.

The index templates add disabled `protocol` objects to block and delta mappings.
Before activating an extension against an existing target index, ensure its
active mappings contain that additive disabled field, as well as future index
templates. Do not let Elasticsearch dynamically map arbitrarily sized raw keys
or decoder metadata. Fresh Wire testnet indexes start with these templates.

`protocol-document-id.test.ts` exercises actual bulk routing with long keys,
legacy IDs, retry stability, fork/ordinal separation and refusal before writes
or acknowledgments. This is implementation coverage, not live cluster or fork
recovery qualification.
