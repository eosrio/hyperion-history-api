# Running Elasticsearch (and undici-based libs) on Bun — status & workaround

**Verified 2026-05-31** · Bun 1.3.13 · `@elastic/elasticsearch` 9.4.2 (transport 9.3.6, undici `^7.19.1`)

## TL;DR
- **Elasticsearch works on stock, unmodified Bun today** — if you set the client's `Connection: HttpConnection` (uses `node:http(s)`, which Bun supports). The **default `UndiciConnection` fails** because Bun's built-in `undici.Pool`/`Client` are unimplemented stubs.
- This switch is **ES-specific**. Other libraries that call `undici.Pool`/`Client`/`stream()` directly have no equivalent and need the upstream Bun fix (oven-sh/bun **#27338**).

## The fix (Elasticsearch)
```js
import { Client, HttpConnection } from "@elastic/elasticsearch";

const client = new Client({
  node: process.env.ES_NODE,
  auth: { /* apiKey or username/password */ },
  Connection: HttpConnection,                  // node:http instead of undici
  agent: { keepAlive: true, maxSockets: 256 }, // important for bulk throughput
});
```
- Apply at **every** `new Client(...)` — including inside `worker_threads`. A client still on the default connection fails with this exact error: `TypeError: undefined is not an object (evaluating 'response.headers')`.
- Recommended: gate behind an env var (e.g. `ES_HTTP_CONNECTION=1`) so you can A/B against Node without forking code.

## Bun's built-in undici surface
| API | Stock Bun 1.3.13 | With oven-sh/bun#27338 |
|---|---|---|
| `request()` | works | works |
| `Pool` / `Client` / `Agent` | **stub → returns `undefined`** | fixed |
| `stream()` | **"not implemented"** | fixed |
| `pipeline()` / `connect()` / `upgrade()` | **"not implemented"** | fixed |

## Verified dead ends — don't spend time here
- **Installing the real `undici` package does NOT help on stock Bun.** Bun hard-aliases the bare `undici` specifier to its builtin unconditionally (`src/resolve_builtins/HardcodedModule.rs`), and a `Bun.plugin` `onResolve` does **not** override it. Real undici 8.x also crashes on import anyway (`webidl.util.markAsUncloneable is not a function`).

## Performance note
undici is ES's default connection because it's faster (connection pooling / keep-alive). `HttpConnection` is the **compatibility bridge** to run on Bun now; the performant end-state is the undici path once **#27338** ships (or via a Bun build that includes it). Tune `maxSockets`/`keepAlive` to narrow the gap for bulk indexing.

## Also validate on Bun (Hyperion stack, beyond ES)
The ES connection swap is moot if another dependency breaks first. Smoke-test the full pipeline on Bun: **RabbitMQ (`amqplib`), Redis (`ioredis`), `ws`/`socket.io`, `fastify`, `worker_threads`** → ingest → parse worker → `_bulk` index → API/stream.
