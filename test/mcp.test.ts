import { afterEach, beforeEach, describe, expect, test as it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ResourceUpdatedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { MemoryRaven } from "../src/index.ts";
import { createMcpServer, type RavenMcp } from "../src/mcp.ts";
import { inboxUri } from "../src/wake.ts";
import { P, seeded } from "./helpers.ts";

/** An MCP client wired to a raven mcp server in process, queueing the URIs of resource updates as they arrive. */
async function connect(
  raven: MemoryRaven,
  agent: string,
): Promise<{ client: Client; mcp: RavenMcp; updates: () => Promise<string> }> {
  const mcp = createMcpServer({ raven, project: P, agent });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  const queued: string[] = [];
  let waiting: ((uri: string) => void) | undefined;
  client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => {
    if (waiting === undefined) {
      queued.push(n.params.uri);
    } else {
      waiting(n.params.uri);
      waiting = undefined;
    }
  });
  await mcp.server.connect(serverSide);
  await client.connect(clientSide);
  /** The next update's URI, already arrived or yet to come. */
  function updates(): Promise<string> {
    const first = queued.shift();
    if (first !== undefined) {
      return Promise.resolve(first);
    }
    const { promise, resolve } = Promise.withResolvers<string>();
    waiting = resolve;
    return promise;
  }
  return { client, mcp, updates };
}

function textOf(r: Awaited<ReturnType<Client["callTool"]>>): unknown {
  const [first] = r.content as { type: string; text: string }[];
  return JSON.parse(first?.text ?? "null");
}

describe("raven mcp", () => {
  let raven: MemoryRaven;

  beforeEach(async () => {
    raven = await seeded();
  });

  afterEach(() => raven.close());

  it("a delivery to the session's agent becomes a resources/updated on its inbox", async () => {
    const { client, mcp, updates } = await connect(raven, "Ana");
    await client.subscribeResource({ uri: inboxUri("Ana") });
    await raven.send({ project: P, from: "Queen", to: ["Bo"], subject: "not Ana's", body: "" });
    await raven.send({ project: P, from: "Queen", to: ["Ana"], subject: "yours", body: "" });
    expect(await updates()).toBe(inboxUri("Ana"));
    const read = await client.readResource({ uri: inboxUri("Ana") });
    const [content] = read.contents as { text: string }[];
    expect(
      (JSON.parse(content?.text ?? "[]") as { subject: string }[]).map((m) => m.subject),
    ).toEqual(["yours"]);
    mcp.close();
  });

  it("mail waiting before the session subscribed wakes it on subscribe", async () => {
    await raven.send({ project: P, from: "Queen", to: ["Ana"], subject: "while away", body: "" });
    const { client, mcp, updates } = await connect(raven, "Ana");
    await client.subscribeResource({ uri: inboxUri("Ana") });
    expect(await updates()).toBe(inboxUri("Ana"));
    mcp.close();
  });

  it("an agent registered after start gets its wake-ups from the registration on", async () => {
    const { client, mcp, updates } = await connect(raven, "Newcomer");
    await client.subscribeResource({ uri: inboxUri("Newcomer") });
    const reg = await client.callTool({
      name: "register_agent",
      arguments: { name: "Newcomer", program: "omp", model: "m" },
    });
    expect(reg.isError).toBeFalsy();
    await raven.send({ project: P, from: "Queen", to: ["Newcomer"], subject: "welcome", body: "" });
    expect(await updates()).toBe(inboxUri("Newcomer"));
    mcp.close();
  });

  it("tools speak Agent Mail's shapes and default to the session's project and agent", async () => {
    const { client, mcp } = await connect(raven, "Ana");
    const sent = textOf(
      await client.callTool({
        name: "send_message",
        arguments: { to: ["Bo"], subject: "[t] hi", body_md: "body", topic: "t" },
      }),
    ) as { id: number; thread_id: number };
    expect(sent.thread_id).toBe(sent.id);
    const reply = await raven.reply({ project: P, from: "Bo", to: sent.id, body: "back" });
    const inbox = textOf(
      await client.callTool({ name: "fetch_inbox", arguments: { include_bodies: true } }),
    ) as Record<string, unknown>[];
    expect(inbox).toEqual([
      expect.objectContaining({
        id: reply.id,
        from: "Bo",
        body_md: "back",
        thread_id: sent.id,
        topic: "t",
      }),
    ]);
    const again = textOf(await client.callTool({ name: "fetch_inbox", arguments: {} }));
    expect(again).toEqual([]);
    const topic = textOf(
      await client.callTool({ name: "fetch_topic", arguments: { topic_name: "t" } }),
    ) as { id: number }[];
    expect(topic.map((m) => m.id)).toEqual([reply.id, sent.id]);
    mcp.close();
  });

  it("a refusal is a tool error carrying raven's code; register_agent without a name gets one", async () => {
    const { client, mcp } = await connect(raven, "Ana");
    const typo = await client.callTool({
      name: "send_message",
      arguments: { to: ["Typo"], subject: "s", body_md: "" },
    });
    expect(typo.isError).toBe(true);
    expect(textOf(typo)).toEqual({ error: expect.objectContaining({ code: "unknown_agent" }) });
    const nameless = await client.callTool({
      name: "register_agent",
      arguments: { program: "omp", model: "m" },
    });
    expect(nameless.isError).toBeFalsy();
    const { name } = textOf(nameless) as { name: string };
    expect((await raven.agents({ project: P })).map((a) => a.name)).toContain(name);
    mcp.close();
  });
});
