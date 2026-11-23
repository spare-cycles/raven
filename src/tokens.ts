/** Bearer tokens: minted once, stored as a SHA-256, checked on every request. */
import type { Database } from "bun:sqlite";
import { CryptoHasher } from "bun";
import { RavenError } from "./error.ts";

/**
 * `agent` acts as any agent of its projects: messaging, reads, registering itself. `admin` adds the project
 * firehose and retiring agents.
 */
export type Scope = "agent" | "admin";

/** What a valid token may do; `projects` is `"*"` for every project. */
export type Grant = {
  readonly label: string;
  readonly scope: Scope;
  readonly projects: readonly string[] | "*";
};

export type TokenInput = {
  readonly label: string;
  readonly scope: Scope;
  /** Project keys, or `"*"`. */
  readonly projects: readonly string[] | "*";
};

const PREFIX = "rvn_";

function digest(token: string): string {
  return new CryptoHasher("sha256").update(token).digest("hex");
}

/** Mints a token and returns it; only its hash is kept, so this is the one time it can be read. */
export function issueToken(db: Database, input: TokenInput, ts: string): string {
  if (input.label.length === 0) {
    throw new RavenError("invalid", "a token needs a label");
  }
  if (input.projects !== "*" && input.projects.length === 0) {
    throw new RavenError("invalid", 'a token needs at least one project, or "*"');
  }
  const token = `${PREFIX}${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`;
  const taken = db.query("SELECT 1 FROM tokens WHERE label = ?").get(input.label);
  if (taken !== null) {
    throw new RavenError("invalid", `a token labelled ${input.label} already exists`);
  }
  db.query(
    "INSERT INTO tokens (label, hash, scope, projects_json, created_ts) VALUES (?, ?, ?, ?, ?)",
  ).run(
    input.label,
    digest(token),
    input.scope,
    JSON.stringify(input.projects === "*" ? ["*"] : input.projects),
    ts,
  );
  return token;
}

/** The grant of a live token; null for an unknown or revoked one. */
export function authorize(db: Database, token: string): Grant | null {
  if (!token.startsWith(PREFIX)) {
    return null;
  }
  const row = db
    .query<{ label: string; scope: Scope; projects_json: string }, [string]>(
      "SELECT label, scope, projects_json FROM tokens WHERE hash = ? AND revoked_ts IS NULL",
    )
    .get(digest(token));
  if (row === null) {
    return null;
  }
  const projects = JSON.parse(row.projects_json) as string[];
  return { label: row.label, scope: row.scope, projects: projects.includes("*") ? "*" : projects };
}

export function revokeToken(db: Database, label: string, ts: string): void {
  const changed = db
    .query("UPDATE tokens SET revoked_ts = ? WHERE label = ? AND revoked_ts IS NULL")
    .run(ts, label).changes;
  if (changed === 0) {
    throw new RavenError("invalid", `no live token labelled ${label}`);
  }
}
