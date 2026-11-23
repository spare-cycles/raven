/** Projects and agent identities. */
import type { Database } from "bun:sqlite";
import { RavenError } from "./error.ts";
import { type AgentRow, agentRow, projectId, toAgent } from "./rows.ts";
import type { Agent, RegisterInput } from "./types.ts";

const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;

export function register(db: Database, input: RegisterInput, ts: string): Agent {
  if (input.project.length === 0) {
    throw new RavenError("invalid", "project must not be empty");
  }
  if (!NAME.test(input.name)) {
    throw new RavenError("invalid", `agent name must match ${NAME.source}: ${input.name}`);
  }
  return db.transaction((): Agent => {
    db.query(
      "INSERT INTO projects (key, created_ts) VALUES (?, ?) ON CONFLICT (key) DO NOTHING",
    ).run(input.project, ts);
    const pid = projectId(db, input.project);
    const { name } = input;
    const row = db
      .query<AgentRow, [number, string, string, string, string, string]>(
        `INSERT INTO agents (project_id, name, program, model, task, created_ts) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (project_id, name) DO UPDATE SET
           program = excluded.program, model = excluded.model, task = excluded.task, retired_ts = NULL
         RETURNING *`,
      )
      .get(pid, name, input.program, input.model, input.task ?? "", ts);
    if (row === null) {
      throw new RavenError("invalid", `could not register ${name}`);
    }
    return toAgent(row);
  })();
}

export function agents(db: Database, project: string, includeRetired: boolean): Agent[] {
  return db
    .query<AgentRow, [number, number]>(
      "SELECT * FROM agents WHERE project_id = ? AND (? = 1 OR retired_ts IS NULL) ORDER BY name",
    )
    .all(projectId(db, project), includeRetired ? 1 : 0)
    .map(toAgent);
}

export function retire(db: Database, project: string, name: string, ts: string): void {
  const row = agentRow(db, projectId(db, project), project, name);
  db.query("UPDATE agents SET retired_ts = ? WHERE id = ? AND retired_ts IS NULL").run(ts, row.id);
}
