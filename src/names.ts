const ADJECTIVES: readonly string[] = [
  "Amber",
  "Ashen",
  "Bold",
  "Brave",
  "Bright",
  "Copper",
  "Coral",
  "Crimson",
  "Dusky",
  "Emerald",
  "Gilded",
  "Golden",
  "Gray",
  "Hidden",
  "Iron",
  "Ivory",
  "Jade",
  "Lunar",
  "Misty",
  "Quiet",
  "Rose",
  "Ruby",
  "Rustic",
  "Sable",
  "Silent",
  "Silver",
  "Snowy",
  "Stone",
  "Swift",
  "Velvet",
];

const NOUNS: readonly string[] = [
  "Badger",
  "Bear",
  "Bluff",
  "Crane",
  "Crow",
  "Falcon",
  "Finch",
  "Fox",
  "Gorge",
  "Hare",
  "Hawk",
  "Heron",
  "Lynx",
  "Marten",
  "Moth",
  "Otter",
  "Owl",
  "Pine",
  "Pond",
  "Puma",
  "Raven",
  "River",
  "Spire",
  "Stag",
  "Tern",
  "Thrush",
  "Vale",
  "Wolf",
  "Wren",
  "Yew",
];

function pick(words: readonly string[]): string {
  const [n = 0] = crypto.getRandomValues(new Uint32Array(1));
  return words[n % words.length] ?? "";
}

/** An adjective+noun name that `taken` refuses; past 100 collisions, a numeric suffix guarantees one. */
export function freshName(taken: (name: string) => boolean): string {
  for (let i = 0; i < 100; i += 1) {
    const name = `${pick(ADJECTIVES)}${pick(NOUNS)}`;
    if (!taken(name)) {
      return name;
    }
  }
  for (let n = 2; ; n += 1) {
    const name = `${pick(ADJECTIVES)}${pick(NOUNS)}${n}`;
    if (!taken(name)) {
      return name;
    }
  }
}
