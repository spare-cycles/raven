import { afterEach, beforeEach, describe, expect, test as it } from "bun:test";
import type { MemoryRaven } from "../src/index.ts";
import { P, refused, seeded } from "./helpers.ts";

describe("search", () => {
  let raven: MemoryRaven;

  beforeEach(async () => {
    raven = await seeded();
    await raven.register({ project: "/other", name: "Zed", program: "omp", model: "m" });
  });

  afterEach(() => raven.close());

  it("matches subject and body words, phrases and prefixes, within the project only", async () => {
    const deploy = await raven.send({
      project: P,
      from: "Queen",
      to: ["Ana"],
      subject: "Deploy plan",
      body: "",
    });
    const body = await raven.send({
      project: P,
      from: "Ana",
      to: ["Bo"],
      subject: "status",
      body: "the deployment window moved",
    });
    await raven.send({ project: P, from: "Bo", to: ["Cy"], subject: "lunch", body: "pizza" });
    await raven.send({
      project: "/other",
      from: "Zed",
      to: ["Zed"],
      subject: "Deploy elsewhere",
      body: "",
    });
    const hits = await raven.search({ project: P, query: "deploy*" });
    expect(new Set(hits.map((m) => m.id))).toEqual(new Set([deploy.id, body.id]));
    const phrase = await raven.search({ project: P, query: '"window moved"' });
    expect(phrase.map((m) => m.id)).toEqual([body.id]);
    expect(await raven.search({ project: P, query: "nothing" })).toEqual([]);
  });

  it("a malformed query is refused as invalid, not a server error", async () => {
    // SQLite only parses the MATCH expression once the index holds a row.
    await raven.send({ project: P, from: "Queen", to: ["Ana"], subject: "anything", body: "" });
    expect(await refused(raven.search({ project: P, query: '"unclosed' }))).toBe("invalid");
  });
});
