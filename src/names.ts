/**
 * Names raven gives an agent registered without one: `<Adjective><Noun>` from two word lists, never a name any
 * agent of any project has had, retired ones included. The lists default to the ones below and can be replaced per
 * database (`raven config set names.nouns …`).
 */
import type { Database } from "bun:sqlite";
import { RavenError } from "./error.ts";

export const DEFAULT_NOUNS: readonly string[] = [
  "Curie",
  "Noether",
  "Lovelace",
  "Hopper",
  "Franklin",
  "Meitner",
  "Goodall",
  "Carson",
  "Hypatia",
  "Hodgkin",
  "Lamarr",
  "Mirzakhani",
  "Germain",
  "Yalow",
  "Leavitt",
  "Wu",
  "Elion",
  "Somerville",
  "Agnesi",
  "Tharp",
  "Margulis",
  "Kovalevskaya",
  "Newton",
  "Darwin",
  "Tesla",
  "Feynman",
  "Galileo",
  "Turing",
  "Einstein",
  "Bohr",
  "Faraday",
  "Maxwell",
  "Kepler",
  "Pasteur",
  "Mendel",
  "Planck",
  "Euler",
  "Gauss",
  "Fermi",
  "Dirac",
  "Heisenberg",
  "Schrodinger",
  "Archimedes",
  "Copernicus",
  "Volta",
  "Ampere",
  "Hubble",
  "Sagan",
  "Hawking",
  "Lavoisier",
];

export const DEFAULT_ADJECTIVES: readonly string[] = [
  "Wobbly",
  "Soggy",
  "Grumpy",
  "Flimsy",
  "Snoozy",
  "Crunchy",
  "Dizzy",
  "Lumpy",
  "Tangled",
  "Squishy",
  "Fizzy",
  "Bouncy",
  "Wiggly",
  "Wibbly",
  "Crumbly",
  "Fluffy",
  "Squeaky",
  "Rumpled",
  "Giggly",
  "Bumpy",
  "Sleepy",
  "Zany",
  "Wonky",
  "Goofy",
  "Puzzled",
  "Muddled",
  "Sticky",
  "Frothy",
  "Breezy",
  "Sparkly",
  "Toasty",
  "Rubbery",
  "Jumbled",
  "Rattled",
  "Floppy",
  "Sneezy",
  "Tumbling",
  "Dappled",
  "Frazzled",
  "Whimsical",
  "Spongy",
  "Bubbly",
  "Zippy",
  "Quirky",
  "Jolly",
  "Woolly",
  "Bashful",
  "Peppy",
  "Fuzzy",
  "Noodly",
];

/** The settings that hold a replacement list: comma-separated words. */
export const NAME_SETTINGS: Readonly<Record<string, readonly string[]>> = {
  "names.nouns": DEFAULT_NOUNS,
  "names.adjectives": DEFAULT_ADJECTIVES,
};

const WORD = /^[A-Za-z][a-z]*$/u;
const MIN_WORDS = 10;

/** A list as stored: trimmed words, each `^[A-Za-z][a-z]*$`, unique regardless of case, at least ten. */
export function parseWords(key: string, value: string): string[] {
  const words = value
    .split(",")
    .map((w) => w.trim())
    .filter((w) => w !== "");
  const bad = words.filter((w) => !WORD.test(w));
  if (bad.length > 0) {
    throw new RavenError("invalid", `${key}: not one capitalised word: ${bad.join(", ")}`);
  }
  const lower = words.map((w) => w.toLowerCase());
  const dupes = lower.filter((w, i) => lower.indexOf(w) !== i);
  if (dupes.length > 0) {
    throw new RavenError("invalid", `${key}: repeated: ${[...new Set(dupes)].join(", ")}`);
  }
  if (words.length < MIN_WORDS) {
    throw new RavenError(
      "invalid",
      `${key}: needs at least ${MIN_WORDS} words, got ${words.length}`,
    );
  }
  return words;
}

function knownKey(key: string): readonly string[] {
  const defaults = NAME_SETTINGS[key];
  if (defaults === undefined) {
    throw new RavenError(
      "invalid",
      `unknown setting ${key}; known: ${Object.keys(NAME_SETTINGS).join(", ")}`,
    );
  }
  return defaults;
}

/** The list in force for `key`: the stored replacement, or the default. */
export function getWords(db: Database, key: string): readonly string[] {
  const defaults = knownKey(key);
  const row = db
    .query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?")
    .get(key);
  return row === null ? defaults : parseWords(key, row.value);
}

/** Stores a replacement list after validating it; an empty value drops it and the default applies again. */
export function setWords(db: Database, key: string, value: string): void {
  knownKey(key);
  if (value.trim() === "") {
    db.query("DELETE FROM settings WHERE key = ?").run(key);
    return;
  }
  const words = parseWords(key, value);
  db.query(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  ).run(key, words.join(", "));
}

/**
 * A fresh `<Adjective><Noun>`, uniform over the combinations no agent of any project has had (compared
 * case-insensitively). `random` is the test seam. Refuses once every combination is spent.
 */
export function pickName(db: Database, random: () => number = Math.random): string {
  const used = new Set(
    db
      .query<{ name: string }, []>("SELECT name FROM agents")
      .all()
      .map((r) => r.name.toLowerCase()),
  );
  const adjectives = getWords(db, "names.adjectives");
  const nouns = getWords(db, "names.nouns");
  const free = adjectives.flatMap((a) =>
    nouns.map((n) => `${a}${n}`).filter((name) => !used.has(name.toLowerCase())),
  );
  const picked = free[Math.floor(random() * free.length)];
  if (picked === undefined) {
    throw new RavenError(
      "invalid",
      `every agent name is spent (${adjectives.length} adjectives × ${nouns.length} nouns): extend names.adjectives or names.nouns`,
    );
  }
  return picked;
}
