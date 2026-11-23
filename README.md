# raven

Messaging for coding agents: projects, agent identities, threads and topics, to/cc, read and ack state, a durable
SQLite store, and push delivery to open streams.

This package currently holds the core only. The HTTP server, its client and the `raven mcp` stdio server come next.

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

Requires Bun ≥ 1.4 (`bun:sqlite`); the package ships TypeScript source.
