import { afterEach, beforeEach, describe, expect, test as it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type MemoryRaven, Store } from "../src/index.ts";
import { P, refused, seeded } from "./helpers.ts";

describe("store", () => {
  let raven: MemoryRaven;

  beforeEach(async () => {
    raven = await seeded();
  });

  afterEach(() => raven.close());

  it("a retried send with the same idempotency key stores nothing and returns the first id", async () => {
    const input = {
      project: P,
      from: "Queen",
      to: ["Ana"],
      subject: "s",
      body: "",
      idempotencyKey: "k1",
    };
    const first = await raven.send(input);
    expect(await raven.send(input)).toEqual(first);
    expect(await raven.inbox({ project: P, agent: "Ana" })).toHaveLength(1);
  });

  it("an unknown or retired recipient refuses the whole send and delivers to nobody", async () => {
    const typo = raven.send({
      project: P,
      from: "Queen",
      to: ["Ana", "Typo"],
      subject: "s",
      body: "",
    });
    expect(await refused(typo)).toBe("unknown_agent");
    await raven.retire({ project: P, name: "Cy" });
    const retired = raven.send({
      project: P,
      from: "Queen",
      to: ["Ana"],
      cc: ["Cy"],
      subject: "s",
      body: "",
    });
    expect(await refused(retired)).toBe("retired_agent");
    expect(await raven.inbox({ project: P, agent: "Ana" })).toEqual([]);
  });

  it("a reply threads under the root, goes back to the sender and keeps the topic", async () => {
    const root = await raven.send({
      project: P,
      from: "Queen",
      to: ["Ana"],
      cc: ["Bo"],
      subject: "[x] do it",
      body: "",
      topic: "x",
    });
    const reply = await raven.reply({ project: P, from: "Ana", to: root.id, body: "done" });
    expect(reply.thread).toBe(root.id);
    const [inQueen] = await raven.inbox({ project: P, agent: "Queen" });
    expect(inQueen).toMatchObject({
      id: reply.id,
      subject: "Re: [x] do it",
      topic: "x",
      to: ["Queen"],
    });
    const nested = await raven.reply({ project: P, from: "Queen", to: reply.id, body: "thanks" });
    expect(nested.thread).toBe(root.id);
  });

  it("replying to your own message follows it up to its recipients", async () => {
    const root = await raven.send({
      project: P,
      from: "Queen",
      to: ["Ana"],
      cc: ["Bo"],
      subject: "s",
      body: "",
    });
    const follow = await raven.reply({ project: P, from: "Queen", to: root.id, body: "more" });
    const [ana] = await raven.inbox({ project: P, agent: "Ana", limit: 1 });
    const [bo] = await raven.inbox({ project: P, agent: "Bo", limit: 1 });
    expect(ana).toMatchObject({ id: follow.id, kind: "to" });
    expect(bo).toMatchObject({ id: follow.id, kind: "cc" });
    expect(await raven.inbox({ project: P, agent: "Queen" })).toEqual([]);
  });

  it("threadState names the last message and counts the thread", async () => {
    const root = await raven.send({
      project: P,
      from: "Queen",
      to: ["Ana"],
      subject: "s",
      body: "",
    });
    const r = await raven.reply({ project: P, from: "Ana", to: root.id, body: "" });
    expect(await raven.threadState({ project: P, thread: root.id })).toEqual({
      thread: root.id,
      count: 2,
      last: { id: r.id, from: "Ana", ts: r.ts },
    });
    expect(await refused(raven.threadState({ project: P, thread: 999 }))).toBe("unknown_thread");
  });

  it("joining a thread needs its root id", async () => {
    const root = await raven.send({
      project: P,
      from: "Queen",
      to: ["Ana"],
      subject: "s",
      body: "",
    });
    const r = await raven.reply({ project: P, from: "Ana", to: root.id, body: "" });
    const stray = raven.send({
      project: P,
      from: "Bo",
      to: ["Ana"],
      subject: "s",
      body: "",
      thread: r.id,
    });
    expect(await refused(stray)).toBe("unknown_thread");
  });

  it("inbox: unread newest first; markRead and ack touch only the caller's deliveries", async () => {
    const a = await raven.send({ project: P, from: "Queen", to: ["Ana"], subject: "a", body: "" });
    const b = await raven.send({ project: P, from: "Queen", to: ["Ana"], subject: "b", body: "" });
    const other = await raven.send({
      project: P,
      from: "Queen",
      to: ["Bo"],
      subject: "o",
      body: "",
    });
    expect((await raven.inbox({ project: P, agent: "Ana" })).map((m) => m.id)).toEqual([
      b.id,
      a.id,
    ]);
    const foreign = raven.markRead({ project: P, agent: "Ana", ids: [a.id, other.id] });
    expect(await refused(foreign)).toBe("unknown_message");
    await raven.ack({ project: P, agent: "Ana", ids: [a.id] });
    expect((await raven.inbox({ project: P, agent: "Ana" })).map((m) => m.id)).toEqual([b.id]);
    const all = await raven.inbox({ project: P, agent: "Ana", unreadOnly: false });
    expect(all.find((m) => m.id === a.id)?.ackTs).not.toBeNull();
  });

  it("inbox with markRead returns the batch once", async () => {
    await raven.send({ project: P, from: "Queen", to: ["Ana"], subject: "a", body: "" });
    const [m] = await raven.inbox({ project: P, agent: "Ana", markRead: true });
    expect(m?.readTs).not.toBeNull();
    expect(await raven.inbox({ project: P, agent: "Ana", markRead: true })).toEqual([]);
  });

  it("topic is newest first, honours since and limit", async () => {
    const ids: number[] = [];
    for (const s of ["1", "2", "3"]) {
      const sent = await raven.send({
        project: P,
        from: "Queen",
        to: ["Ana"],
        subject: s,
        body: "",
        topic: "t",
      });
      ids.push(sent.id);
    }
    await raven.send({
      project: P,
      from: "Queen",
      to: ["Ana"],
      subject: "u",
      body: "",
      topic: "u",
    });
    const all = await raven.topic({ project: P, topic: "t" });
    expect(all.map((m) => m.id)).toEqual([...ids].reverse());
    const newer = await raven.topic({ project: P, topic: "t", since: all[1]?.ts ?? "" });
    expect(newer.map((m) => m.id)).toEqual(ids.slice(2));
    const latest = await raven.topic({ project: P, topic: "t", limit: 1 });
    expect(latest.map((m) => m.id)).toEqual(ids.slice(2));
    expect(await refused(raven.topic({ project: P, topic: "t", since: "yesterday" }))).toBe(
      "invalid",
    );
  });

  it("register picks a free name, retire hides the agent, registering again restores it", async () => {
    const named = await raven.register({ project: P, program: "omp", model: "m" });
    expect(named.name).toMatch(/^[A-Z][a-z]+[A-Z][a-z]+\d*$/u);
    await raven.retire({ project: P, name: "Bo" });
    expect((await raven.agents({ project: P })).map((a) => a.name)).not.toContain("Bo");
    await raven.register({ project: P, name: "Bo", program: "omp", model: "m2" });
    const bo = (await raven.agents({ project: P })).find((a) => a.name === "Bo");
    expect(bo?.model).toBe("m2");
  });

  it("an unknown project is refused rather than read as empty", async () => {
    expect(await refused(raven.agents({ project: "/nope" }))).toBe("unknown_project");
  });
});

describe("durability", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "raven-"));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("a resolved send survives reopening the database, and ids keep growing", async () => {
    const path = join(dir, "raven.db");
    const first = new Store(path);
    await first.register({ project: P, name: "Queen", program: "omp", model: "m" });
    await first.register({ project: P, name: "Ana", program: "omp", model: "m" });
    const sent = await first.send({
      project: P,
      from: "Queen",
      to: ["Ana"],
      subject: "s",
      body: "kept",
    });
    first.close();
    const second = new Store(path);
    const [m] = await second.inbox({ project: P, agent: "Ana" });
    expect(m).toMatchObject({ id: sent.id, body: "kept" });
    const next = await second.send({
      project: P,
      from: "Queen",
      to: ["Ana"],
      subject: "s",
      body: "",
    });
    expect(next.id).toBeGreaterThan(sent.id);
    second.close();
  });
});
