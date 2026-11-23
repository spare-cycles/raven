/** Moving messages in and out of a store: JSONL export, historical import, and file snapshots. */
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { register } from "./agents.ts";
import { RavenError } from "./error.ts";
import { MESSAGE_COLUMNS, MESSAGE_FROM, type MessageRow, projectId, toMessage } from "./rows.ts";
import type { Importance, Message } from "./types.ts";

const PAGE = 500;
const IMPORTED_PROGRAM = "import";

/** One line of `raven import`: a message from another system, kept with its original time. */
export type ImportRecord = {
  readonly project: string;
  /** The message's id in the system it comes from; re-importing the same ref is a no-op. */
  readonly ref: string;
  readonly from: string;
  readonly to: readonly string[];
  readonly cc?: readonly string[];
  readonly subject: string;
  readonly body: string;
  readonly topic?: string;
  readonly importance?: Importance;
  /** ISO-8601. */
  readonly ts: string;
  /** The ref of an earlier record this one answers; the import joins its thread. */
  readonly replyTo?: string;
};

const name = z.string().min(1);

export const importRecord: z.ZodType<ImportRecord> = z.strictObject({
  project: name,
  ref: name,
  from: name,
  to: z.array(name).min(1),
  cc: z.array(name).exactOptional(),
  subject: z.string(),
  body: z.string(),
  topic: name.exactOptional(),
  importance: z.enum(["low", "normal", "high", "urgent"]).exactOptional(),
  ts: z.string(),
  replyTo: name.exactOptional(),
});

/** Every message, oldest first, a page at a time; `project` narrows to one project. */
export function* exportMessages(db: Database, project: string | undefined): Generator<Message> {
  const q = db.query<MessageRow, [number, string | null, string | null, number]>(
    `SELECT ${MESSAGE_COLUMNS} FROM ${MESSAGE_FROM} WHERE m.id > ? AND (? IS NULL OR p.key = ?)
     ORDER BY m.id LIMIT ?`,
  );
  const key = project ?? null;
  let after = 0;
  let rows: MessageRow[];
  do {
    rows = q.all(after, key, key, PAGE);
    for (const row of rows) {
      after = row.id;
      yield toMessage(row);
    }
  } while (rows.length === PAGE);
}

function importedId(
  db: Database,
  project: number,
  ref: string,
): { id: number; thread: number } | null {
  return db
    .query<{ id: number; thread: number }, [number, string]>(
      "SELECT id, thread_id AS thread FROM messages WHERE project_id = ? AND idempotency_key = ?",
    )
    .get(project, `import:${ref}`);
}

/** The agent's id, registering it (and its project) when the history names someone raven never met. */
function agentId(db: Database, project: string, agent: string, ts: string): number {
  function find(): { id: number } | null {
    return db
      .query<{ id: number }, [string, string]>(
        "SELECT a.id FROM agents a JOIN projects p ON p.id = a.project_id WHERE p.key = ? AND a.name = ?",
      )
      .get(project, agent);
  }
  const known = find();
  if (known !== null) {
    return known.id;
  }
  register(db, { project, name: agent, program: IMPORTED_PROGRAM, model: "-" }, ts);
  const created = find();
  if (created === null) {
    throw new RavenError("invalid", `could not register ${agent} in ${project}`);
  }
  return created.id;
}

function importOne(db: Database, r: ImportRecord): boolean {
  const ms = Date.parse(r.ts);
  if (Number.isNaN(ms)) {
    throw new RavenError("invalid", `record ${r.ref}: not an ISO-8601 timestamp: ${r.ts}`);
  }
  const ts = new Date(ms).toISOString();
  const sender = agentId(db, r.project, r.from, ts);
  const pid = projectId(db, r.project);
  if (importedId(db, pid, r.ref) !== null) {
    return false;
  }
  const parent = r.replyTo === undefined ? null : importedId(db, pid, r.replyTo);
  if (r.replyTo !== undefined && parent === null) {
    throw new RavenError(
      "invalid",
      `record ${r.ref}: replyTo ${r.replyTo} is not imported; put it earlier`,
    );
  }
  const cc = (r.cc ?? []).filter((n) => !r.to.includes(n));
  const row = db
    .query<{ id: number }, Record<string, string | number | null>>(
      `INSERT INTO messages (project_id, sender_id, to_json, cc_json, subject, body, thread_id, topic,
         importance, ack_required, created_ts, idempotency_key)
       VALUES ($project, $sender, $to, $cc, $subject, $body, 0, $topic, $importance, 0, $ts, $key) RETURNING id`,
    )
    .get({
      project: pid,
      sender,
      to: JSON.stringify(r.to),
      cc: JSON.stringify(cc),
      subject: r.subject,
      body: r.body,
      topic: r.topic ?? null,
      importance: r.importance ?? "normal",
      ts,
      key: `import:${r.ref}`,
    });
  if (row === null) {
    throw new RavenError("invalid", `record ${r.ref}: insert returned no id`);
  }
  db.query("UPDATE messages SET thread_id = ? WHERE id = ?").run(parent?.thread ?? row.id, row.id);
  const deliver = db.query(
    "INSERT OR IGNORE INTO deliveries (agent_id, message_id, kind, read_ts) VALUES (?, ?, ?, ?)",
  );
  for (const n of r.to) {
    deliver.run(agentId(db, r.project, n, ts), row.id, "to", ts);
  }
  for (const n of cc) {
    deliver.run(agentId(db, r.project, n, ts), row.id, "cc", ts);
  }
  return true;
}

/**
 * Inserts history in one transaction: agents the records name are registered when missing, deliveries arrive
 * already read (nothing to wake for), threads follow `replyTo`, and a ref already imported is skipped, so a rerun
 * is safe.
 */
export function importMessages(
  db: Database,
  records: readonly ImportRecord[],
): { imported: number; skipped: number } {
  const imported = db.transaction(() => records.filter((r) => importOne(db, r)).length)();
  return { imported, skipped: records.length - imported };
}

/** A consistent copy of the whole database at `path`, taken while the store keeps serving. */
export function snapshot(db: Database, path: string): void {
  db.query("VACUUM INTO ?").run(path);
}
