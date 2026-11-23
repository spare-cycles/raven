import { afterEach, beforeEach, describe, expect, test as it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, type Raven, Store, serve } from "../src/index.ts";
import { P, refused, take } from "./helpers.ts";

const FAST = { min: 20, max: 100 };

describe("http", () => {
  let dir: string;
  let store: Store;
  let server: ReturnType<typeof serve>;
  let url: string;
  let admin: string;
  let agentToken: string;
  let client: Raven;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "raven-http-"));
    store = new Store(join(dir, "raven.db"));
    for (const name of ["Queen", "Ana", "Bo"]) {
      await store.register({ project: P, name, program: "omp", model: "m" });
    }
    await store.register({ project: "/other", name: "Zed", program: "omp", model: "m" });
    admin = store.issueToken({ label: "realmd", scope: "admin", projects: [P] });
    agentToken = store.issueToken({ label: "agents", scope: "agent", projects: [P] });
    server = serve({ store, port: 0, hostname: "127.0.0.1", heartbeatMs: 50 });
    url = `http://127.0.0.1:${server.port}`;
    client = createClient({ url, token: agentToken, retry: FAST });
  });

  afterEach(async () => {
    await server.stop(true);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("the client speaks the store's contract: results and refusal codes", async () => {
    const sent = await client.send({
      project: P,
      from: "Queen",
      to: ["Ana"],
      subject: "s",
      body: "b",
    });
    const [m] = await client.inbox({ project: P, agent: "Ana" });
    expect(m).toMatchObject({ id: sent.id, from: "Queen", body: "b", readTs: null });
    await client.ack({ project: P, agent: "Ana", ids: [sent.id] });
    expect(await client.inbox({ project: P, agent: "Ana" })).toEqual([]);
    const typo = client.send({ project: P, from: "Queen", to: ["Typo"], subject: "s", body: "" });
    expect(await refused(typo)).toBe("unknown_agent");
  });

  it("malformed params are refused as invalid before reaching the store", async () => {
    const empty = client.send({ project: P, from: "Queen", to: [], subject: "s", body: "" });
    expect(await refused(empty)).toBe("invalid");
    const res = await fetch(`${url}/v1/rpc`, {
      method: "POST",
      headers: { authorization: `Bearer ${agentToken}` },
      body: JSON.stringify({ method: "drop_tables", params: {} }),
    });
    expect(res.status).toBe(400);
  });

  it("tokens: none, revoked, another project, or agent scope where admin is needed are refused", async () => {
    const anonymous = createClient({ url, token: "", retry: FAST });
    expect(await refused(anonymous.agents({ project: P }))).toBe("unauthorized");
    expect(await refused(client.agents({ project: "/other" }))).toBe("forbidden");
    expect(await refused(client.retire({ project: P, name: "Bo" }))).toBe("forbidden");
    await createClient({ url, token: admin }).retire({ project: P, name: "Bo" });
    store.revokeToken("agents");
    expect(await refused(client.agents({ project: P }))).toBe("unauthorized");
  });

  it("the firehose needs an admin token, and a refused stream throws instead of retrying", async () => {
    const firehose = take(client.stream({ project: P, after: 0 }), 1);
    expect(await refused(firehose)).toBe("forbidden");
    const sent = await client.send({
      project: P,
      from: "Queen",
      to: ["Ana"],
      subject: "s",
      body: "",
    });
    const [d] = await take(createClient({ url, token: admin }).stream({ project: P, after: 0 }), 1);
    expect(d?.cursor).toBe(sent.id);
  });

  it("an open stream receives a send pushed after it connected", async () => {
    const pending = take(client.stream({ project: P, agent: "Bo", after: 0 }), 1);
    const sent = await client.send({
      project: P,
      from: "Ana",
      to: ["Bo"],
      subject: "live",
      body: "",
    });
    const [d] = await pending;
    expect(d).toMatchObject({ cursor: sent.id, message: { subject: "live", from: "Ana" } });
  });

  it("a server restart costs no delivery and repeats none: the stream resumes from its cursor", async () => {
    const seen: number[] = [];
    const first = await client.send({
      project: P,
      from: "Queen",
      to: ["Ana"],
      subject: "1",
      body: "",
    });
    const { port } = server;
    if (port === undefined) {
      throw new Error("the server has no TCP port");
    }
    let second = 0;
    for await (const d of client.stream({ project: P, agent: "Ana", after: 0 })) {
      seen.push(d.cursor);
      if (seen.length === 1) {
        await server.stop(true);
        second = (
          await store.send({ project: P, from: "Queen", to: ["Ana"], subject: "2", body: "" })
        ).id;
        server = serve({ store, port, hostname: "127.0.0.1", heartbeatMs: 50 });
      }
      if (seen.length === 2) {
        break;
      }
    }
    expect(seen).toEqual([first.id, second]);
  });

  it("an idle stream carries heartbeats", async () => {
    const res = await fetch(`${url}/v1/stream?project=${encodeURIComponent(P)}&agent=Ana`, {
      headers: { authorization: `Bearer ${agentToken}` },
    });
    const reader = res.body?.getReader();
    let text = "";
    while (reader !== undefined && !text.includes(": ping")) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      text += new TextDecoder().decode(value);
    }
    await reader?.cancel();
    expect(text).toContain(": ping");
  });
});
