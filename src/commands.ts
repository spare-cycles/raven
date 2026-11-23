/** The `raven serve` and `raven token` commands; `src/cli.ts` dispatches to them. */

import process from "node:process";
import { parseArgs } from "node:util";
import { RavenError } from "./error.ts";
import { serve } from "./server.ts";
import { Store } from "./store.ts";
import type { Scope } from "./tokens.ts";

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function required(value: string | undefined, flag: string): string {
  if (value === undefined || value === "") {
    throw new RavenError("invalid", `--${flag} is required`);
  }
  return value;
}

/** Serves the database until SIGTERM or SIGINT, then closes open streams and the database. */
export function serveCommand(args: string[]): void {
  const { values } = parseArgs({
    args,
    options: {
      db: { type: "string" },
      port: { type: "string", default: "7811" },
      host: { type: "string", default: "127.0.0.1" },
    },
    strict: true,
  });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new RavenError("invalid", `--port must be a TCP port, got ${values.port}`);
  }
  const store = new Store(required(values.db, "db"));
  const server = serve({ store, port, hostname: values.host });
  out(`raven: serving ${values.db} on http://${values.host}:${server.port}`);
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
