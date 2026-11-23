import { afterEach, describe, expect, test as it } from "bun:test";
import { DEFAULT_ADJECTIVES, DEFAULT_NOUNS, parseWords } from "../src/names.ts";
import { Store } from "../src/store.ts";
import { P, refused } from "./helpers.ts";

const TEN = "Alpha, Bravo, Charlie, Delta, Echo, Foxtrot, Golf, Hotel, India, Juliett";

describe("agent names", () => {
  let store: Store | undefined;

  afterEach(() => store?.close());

  /** A store whose picks always take the first free combination, so the expected name is known. */
  function firstPick(): Store {
    store = new Store(":memory:", { random: () => 0 });
    return store;
  }

  it("the default lists are 50 valid words each", () => {
    expect(parseWords("names.nouns", DEFAULT_NOUNS.join(", "))).toHaveLength(50);
    expect(parseWords("names.adjectives", DEFAULT_ADJECTIVES.join(", "))).toHaveLength(50);
  });

  it("register without a name picks <Adjective><Noun> from the lists", async () => {
    const s = new Store(":memory:");
    store = s;
    const agent = await s.register({ project: P, program: "omp", model: "m" });
    const adjective = DEFAULT_ADJECTIVES.find((a) => agent.name.startsWith(a));
    expect(adjective).toBeDefined();
    expect(DEFAULT_NOUNS).toContain(agent.name.slice(adjective?.length ?? 0));
  });

  it("a picked name is never one any agent has had: retired, other project, or another case", async () => {
    const s = firstPick();
    await s.register({ project: "/other", name: "wobblycurie", program: "x", model: "y" });
    await s.retire({ project: "/other", name: "wobblycurie" });
    await s.register({ project: P, name: "WobblyNoether", program: "x", model: "y" });
    const picked = await s.register({ project: P, program: "omp", model: "m" });
    expect(picked.name).toBe("WobblyLovelace");
    const again = await s.register({ project: P, program: "omp", model: "m" });
    expect(again.name).toBe("WobblyHopper");
  });

  it("an explicit name is still accepted and validated", async () => {
    const s = firstPick();
    expect((await s.register({ project: P, name: "Queen", program: "x", model: "y" })).name).toBe(
      "Queen",
    );
    expect(
      await refused(s.register({ project: P, name: "two words", program: "x", model: "y" })),
    ).toBe("invalid");
  });

  it("replacement lists are validated, used by the picker, and an empty value restores the default", async () => {
    const s = firstPick();
    expect(() => s.setSetting("names.nouns", "Curie, Darwin")).toThrow("at least 10");
    expect(() => s.setSetting("names.nouns", `${TEN}, alpha`)).toThrow("repeated");
    expect(() => s.setSetting("names.nouns", `${TEN}, McClintock`)).toThrow(
      "not one capitalised word",
    );
    expect(() => s.setSetting("names.colours", TEN)).toThrow("unknown setting");
    s.setSetting("names.nouns", TEN);
    expect((await s.register({ project: P, program: "x", model: "y" })).name).toBe("WobblyAlpha");
    s.setSetting("names.nouns", "");
    expect(s.getSetting("names.nouns")).toEqual(DEFAULT_NOUNS);
  });

  it("once every combination is spent, register refuses instead of reusing one", async () => {
    const s = firstPick();
    s.setSetting("names.nouns", TEN);
    s.setSetting("names.adjectives", TEN);
    for (let i = 0; i < 100; i += 1) {
      await s.register({ project: P, program: "x", model: "y" });
    }
    expect(await refused(s.register({ project: P, program: "x", model: "y" }))).toBe("invalid");
  });
});
