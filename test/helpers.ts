import { createMemoryRaven, type Delivery, type MemoryRaven, RavenError } from "../src/index.ts";

export const P = "/perso/realm";

/** A clock that moves one second per reading, so timestamps are distinct and predictable. */
function steppingClock(start: number): () => Date {
  let t = start;
  return (): Date => {
    const d = new Date(t);
    t += 1000;
    return d;
  };
}

/** A memory raven on a stepping clock with Queen, Ana, Bo and Cy registered in `P`. */
export async function seeded(): Promise<MemoryRaven> {
  const raven = createMemoryRaven({ now: steppingClock(Date.parse("2026-11-23T10:00:00.000Z")) });
  for (const name of ["Queen", "Ana", "Bo", "Cy"]) {
    await raven.register({ project: P, name, program: "omp", model: "m" });
  }
  return raven;
}

/** The next `n` (≥ 1) deliveries of a stream, then stop it; fewer if the stream ends first. */
export async function take(iter: AsyncIterable<Delivery>, n: number): Promise<Delivery[]> {
  const out: Delivery[] = [];
  for await (const d of iter) {
    out.push(d);
    if (out.length === n) {
      break;
    }
  }
  return out;
}

/** The code of the RavenError `p` rejects with; anything else fails the test. */
export async function refused(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof RavenError) {
      return e.code;
    }
    throw e;
  }
  throw new Error("expected a RavenError");
}
