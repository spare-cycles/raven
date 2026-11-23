# raven

Messaging for coding agents: projects, agent identities, threads and topics, to/cc, read and ack state, a durable
SQLite store, and push delivery to open streams.

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

Every other route needs `Authorization: Bearer <token>`. `raven token create` (or `store.issueToken`) mints a token
and prints the only copy; the store keeps its SHA-256. The scopes are:

- `agent`: messaging and reads in its projects, including registering agents.
- `admin`: adds the project firehose (a stream without `agent`) and `retire`.

The client's `stream` reconnects with backoff after a dropped connection or a server restart, and resumes from its
last cursor. It stops with a `RavenError` on a refusal that would only repeat.

### Running it

```sh
raven serve --db /data/raven.db --host 127.0.0.1 --port 7811
raven token create --db /data/raven.db --label realmd --scope admin --project /perso/realm
raven token create --db /data/raven.db --label agents --project /perso/realm
raven token list --db /data/raven.db             # one JSON line per token, no secrets
raven token revoke --db /data/raven.db --label agents
```

Token commands work against the database a running server uses, and a revocation takes effect on the next request.

The `Dockerfile` runs `raven serve` on `/data/raven.db` (a volume) at `127.0.0.1:7811`, with daily snapshots in
`/data/snapshots`; override the command for another bind.

### Agent names

`register` without a name gets `<Adjective><Noun>` from two word lists, picked at random among the combinations no
agent has ever had, in any project and including retired ones, so a name is never reissued. An explicit name is
still accepted (letters, digits, `_`, `-`).

The lists default to 50 silly adjectives and 50 scientists, and each can be replaced per database:

```sh
raven config get --db /data/raven.db names.nouns
raven config set --db /data/raven.db names.nouns --value "Curie, Darwin, …"   # empty value: back to the default
```

A list needs at least 10 entries, each one capitalised word (`^[A-Za-z][a-z]*$`), unique regardless of case. Once
every combination is spent, `register` refuses rather than reuse one.

### Snapshots, export, import

- `serve --snapshot-dir <dir> [--keep 7]` writes `raven-YYYY-MM-DD.db` once per UTC day, checking hourly, and keeps
  the newest `--keep`. `raven snapshot --db <path> --out <file>` takes one by hand. Both use `VACUUM INTO`, which
  is consistent while the server writes.
- `raven export --db <path> [--project <key>]` prints one `Message` JSON line per message, oldest first.
- `raven import --db <path> --file <jsonl|->` takes history from another system, one record per line. A record
  has `project`, `ref`, `from`, `to`, `subject`, `body` and `ts` (ISO-8601), plus optional `cc`, `topic`,
  `importance`, and `replyTo` (the `ref` of an earlier record).
  - Times are kept, and a `replyTo` joins its thread.
  - Names never seen are registered (program `import`).
  - Deliveries arrive already read, so nothing wakes.
  - A `ref` already imported is skipped, so a rerun is safe.
  - The whole file is validated first and written in one transaction: a bad record, or a `replyTo` pointing at a
    later record, imports nothing.

## `raven mcp`: agents, and waking them

`raven mcp` is a stdio MCP server for one agent session. It reads `RAVEN_URL`, `RAVEN_TOKEN`, and optionally
`RAVEN_PROJECT` and `RAVEN_AGENT`; `project_key`, `sender_name` and `agent_name` default to the last two.

The tools keep Agent Mail's names and argument shapes:

| tool | does |
|---|---|
| `send_message`, `reply_message` | send, or reply in the thread (`thread_id` is the root message id) |
| `fetch_inbox` | newest first, marks the returned messages read; `include_bodies` defaults to false |
| `mark_message_read`, `acknowledge_message` | read or ack state |
| `fetch_topic` | every message under a topic, newest first |
| `search_messages` | full-text search (FTS5 syntax) over subject and body, best match first |
| `list_agents`, `register_agent`, `retire_agent` | identities; `register_agent` picks a fresh name when given none; `retire_agent` needs an admin token |

With `RAVEN_AGENT` set, the process holds a stream for that agent. Each delivery sends
`notifications/resources/updated` on `raven://inbox/<agent>` to a client that subscribed. Mail already waiting
wakes the session when it subscribes.

omp needs `mcp.notifications: true` to subscribe to that resource and inject each update. An idle session starts a
turn from it.

For a client that does not subscribe, `raven mcp` also sends `notifications/raven/delivery` on every delivery.
`extension/raven-wake.ts` turns that into an omp aside; use it only with `mcp.notifications: false`, or each
delivery wakes the session twice.

CI's `omp-e2e` job runs both paths against the omp version it pins.

omp's streamable-HTTP MCP transport does not deliver server notifications to the session as of 19.1.1, which is why
the agent side is stdio.

Requires Bun ≥ 1.4 (`bun:sqlite`); the package ships TypeScript source.
