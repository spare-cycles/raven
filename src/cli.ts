#!/usr/bin/env bun
import process from "node:process";
/** `raven <command>`. */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createClient } from "./client.ts";
import { serveCommand, tokenCommand } from "./commands.ts";
import { mcpEnv } from "./env.ts";
import { createMcpServer } from "./mcp.ts";

const USAGE = `usage: raven <command>

  serve  --db <path> [--port 7811] [--host 127.0.0.1]
         The HTTP server over a SQLite file (created when missing).
  token  create --db <path> --label <l> [--scope agent|admin] (--project <key>… | --all-projects)
         token revoke --db <path> --label <l>
         token list --db <path>
  mcp    stdio MCP server for one agent session. Reads RAVEN_URL, RAVEN_TOKEN, and optionally
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
    case "mcp":
      await mcp();
      break;
    default:
      fail(USAGE);
  }
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}
