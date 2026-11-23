/** The `raven` subcommands other than `mcp`; `src/cli.ts` dispatches to them. */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { RavenError } from "./error.ts";
import { serve } from "./server.ts";
import { Store } from "./store.ts";
import type { Scope } from "./tokens.ts";
import { type ImportRecord, importRecord } from "./transfer.ts";

const SNAPSHOT = /^raven-\d{4}-\d{2}-\d{2}\.db$/u;
const HOUR_MS = 3_600_000;

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function required(value: string | undefined, flag: string): string {
  if (value === undefined || value === "") {
    throw new RavenError("invalid", `--${flag} is required`);
  }
  return value;
}

/**
 * One snapshot per UTC day in `dir` (`raven-YYYY-MM-DD.db`), checked hourly, keeping the newest `keep`. A failed
 * snapshot is reported and retried at the next check; it never stops the server.
 */
function scheduleSnapshots(store: Store, dir: string, keep: number): void {
  mkdirSync(dir, { recursive: true });
  function take(): void {
    const path = join(dir, `raven-${new Date().toISOString().slice(0, 10)}.db`);
    try {
      if (!existsSync(path)) {
        store.snapshot(path);
      }
      const old = readdirSync(dir)
        .filter((f) => SNAPSHOT.test(f))
        .sort()
        .slice(0, -keep);
      for (const f of old) {
        rmSync(join(dir, f));
      }
    } catch (e) {
      process.stderr.write(
        `raven: snapshot failed: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
  }
  take();
  setInterval(take, HOUR_MS);
}

/** Serves the database until SIGTERM or SIGINT, then closes open streams and the database. */
export function serveCommand(args: string[]): void {
  const { values } = parseArgs({
    args,
    options: {
      db: { type: "string" },
      port: { type: "string", default: "7811" },
      host: { type: "string", default: "127.0.0.1" },
      "snapshot-dir": { type: "string" },
      keep: { type: "string", default: "7" },
    },
    strict: true,
  });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new RavenError("invalid", `--port must be a TCP port, got ${values.port}`);
  }
  const keep = Number(values.keep);
  if (!Number.isInteger(keep) || keep < 1) {
    throw new RavenError("invalid", `--keep must be a positive integer, got ${values.keep}`);
  }
  const store = new Store(required(values.db, "db"));
  const server = serve({ store, port, hostname: values.host });
  out(`raven: serving ${values.db} on http://${values.host}:${server.port}`);
  if (values["snapshot-dir"] !== undefined) {
    scheduleSnapshots(store, values["snapshot-dir"], keep);
  }
  async function shutdown(): Promise<void> {
    await server.stop(true);
    store.close();
    process.exit(0);
  }
  process.once("SIGTERM", () => {
    shutdown().catch(() => process.exit(1));
  });
  process.once("SIGINT", () => {
    shutdown().catch(() => process.exit(1));
  });
}

const SCOPES: Record<string, Scope> = { agent: "agent", admin: "admin" };

/** `create` prints the new token, the only copy; `list` prints one JSON line per token; `revoke` prints nothing. */
export function tokenCommand(args: string[]): void {
  const { values, positionals } = parseArgs({
    args,
    options: {
      db: { type: "string" },
      label: { type: "string" },
      scope: { type: "string", default: "agent" },
      project: { type: "string", multiple: true },
      "all-projects": { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: true,
  });
  const store = new Store(required(values.db, "db"));
  try {
    const [action] = positionals;
    if (action === "create") {
      const scope = SCOPES[values.scope];
      if (scope === undefined) {
        throw new RavenError("invalid", `--scope must be agent or admin, got ${values.scope}`);
      }
      const projects = values["all-projects"] ? "*" : (values.project ?? []);
      out(store.issueToken({ label: required(values.label, "label"), scope, projects }));
    } else if (action === "revoke") {
      store.revokeToken(required(values.label, "label"));
    } else if (action === "list") {
      for (const t of store.listTokens()) {
        out(JSON.stringify(t));
      }
    } else {
      throw new RavenError("invalid", "usage: raven token create|revoke|list --db <path> …");
    }
  } finally {
    store.close();
  }
}

/** Parses `--db` plus the named string flags, opens the store, runs, closes. */
function withStore<T>(
  args: string[],
  flags: readonly string[],
  run: (store: Store, values: Record<string, string | undefined>) => T,
): T {
  const options = Object.fromEntries(["db", ...flags].map((f) => [f, { type: "string" as const }]));
  const { values } = parseArgs({ args, options, strict: true });
  const strings: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(values)) {
    strings[k] = typeof v === "string" ? v : undefined;
  }
  const store = new Store(required(strings["db"], "db"));
  try {
    return run(store, strings);
  } finally {
    store.close();
  }
}

/** One JSON line per message, oldest first, to stdout. */
export function exportCommand(args: string[]): void {
  withStore(args, ["project"], (store, values) => {
    const project = values["project"];
    for (const m of store.exportMessages(project)) {
      out(JSON.stringify(m));
    }
  });
}

/** Reads `ImportRecord` JSON lines from `--file` (or stdin with `-`), all validated before any is written. */
export function importCommand(args: string[]): void {
  withStore(args, ["file"], (store, values) => {
    const file = required(values["file"], "file");
    const text = readFileSync(file === "-" ? 0 : file, "utf8");
    const records: ImportRecord[] = [];
    const lines = text.split("\n").map((line, i) => ({ line, n: i + 1 }));
    for (const { line, n } of lines.filter((l) => l.line.trim() !== "")) {
      const parsed = importRecord.safeParse(JSON.parse(line));
      if (!parsed.success) {
        throw new RavenError("invalid", `line ${n}: ${parsed.error.message}`);
      }
      records.push(parsed.data);
    }
    out(JSON.stringify(store.importMessages(records)));
  });
}

/** A one-off consistent copy of the database. */
export function snapshotCommand(args: string[]): void {
  withStore(args, ["out"], (store, values) => {
    store.snapshot(required(values["out"], "out"));
  });
}
