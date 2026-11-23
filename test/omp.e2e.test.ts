/**
 * Pins the omp behaviour raven's wake-ups rely on, against a real `omp --mode rpc`:
 * - native: with `mcp.notifications: true`, a `resources/updated` from the stdio `raven mcp` starts a turn;
 * - fallback: with it off, `extension/raven-wake.ts` turns the same notification into a turn.
 * Runs only with RAVEN_OMP_E2E=1 (CI's omp job, which installs the omp version it pins); there, a missing omp fails.
 */
import { afterEach, describe, expect, test as it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { serve as bunServe, type Server, type Subprocess, sleep, spawn } from "bun";
import { Store, serve } from "../src/index.ts";
import { inboxUri } from "../src/wake.ts";

const ENABLED = process.env["RAVEN_OMP_E2E"] === "1";
const PROJECT = "/e2e";
const AGENT = "Sleeper";
const CLI = resolve(import.meta.dir, "../src/cli.ts");
const EXTENSION = resolve(import.meta.dir, "../extension/raven-wake.ts");
const WAIT_MS = 60_000;

type RpcEvent = {
  type?: string;
  message?: { role?: string; content?: unknown; customType?: string };
};

/** A chat-completions endpoint that streams one fixed answer: enough for omp to finish the turn it starts. */
function fakeModel(): Server<undefined> {
  function chunk(delta: Record<string, unknown>, finish: string | null): string {
    const body = { id: "fake", object: "chat.completion.chunk", created: 0, model: "echo" };
    return `data: ${JSON.stringify({ ...body, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  }
  const answer = `${chunk({ role: "assistant", content: "WOKE" }, null)}${chunk({}, "stop")}data: [DONE]\n\n`;
  return bunServe({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Response(answer, { headers: { "content-type": "text/event-stream" } }),
  });
}

/** Parses a child's stdout lines into `events` as they arrive. */
async function collect(stdout: ReadableStream<Uint8Array>, events: RpcEvent[]): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stdout) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl = buffer.indexOf("\n");
    while (nl !== -1) {
      try {
        events.push(JSON.parse(buffer.slice(0, nl)) as RpcEvent);
      } catch {
        // Not an event line.
      }
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf("\n");
    }
  }
}

async function until(events: RpcEvent[], match: (e: RpcEvent) => boolean): Promise<RpcEvent> {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() <= deadline) {
    const hit = events.find(match);
    if (hit !== undefined) {
      return hit;
    }
    // A child's output has no event to await but its own arrival: poll what has been collected.
    await sleep(100);
  }
  throw new Error(`timed out; events seen: ${[...new Set(events.map((e) => e.type))].join(",")}`);
}

type Session = { readonly store: Store; readonly events: RpcEvent[]; stop: () => Promise<void> };

/** A raven server, a fake model, and one omp session wired to `raven mcp` as AGENT. */
async function session(options: { notifications: boolean; extension: boolean }): Promise<Session> {
  const dir = mkdtempSync(join(tmpdir(), "raven-omp-"));
  const store = new Store(join(dir, "raven.db"));
  await store.register({ project: PROJECT, name: "Queen", program: "test", model: "none" });
  await store.register({ project: PROJECT, name: AGENT, program: "omp", model: "echo" });
  const token = store.issueToken({ label: "e2e", scope: "agent", projects: [PROJECT] });
  const raven = serve({ store, port: 0, hostname: "127.0.0.1" });
  const model = fakeModel();
  const agentDir = join(dir, "agent");
  mkdirSync(agentDir);
  writeFileSync(
    join(agentDir, "models.yml"),
    [
      "providers:",
      "  fake:",
      `    baseUrl: http://127.0.0.1:${model.port}/v1`,
      "    apiKey: RAVEN_E2E_FAKE_KEY",
      "    api: openai-completions",
      "    models:",
      "      - { id: echo, name: Echo, reasoning: false, input: [text], contextWindow: 32000, maxTokens: 1024 }",
      "",
    ].join("\n"),
  );
  writeFileSync(join(agentDir, "config.yml"), `mcp:\n  notifications: ${options.notifications}\n`);
  const env = {
    RAVEN_URL: `http://127.0.0.1:${raven.port}`,
    RAVEN_TOKEN: token,
    RAVEN_PROJECT: PROJECT,
    RAVEN_AGENT: AGENT,
  };
  const mcpServers = {
    raven: { type: "stdio", command: process.execPath, args: [CLI, "mcp"], env },
  };
  writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers }));
  const work = join(dir, "work");
  mkdirSync(work);
  const flags = [
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-rules",
    "--no-context-files",
  ];
  const child: Subprocess<"pipe", "pipe", "inherit"> = spawn(
    [
      "omp",
      "--mode",
      "rpc",
      "--model",
      "fake/echo",
      "--offline",
      "--no-title",
      "--no-lsp",
      ...flags,
      ...(options.extension ? ["-e", EXTENSION] : []),
    ],
    {
      cwd: work,
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, RAVEN_E2E_FAKE_KEY: "unused" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
    },
  );
  const events: RpcEvent[] = [];
  collect(child.stdout, events).catch(() => undefined);
  return {
    store,
    events,
    async stop(): Promise<void> {
      child.kill();
      await child.exited;
      await raven.stop(true);
      await model.stop(true);
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Waits for omp, delivers one message to AGENT, and returns once the turn it starts has ended. */
async function deliverAndAwaitTurn(s: Session): Promise<void> {
  await until(s.events, (e) => e.type === "ready");
  // Before or after raven mcp subscribes, either path wakes: a live delivery, or unread mail at subscribe time.
  await s.store.send({
    project: PROJECT,
    from: "Queen",
    to: [AGENT],
    subject: "wake up",
    body: "",
  });
  await until(s.events, (e) => e.type === "agent_end");
}

describe.skipIf(!ENABLED)("omp wakes on a raven delivery", () => {
  let current: Session | undefined;

  afterEach(async () => {
    await current?.stop();
    current = undefined;
  });

  it("natively: one delivery starts one turn carrying the inbox update", async () => {
    current = await session({ notifications: true, extension: false });
    await deliverAndAwaitTurn(current);
    const injected = current.events.find(
      (e) => e.type === "message_end" && e.message?.role === "user",
    );
    expect(JSON.stringify(injected?.message?.content)).toContain("[MCP notification]");
    expect(JSON.stringify(injected?.message?.content)).toContain(inboxUri(AGENT));
    expect(current.events.filter((e) => e.type === "agent_start")).toHaveLength(1);
  }, 180_000);

  it("through the fallback extension when native injection is off", async () => {
    current = await session({ notifications: false, extension: true });
    await deliverAndAwaitTurn(current);
    const aside = current.events.find(
      (e) => e.type === "message_end" && e.message?.customType === "raven-wake",
    );
    expect(JSON.stringify(aside?.message)).toContain(inboxUri(AGENT));
    expect(current.events.filter((e) => e.type === "agent_start")).toHaveLength(1);
  }, 180_000);
});
