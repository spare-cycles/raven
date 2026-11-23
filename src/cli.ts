#!/usr/bin/env bun
import process from "node:process";
/** `raven <command>`. */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createClient } from "./client.ts";
import {
  configCommand,
  exportCommand,
  importCommand,
  serveCommand,
  snapshotCommand,
  tokenCommand,
} from "./commands.ts";
import { mcpEnv } from "./env.ts";
import { createMcpServer } from "./mcp.ts";

const USAGE = `usage: raven <command>

  serve     --db <path> [--port 7811] [--host 127.0.0.1] [--snapshot-dir <dir> [--keep 7]]
            The HTTP server over a SQLite file (created when missing); with --snapshot-dir, one
            snapshot per day, the newest --keep kept.
  token     create --db <path> --label <l> [--scope agent|admin] (--project <key>… | --all-projects)
            token revoke --db <path> --label <l>
            token list --db <path>
  config    get --db <path> names.nouns|names.adjectives
            set --db <path> names.nouns|names.adjectives --value "A, B, …"   (empty restores the default)
  export    --db <path> [--project <key>]       one JSON line per message, oldest first
  import    --db <path> --file <jsonl|->         history from another system (see README)
  snapshot  --db <path> --out <file>             a consistent copy, safe while serving
  mcp       stdio MCP server for one agent session. Reads RAVEN_URL, RAVEN_TOKEN, and optionally
            RAVEN_PROJECT and RAVEN_AGENT (the identity whose deliveries wake the session).
`;

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

async function mcp(): Promise<void> {
  const env = mcpEnv();
  const raven = createClient({ url: env.url, token: env.token });
  const { server, close } = createMcpServer({
    raven,
    project: env.project,
    agent: env.agent,
    log: (line) => process.stderr.write(`${line}\n`),
  });
  const transport = new StdioServerTransport();
  transport.onclose = (): void => {
    close();
    process.exit(0);
  };
  await server.connect(transport);
}

const [command, ...rest] = process.argv.slice(2);
try {
  switch (command) {
    case "serve":
      serveCommand(rest);
      break;
    case "token":
      tokenCommand(rest);
      break;
    case "config":
      configCommand(rest);
      break;
    case "export":
      exportCommand(rest);
      break;
    case "import":
      importCommand(rest);
      break;
    case "snapshot":
      snapshotCommand(rest);
      break;
    case "mcp":
      await mcp();
      break;
    default:
      fail(USAGE);
  }
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}
