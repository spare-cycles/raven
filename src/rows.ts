/** Row shapes, the SQL fragments that read them, and the lookups every verb starts from. */
import type { Database } from "bun:sqlite";
import { RavenError } from "./error.ts";
import type { Agent, Importance, Message } from "./types.ts";

export type MessageRow = {
  id: number;
  project: string;
  sender: string;
  to_json: string;
  cc_json: string;
  subject: string;
  body: string;
  thread_id: number;
  topic: string | null;
  importance: string;
  ack_required: number;
  created_ts: string;
};

export type InboxRow = MessageRow & {
  kind: "to" | "cc";
  read_ts: string | null;
  ack_ts: string | null;
};

export type AgentRow = {
  id: number;
  name: string;
  program: string;
  model: string;
  task: string;
  created_ts: string;
  retired_ts: string | null;
};

export const MESSAGE_COLUMNS = `m.id, p.key AS project, s.name AS sender, m.to_json, m.cc_json, m.subject,
  m.body, m.thread_id, m.topic, m.importance, m.ack_required, m.created_ts`;
const JOIN_PROJECT_SENDER =
  "JOIN projects p ON p.id = m.project_id JOIN agents s ON s.id = m.sender_id";
export const MESSAGE_FROM: string = `messages m ${JOIN_PROJECT_SENDER}`;
export const DELIVERY_FROM: string = `deliveries d JOIN messages m ON m.id = d.message_id ${JOIN_PROJECT_SENDER}`;

const DEFAULT_LIMIT = 50;

export function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    project: row.project,
    from: row.sender,
    to: JSON.parse(row.to_json) as string[],
    cc: JSON.parse(row.cc_json) as string[],
    subject: row.subject,
    body: row.body,
    thread: row.thread_id,
    topic: row.topic,
    importance: row.importance as Importance,
    ackRequired: row.ack_required === 1,
    ts: row.created_ts,
  };
}

export function toAgent(row: AgentRow): Agent {
  return {
    name: row.name,
    program: row.program,
    model: row.model,
    task: row.task,
    createdTs: row.created_ts,
  };
}

export function limitOf(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_LIMIT;
  }
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RavenError("invalid", `limit must be a positive integer, got ${limit}`);
  }
  return limit;
}

export function projectId(db: Database, key: string): number {
  const row = db.query<{ id: number }, [string]>("SELECT id FROM projects WHERE key = ?").get(key);
  if (row === null) {
    throw new RavenError("unknown_project", `no project ${key}`);
  }
  return row.id;
}

export function agentRow(db: Database, project: number, key: string, name: string): AgentRow {
  const row = db
    .query<AgentRow, [number, string]>("SELECT * FROM agents WHERE project_id = ? AND name = ?")
    .get(project, name);
  if (row === null) {
    throw new RavenError("unknown_agent", `no agent ${name} in ${key}`);
  }
  return row;
}

/** An agent that may send or receive now: registered and not retired. */
export function activeAgent(db: Database, project: number, key: string, name: string): AgentRow {
  const row = agentRow(db, project, key, name);
  if (row.retired_ts !== null) {
    throw new RavenError("retired_agent", `${name} in ${key} is retired`);
  }
  return row;
}
