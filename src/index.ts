import { Store, type StoreOptions } from "./store.ts";
import type { Raven } from "./types.ts";

export { type ClientOptions, createClient, RavenClient } from "./client.ts";
export { RavenError, type RavenErrorCode } from "./error.ts";
export { type ServeOptions, serve } from "./server.ts";
export { Store, type StoreOptions } from "./store.ts";
export type { Grant, Scope, TokenInput } from "./tokens.ts";
export type * from "./types.ts";

/** A raven held in process; `close` ends its open streams and frees the database. */
export type MemoryRaven = Raven & { close: () => void };

/** The real core on an in-memory database: same semantics as the server, no daemon, for consumers' tests. */
export function createMemoryRaven(options: StoreOptions = {}): MemoryRaven {
  return new Store(":memory:", options);
}
