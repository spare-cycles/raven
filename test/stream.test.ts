import { afterEach, beforeEach, describe, expect, test as it } from "bun:test";
import type { MemoryRaven } from "../src/index.ts";
import { P, seeded, take } from "./helpers.ts";

describe("stream", () => {
  let raven: MemoryRaven;

  beforeEach(async () => {
    raven = await seeded();
  });

  afterEach(() => raven.close());

  it("a recipient's stream is FIFO and skips messages not addressed to it", async () => {
    const a = await raven.send({ project: P, from: "Queen", to: ["Ana"], subject: "1", body: "" });
    await raven.send({ project: P, from: "Queen", to: ["Bo"], subject: "not Ana's", body: "" });
    const c = await raven.send({
      project: P,
      from: "Bo",
      to: ["Cy"],
      cc: ["Ana"],
      subject: "3",
      body: "",
    });
    const got = await take(raven.stream({ project: P, agent: "Ana", after: 0 }), 2);
    expect(got.map((d) => d.cursor)).toEqual([a.id, c.id]);
    expect(got.map((d) => d.message.subject)).toEqual(["1", "3"]);
  });

  it("a stream resumed from a cursor replays exactly what came after it", async () => {
    const ids: number[] = [];
    for (const s of ["1", "2", "3"]) {
      ids.push(
        (await raven.send({ project: P, from: "Queen", to: ["Ana"], subject: s, body: "" })).id,
      );
    }
    const [first] = await take(raven.stream({ project: P, agent: "Ana", after: 0 }), 1);
    const rest = await take(
      raven.stream({ project: P, agent: "Ana", after: first?.cursor ?? -1 }),
      2,
    );
    expect(rest.map((d) => d.cursor)).toEqual(ids.slice(1));
  });

  it("an open stream receives a send made after it started waiting", async () => {
    // The generator runs synchronously up to its wait, so the waiter exists before `send` below.
    const pending = take(raven.stream({ project: P, agent: "Bo", after: 0 }), 1);
    const sent = await raven.send({
      project: P,
      from: "Ana",
      to: ["Bo"],
      subject: "live",
      body: "",
    });
    const [got] = await pending;
    expect(got?.cursor).toBe(sent.id);
  });

  it("a send committed while the consumer holds a delivery is not skipped", async () => {
    await raven.send({ project: P, from: "Queen", to: ["Ana"], subject: "1", body: "" });
    const seen: string[] = [];
    for await (const d of raven.stream({ project: P, agent: "Ana", after: 0 })) {
      seen.push(d.message.subject);
      if (seen.length === 1) {
        await raven.send({ project: P, from: "Queen", to: ["Ana"], subject: "2", body: "" });
      }
      if (seen.length === 2) {
        break;
      }
    }
    expect(seen).toEqual(["1", "2"]);
  });

  it("an aborted stream ends instead of waiting forever", async () => {
    const ctl = new AbortController();
    const done = take(raven.stream({ project: P, agent: "Ana", after: 0, signal: ctl.signal }), 5);
    ctl.abort();
    expect(await done).toEqual([]);
  });

  it("closing the store ends an open stream", async () => {
    const done = take(raven.stream({ project: P, agent: "Ana", after: 0 }), 5);
    raven.close();
    expect(await done).toEqual([]);
  });

  it("the firehose carries every message of the project in id order", async () => {
    const a = await raven.send({ project: P, from: "Queen", to: ["Ana"], subject: "a", body: "" });
    const b = await raven.send({ project: P, from: "Bo", to: ["Cy"], subject: "b", body: "" });
    const got = await take(raven.stream({ project: P, after: 0 }), 2);
    expect(got.map((d) => d.cursor)).toEqual([a.id, b.id]);
  });
});
