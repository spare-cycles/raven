/** raven over HTTP: `POST /v1/rpc`, `GET /v1/stream` (SSE), `GET /healthz`. Every route but the healthcheck needs a token. */
import { serve as bunServe, type Server } from "bun";
import { RavenError } from "./error.ts";
import type { Store } from "./store.ts";
import type { Grant } from "./tokens.ts";
import type { Delivery } from "./types.ts";
import { RPC, type RpcMethod, rpcRequest, STATUS } from "./wire.ts";

export type ServeOptions = {
  readonly store: Store;
  /** 0 picks a free port. */
  readonly port: number;
  readonly hostname: string;
  /** SSE comment interval that keeps idle streams alive through proxies; 25 s by default. */
  readonly heartbeatMs?: number;
};

/** What a token's scope must be for each method; everything else is open to `agent` tokens. */
const ADMIN_ONLY: Record<string, true> = { retire: true };

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function refusal(e: unknown): Response {
  if (e instanceof RavenError) {
    return json({ error: { code: e.code, message: e.message } }, STATUS[e.code]);
  }
  const message = e instanceof Error ? e.message : String(e);
  return json({ error: { code: "unavailable", message } }, STATUS.unavailable);
}

function grantOf(store: Store, req: Request): Grant {
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  const grant = token === "" ? null : store.authorize(token);
  if (grant === null) {
    throw new RavenError("unauthorized", "a valid bearer token is required");
  }
  return grant;
}

function allow(grant: Grant, project: string, admin: boolean): void {
  if (grant.projects !== "*" && !grant.projects.includes(project)) {
    throw new RavenError("forbidden", `token ${grant.label} does not cover project ${project}`);
  }
  if (admin && grant.scope !== "admin") {
    throw new RavenError("forbidden", `token ${grant.label} is not an admin token`);
  }
}

async function rpc(store: Store, req: Request): Promise<Response> {
  const grant = grantOf(store, req);
  const envelope = rpcRequest.safeParse(await req.json().catch(() => null));
  if (!envelope.success) {
    throw new RavenError("invalid", "the body must be { method, params }");
  }
  const { method } = envelope.data;
  if (!Object.hasOwn(RPC, method)) {
    throw new RavenError("invalid", `unknown method ${method}`);
  }
  const schema = RPC[method as RpcMethod];
  const params = schema.safeParse(envelope.data.params);
  if (!params.success) {
    throw new RavenError("invalid", `${method}: ${params.error.message}`);
  }
  allow(grant, params.data.project, Object.hasOwn(ADMIN_ONLY, method));
  const call = store[method as RpcMethod] as (p: unknown) => Promise<unknown>;
  const result = await call.call(store, params.data);
  return json({ result: result ?? null });
}

function frame(d: Delivery): string {
  return `id: ${d.cursor}\nevent: delivery\ndata: ${JSON.stringify(d)}\n\n`;
}

function stream(store: Store, req: Request, heartbeatMs: number): Response {
  const grant = grantOf(store, req);
  const url = new URL(req.url);
  const project = url.searchParams.get("project") ?? "";
  const agent = url.searchParams.get("agent") ?? undefined;
  const after = Number(req.headers.get("last-event-id") ?? url.searchParams.get("after") ?? "0");
  if (project === "" || !Number.isInteger(after) || after < 0) {
    throw new RavenError("invalid", "stream needs ?project= and a non-negative integer cursor");
  }
  allow(grant, project, agent === undefined);
  store.checkStream({ project, ...(agent === undefined ? {} : { agent }) });
  const stop = new AbortController();
  const encoder = new TextEncoder();
  const deliveries = store.stream({
    project,
    after,
    signal: stop.signal,
    ...(agent === undefined ? {} : { agent }),
  });
  const body = new ReadableStream<Uint8Array>({
    start(controller): void {
      function send(text: string): void {
        controller.enqueue(encoder.encode(text));
      }
      send("retry: 1000\n\n");
      const heartbeat = setInterval(() => send(": ping\n\n"), heartbeatMs);
      // The pump runs detached: start() must return for the response to begin flowing.
      async function pump(): Promise<void> {
        try {
          for await (const d of deliveries) {
            if (stop.signal.aborted) {
              break;
            }
            send(frame(d));
          }
        } finally {
          clearInterval(heartbeat);
          // A cancelled stream is already closed by its reader; one ended by the store closing is closed here.
          if (!stop.signal.aborted) {
            controller.close();
          }
        }
      }
      pump().catch(() => stop.abort());
    },
    cancel(): void {
      stop.abort();
    },
  });
  return new Response(body, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
  });
}

/** Starts the server; `stop(true)` on the result closes open streams too. */
export function serve(options: ServeOptions): Server<undefined> {
  const { store } = options;
  const heartbeatMs = options.heartbeatMs ?? 25_000;
  return bunServe({
    port: options.port,
    hostname: options.hostname,
    async fetch(req, server): Promise<Response> {
      const { pathname } = new URL(req.url);
      try {
        if (req.method === "GET" && pathname === "/healthz") {
          return new Response("ok");
        }
        if (req.method === "POST" && pathname === "/v1/rpc") {
          return await rpc(store, req);
        }
        if (req.method === "GET" && pathname === "/v1/stream") {
          // A stream stays open between deliveries; the heartbeat, not Bun's idle timer, keeps it honest.
          server.timeout(req, 0);
          return stream(store, req, heartbeatMs);
        }
        return json(
          { error: { code: "invalid", message: `no route ${req.method} ${pathname}` } },
          404,
        );
      } catch (e) {
        return refusal(e);
      }
    },
  });
}
