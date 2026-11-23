/** Turns one agent's raven deliveries into MCP notifications on the session that runs as that agent. */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RavenError } from "./error.ts";
import type { Raven } from "./types.ts";

/** The custom notification `extension/raven-wake.ts` listens for; it repeats this literal. */
export const DELIVERY = "notifications/raven/delivery";

export function inboxUri(agent: string): string {
  return `raven://inbox/${encodeURIComponent(agent)}`;
}

export type WakeTarget = { readonly project: string; readonly agent: string };

/**
 * Each delivery sends two notifications:
 * - `notifications/resources/updated` on `raven://inbox/<agent>`, when the client subscribed (omp with
 *   `mcp.notifications: true` injects it as a turn);
 * - `notifications/raven/delivery`, always, for the fallback extension in clients that do not subscribe.
 */
export class Waker {
  readonly uri: string;
  readonly #server: McpServer;
  readonly #raven: Raven;
  readonly #target: WakeTarget;
  readonly #log: (line: string) => void;
  readonly #stop = new AbortController();
  readonly #subscribed = new Set<string>();
  #watching: Promise<void> | null = null;

  constructor(server: McpServer, raven: Raven, target: WakeTarget, log: (line: string) => void) {
    this.#server = server;
    this.#raven = raven;
    this.#target = target;
    this.#log = log;
    this.uri = inboxUri(target.agent);
  }

  subscribe(uri: string): void {
    this.#subscribed.add(uri);
  }

  unsubscribe(uri: string): void {
    this.#subscribed.delete(uri);
  }

  /** Whether mail waits unread; an agent not registered yet has none. */
  async unread(): Promise<boolean> {
    try {
      return (await this.#raven.inbox({ ...this.#target, limit: 1 })).length > 0;
    } catch (e) {
      if (e instanceof RavenError && e.code === "unknown_agent") {
        return false;
      }
      throw e;
    }
  }

  /** The subscribed-resource signal; a no-op until the client subscribes to the inbox. */
  notify(): void {
    if (this.#subscribed.has(this.uri)) {
      this.#server.server.sendResourceUpdated({ uri: this.uri }).catch(() => undefined);
    }
  }

  /** The fallback signal, sent whether or not anything subscribed. */
  announce(message?: { id: number; from: string; subject: string }): void {
    this.#server.server
      .notification({ method: DELIVERY, params: { uri: this.uri, ...message } })
      .catch(() => undefined);
  }

  /**
   * Streams from the agent's newest delivery on. An agent not registered yet ends the watch quietly; call it again
   * once `register_agent` created it. While a watch runs, calling it returns that same watch.
   */
  watch(): Promise<void> {
    this.#watching ??= this.#run().finally(() => {
      this.#watching = null;
    });
    return this.#watching;
  }

  async #run(): Promise<void> {
    try {
      const [latest] = await this.#raven.inbox({ ...this.#target, unreadOnly: false, limit: 1 });
      const after = latest?.id ?? 0;
      for await (const d of this.#raven.stream({
        ...this.#target,
        after,
        signal: this.#stop.signal,
      })) {
        this.notify();
        this.announce({ id: d.message.id, from: d.message.from, subject: d.message.subject });
      }
    } catch (e) {
      if (!(e instanceof RavenError && e.code === "unknown_agent")) {
        this.#log(`raven mcp: wake-ups stopped: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  close(): void {
    this.#stop.abort();
  }
}
