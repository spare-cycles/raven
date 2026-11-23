/**
 * `raven mcp`: the tools, plus push for the session's own agent. An MCP client that injects resource updates (omp
 * with `mcp.notifications: true`) starts a turn from each delivery; `extension/raven-wake.ts` covers clients that
 * do not. A session with no agent identity gets an empty server: one entry in a shared `mcp.json` must not hand
 * messaging tools to sessions that are not raven agents.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { registerTools } from "./mcp-tools.ts";
import type { Raven } from "./types.ts";
import { Waker, type WakeTarget } from "./wake.ts";

const SERVER_INFO = { name: "raven", version: "0.1.0" };

export type McpOptions = {
  readonly raven: Raven;
  readonly project: string | undefined;
  /** The identity this process acts and wakes for; without it the server lists no tools and no resources. */
  readonly agent: string | undefined;
  /** Where a stream failure that stops the wake-ups is reported; stderr in the CLI. */
  readonly log?: (line: string) => void;
};

export type RavenMcp = {
  readonly server: McpServer;
  /** Stops the wake-up stream; the caller closes the transport. */
  readonly close: () => void;
};

function wireWaker(server: McpServer, raven: Raven, waker: Waker, target: WakeTarget): void {
  server.registerResource(
    "inbox",
    waker.uri,
    {
      description: `Unread messages for ${target.agent}; reading does not mark them read`,
      mimeType: "application/json",
    },
    async (uri) => {
      const rows = await raven.inbox(target);
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(rows) }],
      };
    },
  );
  // Mail waiting when a session connects wakes it: at initialization (fallback) and on subscribe (native).
  server.server.oninitialized = (): void => {
    waker
      .unread()
      .then((waiting) => (waiting ? waker.announce() : undefined))
      .catch(() => undefined);
  };
  server.server.setRequestHandler(SubscribeRequestSchema, async (req) => {
    waker.subscribe(req.params.uri);
    if (req.params.uri === waker.uri && (await waker.unread())) {
      setTimeout(() => waker.notify(), 0);
    }
    return {};
  });
  server.server.setRequestHandler(UnsubscribeRequestSchema, (req) => {
    waker.unsubscribe(req.params.uri);
    return {};
  });
}

/** Initializes like any server, then lists nothing: no tool to call, no resource to read or subscribe to. */
function emptyServer(): RavenMcp {
  const server = new McpServer(SERVER_INFO, { capabilities: { tools: {}, resources: {} } });
  server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));
  server.server.setRequestHandler(ListResourcesRequestSchema, () => ({ resources: [] }));
  return { server, close: (): void => undefined };
}

export function createMcpServer(options: McpOptions): RavenMcp {
  const { raven, project, agent } = options;
  if (agent === undefined) {
    return emptyServer();
  }
  const server = new McpServer(SERVER_INFO, {
    capabilities: { resources: { subscribe: true, listChanged: false } },
  });
  const target = project === undefined ? null : { project, agent };
  const waker =
    target === null
      ? null
      : new Waker(server, raven, target, options.log ?? ((): void => undefined));
  if (waker !== null && target !== null) {
    wireWaker(server, raven, waker, target);
  }
  registerTools(server, raven, { project, agent }, (name) => {
    if (name === agent) {
      waker?.watch().catch(() => undefined);
    }
  });
  waker?.watch().catch(() => undefined);
  return { server, close: () => waker?.close() };
}
