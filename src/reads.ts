/** Reading messages and a recipient's read/ack state. */
import { type Database, SQLiteError } from "bun:sqlite";
import { RavenError } from "./error.ts";
import {
  agentRow,
  DELIVERY_FROM,
  type InboxRow,
  JOIN_PROJECT_SENDER,
  limitOf,
  MESSAGE_COLUMNS,
  MESSAGE_FROM,
  type MessageRow,
  projectId,
  toMessage,
} from "./rows.ts";
import type {
  IdsInput,
  InboxMessage,
  InboxQuery,
  Message,
  SearchQuery,
  ThreadState,
  TopicQuery,
} from "./types.ts";

const STREAM_PAGE = 200;

/** Where a stream reads from and the wake-up key its waits park on. */
export type StreamScope = { readonly key: string; readonly page: (after: number) => MessageRow[] };

export function streamScope(db: Database, project: string, agent: string | undefined): StreamScope {
  const pid = projectId(db, project);
  if (agent === undefined) {
    const q = db.query<MessageRow, [number, number, number]>(
      `SELECT ${MESSAGE_COLUMNS} FROM ${MESSAGE_FROM} WHERE m.project_id = ? AND m.id > ? ORDER BY m.id LIMIT ?`,
    );
    return { key: `p${pid}`, page: (after) => q.all(pid, after, STREAM_PAGE) };
  }
  const aid = agentRow(db, pid, project, agent).id;
  const q = db.query<MessageRow, [number, number, number]>(
    `SELECT ${MESSAGE_COLUMNS} FROM ${DELIVERY_FROM} WHERE d.agent_id = ? AND m.id > ? ORDER BY m.id LIMIT ?`,
  );
  return { key: `a${aid}`, page: (after) => q.all(aid, after, STREAM_PAGE) };
}

export function inbox(db: Database, query: InboxQuery, ts: string): InboxMessage[] {
  const pid = projectId(db, query.project);
  const aid = agentRow(db, pid, query.project, query.agent).id;
  const unread = query.unreadOnly ?? true;
  const markRead = query.markRead === true;
  const rows = db
    .query<InboxRow, [number, number, number]>(
      `SELECT ${MESSAGE_COLUMNS}, d.kind, d.read_ts, d.ack_ts FROM ${DELIVERY_FROM}
       WHERE d.agent_id = ? AND (? = 0 OR d.read_ts IS NULL) ORDER BY m.id DESC LIMIT ?`,
    )
    .all(aid, unread ? 1 : 0, limitOf(query.limit));
  if (markRead) {
    const setRead = db.query(
      "UPDATE deliveries SET read_ts = ? WHERE agent_id = ? AND message_id = ? AND read_ts IS NULL",
    );
    db.transaction(() => {
      for (const r of rows) {
        setRead.run(ts, aid, r.id);
      }
    })();
  }
  return rows.map((r) => ({
    ...toMessage(r),
    kind: r.kind,
    readTs: r.read_ts ?? (markRead ? ts : null),
    ackTs: r.ack_ts,
  }));
}

/** Read or acknowledged, for messages delivered to this agent only; an acknowledgement also reads. */
export function mark(db: Database, input: IdsInput, what: "read" | "ack", ts: string): void {
  const pid = projectId(db, input.project);
  const aid = agentRow(db, pid, input.project, input.agent).id;
  const held = db.query<{ message_id: number }, [number, number]>(
    "SELECT message_id FROM deliveries WHERE agent_id = ? AND message_id = ?",
  );
  const missing = input.ids.filter((id) => held.get(aid, id) === null);
  if (missing.length > 0) {
    throw new RavenError(
      "unknown_message",
      `not delivered to ${input.agent} in ${input.project}: ${missing.join(", ")}`,
    );
  }
  const set =
    what === "ack"
      ? "read_ts = COALESCE(read_ts, $ts), ack_ts = COALESCE(ack_ts, $ts)"
      : "read_ts = COALESCE(read_ts, $ts)";
  const update = db.query<unknown, Record<string, string | number>>(
    `UPDATE deliveries SET ${set} WHERE agent_id = $agent AND message_id = $id`,
  );
  db.transaction(() => {
    for (const id of input.ids) {
      update.run({ ts, agent: aid, id });
    }
  })();
}

export function topic(db: Database, query: TopicQuery): Message[] {
  const pid = projectId(db, query.project);
  let since = "";
  if (query.since !== undefined) {
    const ms = Date.parse(query.since);
    if (Number.isNaN(ms)) {
      throw new RavenError("invalid", `not an ISO-8601 timestamp: ${query.since}`);
    }
    since = new Date(ms).toISOString();
  }
  return db
    .query<MessageRow, [number, string, string, number]>(
      `SELECT ${MESSAGE_COLUMNS} FROM ${MESSAGE_FROM}
       WHERE m.project_id = ? AND m.topic = ? AND m.created_ts > ? ORDER BY m.id DESC LIMIT ?`,
    )
    .all(pid, query.topic, since, limitOf(query.limit))
    .map(toMessage);
}

export function search(db: Database, query: SearchQuery): Message[] {
  const pid = projectId(db, query.project);
  try {
    return db
      .query<MessageRow, [string, number, number]>(
        `SELECT ${MESSAGE_COLUMNS} FROM messages_fts f JOIN messages m ON m.id = f.rowid ${JOIN_PROJECT_SENDER}
         WHERE messages_fts MATCH ? AND m.project_id = ? ORDER BY bm25(messages_fts) LIMIT ?`,
      )
      .all(query.query, pid, limitOf(query.limit))
      .map(toMessage);
  } catch (e) {
    if (e instanceof SQLiteError) {
      throw new RavenError("invalid", `search query: ${e.message}`, { cause: e });
    }
    throw e;
  }
}

export function threadState(db: Database, project: string, thread: number): ThreadState {
  const row = db
    .query<{ count: number; id: number; sender: string; ts: string }, [number, number]>(
      `SELECT (SELECT COUNT(*) FROM messages WHERE thread_id = m.thread_id) AS count,
              m.id, s.name AS sender, m.created_ts AS ts
       FROM messages m JOIN agents s ON s.id = m.sender_id
       WHERE m.project_id = ? AND m.thread_id = ? ORDER BY m.id DESC LIMIT 1`,
    )
    .get(projectId(db, project), thread);
  if (row === null) {
    throw new RavenError("unknown_thread", `no thread ${thread} in ${project}`);
  }
  return { thread, count: row.count, last: { id: row.id, from: row.sender, ts: row.ts } };
}
