import { afterEach, beforeEach, describe, expect, test as it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/index.ts";
import type { ImportRecord } from "../src/transfer.ts";
import { P, refused } from "./helpers.ts";

const HISTORY: ImportRecord[] = [
  {
    project: P,
    ref: "am-1",
    from: "Queen",
    to: ["Ana"],
    subject: "[x] do it",
    body: "please",
    topic: "x",
    ts: "2026-11-20T08:00:00Z",
  },
  {
    project: P,
    ref: "am-2",
    from: "Ana",
    to: ["Queen"],
    cc: ["Bo"],
    subject: "Re: [x] do it",
    body: "done",
    topic: "x",
    ts: "2026-11-20T09:00:00+01:00",
    replyTo: "am-1",
  },
];

describe("transfer", () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "raven-transfer-"));
    store = new Store(join(dir, "raven.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("import keeps time, thread and topic, registers who it names, and arrives already read", async () => {
    expect(store.importMessages(HISTORY)).toEqual({ imported: 2, skipped: 0 });
    const topic = await store.topic({ project: P, topic: "x" });
    expect(topic.map((m) => [m.from, m.ts])).toEqual([
      ["Ana", "2026-11-20T08:00:00.000Z"],
      ["Queen", "2026-11-20T08:00:00.000Z"],
    ]);
    const [reply, root] = topic;
    if (reply === undefined || root === undefined) {
      throw new Error("expected two messages");
    }
    expect(reply.thread).toBe(root.id);
    expect(reply.cc).toEqual(["Bo"]);
    expect((await store.agents({ project: P })).map((a) => a.name)).toEqual(["Ana", "Bo", "Queen"]);
    expect(await store.inbox({ project: P, agent: "Queen" })).toEqual([]);
    const live = await store.reply({ project: P, from: "Queen", to: reply.id, body: "thanks" });
    expect(live.thread).toBe(root.id);
  });

  it("re-importing the same refs is a no-op", () => {
    store.importMessages(HISTORY);
    expect(store.importMessages(HISTORY)).toEqual({ imported: 0, skipped: 2 });
  });

  it("a reply to a ref not imported yet refuses the whole batch", async () => {
    const [root, reply] = HISTORY;
    if (root === undefined || reply === undefined) {
      throw new Error("fixture");
    }
    expect(() => store.importMessages([reply, root])).toThrow("replyTo am-1");
    expect(await refused(store.agents({ project: P }))).toBe("unknown_project");
  });

  it("export replays every message oldest first, and a snapshot holds the same data", () => {
    store.importMessages(HISTORY);
    const exported = [...store.exportMessages()];
    expect(exported.map((m) => m.body)).toEqual(["please", "done"]);
    const copy = join(dir, "copy.db");
    store.snapshot(copy);
    const reopened = new Store(copy);
    expect([...reopened.exportMessages(P)]).toEqual(exported);
    reopened.close();
  });
});
