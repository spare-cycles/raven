/** Writing messages: one transaction per send, after which the caller wakes the streams it touched. */
import type { Database } from "bun:sqlite";
import { RavenError } from "./error.ts";
import {
  activeAgent,
  MESSAGE_COLUMNS,
  MESSAGE_FROM,
  type MessageRow,
  projectId,
  toMessage,
} from "./rows.ts";
import type { ReplyInput, SendInput, Sent } from "./types.ts";

const IMPORTANCE: Record<string, true> = { low: true, normal: true, high: true, urgent: true };
const REPLIED = /^re:/iu;

/** A committed send and the wake-up keys of every stream that must look again. */
export type Written = { readonly sent: Sent; readonly wake: readonly string[] };

/** Recipients in the order given, each once; a name in both lists stays only in `to`. */
function routing(to: readonly string[], cc: readonly string[]): { to: string[]; cc: string[] } {
  const uniqueTo = [...new Set(to)];
  const inTo = new Set(uniqueTo);
  return { to: uniqueTo, cc: [...new Set(cc)].filter((n) => !inTo.has(n)) };
}

function validated(input: SendInput): { to: string[]; cc: string[]; importance: string } {
  const importance = input.importance ?? "normal";
  if (!Object.hasOwn(IMPORTANCE, importance)) {
    throw new RavenError("invalid", `importance must be low|normal|high|urgent: ${importance}`);
  }
  const { to, cc } = routing(input.to, input.cc ?? []);
  if (to.length === 0) {
    throw new RavenError("invalid", "a message needs at least one `to` recipient");
  }
  return { to, cc, importance };
}

function prior(db: Database, sender: number, key: string | undefined): Sent | null {
  if (key === undefined) {
    return null;
  }
  const row = db
    .query<{ id: number; thread_id: number; created_ts: string }, [number, string]>(
      "SELECT id, thread_id, created_ts FROM messages WHERE sender_id = ? AND idempotency_key = ?",
    )
    .get(sender, key);
  return row === null ? null : { id: row.id, thread: row.thread_id, ts: row.created_ts };
}

function requireRoot(db: Database, project: number, input: SendInput): void {
  if (input.thread === undefined) {
    return;
  }
  const root = db
    .query<{ id: number }, [number, number]>(
      "SELECT id FROM messages WHERE project_id = ? AND id = ? AND thread_id = id",
    )
    .get(project, input.thread);
  if (root === null) {
    throw new RavenError("unknown_thread", `no thread ${input.thread} in ${input.project}`);
  }
}

export function send(db: Database, input: SendInput, ts: string): Written {
  const { to, cc, importance } = validated(input);
  return db.transaction((): Written => {
    const project = projectId(db, input.project);
    const sender = activeAgent(db, project, input.project, input.from);
    const again = prior(db, sender.id, input.idempotencyKey);
    if (again !== null) {
      return { sent: again, wake: [] };
    }
    const recipients = [
      ...to.map((n) => ({ id: activeAgent(db, project, input.project, n).id, kind: "to" })),
      ...cc.map((n) => ({ id: activeAgent(db, project, input.project, n).id, kind: "cc" })),
    ];
    requireRoot(db, project, input);
    const row = db
      .query<{ id: number }, Record<string, string | number | null>>(
        `INSERT INTO messages (project_id, sender_id, to_json, cc_json, subject, body, thread_id, topic,
           importance, ack_required, created_ts, idempotency_key)
         VALUES ($project, $sender, $to, $cc, $subject, $body, $thread, $topic, $importance, $ack, $ts, $key)
         RETURNING id`,
      )
      .get({
        project,
        sender: sender.id,
        to: JSON.stringify(to),
        cc: JSON.stringify(cc),
        subject: input.subject,
        body: input.body,
        thread: input.thread ?? 0,
        topic: input.topic ?? null,
        importance,
        ack: input.ackRequired === true ? 1 : 0,
        ts,
        key: input.idempotencyKey ?? null,
      });
    if (row === null) {
      throw new RavenError("invalid", "insert returned no id");
    }
    const thread = input.thread ?? row.id;
    db.query("UPDATE messages SET thread_id = ? WHERE id = ?").run(thread, row.id);
    const deliver = db.query(
      "INSERT INTO deliveries (agent_id, message_id, kind) VALUES (?, ?, ?)",
    );
    for (const r of recipients) {
      deliver.run(r.id, row.id, r.kind);
    }
    return {
      sent: { id: row.id, thread, ts },
      wake: [...recipients.map((r) => `a${r.id}`), `p${project}`],
    };
  })();
}

/**
 * A reply joins the original's thread under its topic and goes back to its sender. Replying to your own message
 * follows it up instead: it goes to the original's recipients.
 */
export function reply(db: Database, input: ReplyInput, ts: string): Written {
  const row = db
    .query<MessageRow, [number, number]>(
      `SELECT ${MESSAGE_COLUMNS} FROM ${MESSAGE_FROM} WHERE m.project_id = ? AND m.id = ?`,
    )
    .get(projectId(db, input.project), input.to);
  if (row === null) {
    throw new RavenError("unknown_message", `no message ${input.to} in ${input.project}`);
  }
  const original = toMessage(row);
  const self = original.from === input.from;
  return send(
    db,
    {
      project: input.project,
      from: input.from,
      to: self ? original.to : [original.from],
      cc: input.cc ?? (self ? original.cc : []),
      subject: REPLIED.test(original.subject) ? original.subject : `Re: ${original.subject}`,
      body: input.body,
      thread: original.thread,
      ...(original.topic === null ? {} : { topic: original.topic }),
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
    },
    ts,
  );
}
