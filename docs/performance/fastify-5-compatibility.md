# Patched Fastify 5 compatibility

Scope: [#385](https://github.com/eosrio/hyperion-history-api/issues/385). Pin the API runtime
to Fastify **5.12.7**, preserving existing plugin versions, application hooks and configuration.
The lock change includes its router, serializer and warning dependency closure. SDK, Wire,
MongoDB adapter, Elasticsearch and frozen qualification profile pins remain unchanged.

The [official release](https://github.com/fastify/fastify/releases/tag/v5.12.7) resolves to
`9f400035ebaf572b95989db5040ebb09c01e4e77`. Its registry tarball integrity is
`sha512-v4pEPsTRPuqlDIYiQFB+BHjVN4SdHX9u0ABk0ZDUKbbdY1vsNryUd1j4Z+jQEZajvYIVk047Kimva9/AJ79GYw==`.
The previous 5.8.5 pin is affected by the vendor's
[malformed URL/fallback encapsulation advisory](https://github.com/fastify/fastify/security/advisories/GHSA-p68q-wchp-6fh7).
The [header propertyNames normalization fix](https://github.com/fastify/fastify/security/advisories/GHSA-389g-gv7q-r4x8)
also requires 5.12.6 or later; an intermediate 5.12.2 pin would be insufficient.
These notices establish affected dependency versions, not exploitability of a deployed Hyperion route.

## Repeatable request controls

After `npm ci --allow-git=all` and `npm run build`, run:

```sh
node --test --test-timeout=15000 tests/native/fastify-compatibility.test.mjs
```

The native Node 24/26 CI jobs run four controls against installed Fastify and emitted application
modules. They cover malformed URLs with sibling fallback authentication, canonical-case header
constraints, plugin version/dependency metadata, real CORS/form-body/rate-limit hooks and actual
autoload of `/v2/state/query`. The state route exercises the existing logical query service with
controlled storage/source ports: false/zero values, served-view headers, unknown-field rejection
and a changed source owner returning retryable 503 without rows or state headers.

The nine `fastify-plugin` packages have their original compatibility metadata validated by Fastify
in registration order. This inert metadata probe opens no Redis, MongoDB or proxy connection.
Autoload is exercised by the actual emitted state route. The HTTP-only plugin execution checks
do not establish a full API startup with every external service. Existing API tests separately
cover exact sequence IDs, protocol-derived bodies/cache fences, search errors and cancellation.

The new owner-v2 domain host and its final `onSend` authority check are separate implementation
work under #366. This dependency qualification does not supply that missing production integration,
AtomicAssets/AtomicMarket endpoint parity, physical storage qualification or a full Wire replay.

## Evidence boundary

The comparison lock installed normally at 5.8.5. An initial unbounded diagnostic was interrupted;
the explicitly bounded comparison then timed out in the malformed-URL control, failed the header
constraint, passed the emitted state route and exposed a test-harness assumption about autoload
metadata. That metadata probe was corrected because autoload is not a `fastify-plugin` wrapper.
A subsequent patched harness attempt also caught route registration before the rate-limit plugin
was ready; it was fixed by awaiting plugin registration before defining that route. Those
intermediate receipts remain distinct from the final passing controls.

The recorded audit comparison removes Fastify from the affected package list and adds no affected
package. It is not a clean whole-tree audit: other packages remain reported and were not upgraded
by this slice. Audit counts are time-specific dependency evidence, not demonstrated application
vulnerabilities. Existing frozen full-replay outcomes and runtime profiles retain their original
versions and results. No service deployment or cluster setting change is included.
