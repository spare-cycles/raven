# raven

Messaging for coding agents: projects, agent identities, threads and topics, to/cc, read and ack state, a durable
SQLite store, and push delivery to open streams.

The `raven mcp` stdio server comes next.

```ts
import { createMemoryRaven } from "@spare-cycles/raven";

const raven = createMemoryRaven();
await raven.register({ project: "/demo", name: "Queen", program: "omp", model: "any" });
await raven.register({ project: "/demo", name: "Ana", program: "omp", model: "any" });

const { id } = await raven.send({ project: "/demo", from: "Queen", to: ["Ana"], subject: "hi", body: "…" });

for await (const { cursor, message } of raven.stream({ project: "/demo", agent: "Ana", after: 0 })) {
  // persist `cursor`; resume later with `after: cursor`
}
```

## Delivery contract

- `send` resolves after the message and its deliveries are committed (`synchronous = FULL`).
- Message ids are global and never reused. A recipient's deliveries are an ordered subsequence of them, so the id is
  the cursor: `stream({ after })` replays everything newer, then waits for new messages.
- At least once: a consumer that resumes from its last persisted cursor sees no gap, possibly a repeat; dedupe by id.
- A send naming an unknown or retired recipient is refused whole; nobody receives it.
- A retried send with the same sender and `idempotencyKey` returns the first result and stores nothing.
- `ack` is the message-level acknowledgement. It does not affect redelivery, which only the consumer's cursor
  governs.
- `createMemoryRaven()` runs this same core on an in-memory database, for consumers' tests.

## HTTP

`serve({ store, port, hostname })` exposes a `Store`; `createClient({ url, token })` is the same `Raven` interface over
it.

| route | |
|---|---|
| `POST /v1/rpc` | `{ method, params }` → `{ result }`; `method` is a `Raven` method name other than `stream` |
| `GET /v1/stream?project=&agent=` | SSE, one `event: delivery` per message, `id:` = cursor; resumes from `Last-Event-ID`; a `: ping` comment every 25 s |
| `GET /healthz` | `ok`, no token |

Refusals are `{ error: { code, message } }`. The status is 400 for `invalid`, 401 `unauthorized`, 403 `forbidden`,
404 for `unknown_*`, 409 `retired_agent` and 503 `unavailable`.

Every other route needs `Authorization: Bearer <token>`. `store.issueToken({ label, scope, projects })` mints a token
and returns the only copy; the store keeps its SHA-256. The scopes are:

- `agent`: messaging and reads in its projects, including registering agents.
- `admin`: adds the project firehose (a stream without `agent`) and `retire`.

The client's `stream` reconnects with backoff after a dropped connection or a server restart, and resumes from its
last cursor. It stops with a `RavenError` on a refusal that would only repeat.

Requires Bun ≥ 1.4 (`bun:sqlite`); the package ships TypeScript source.
