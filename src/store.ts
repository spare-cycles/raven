/** The durable core: one SQLite file, one writer, and in-process wake-ups for open streams. */
import { Database } from "bun:sqlite";
import { agents, register, retire } from "./agents.ts";
import { reply, send, type Written } from "./messages.ts";
import { inbox, mark, search, streamScope, threadState, topic } from "./reads.ts";
import { toMessage } from "./rows.ts";
import { migrate } from "./schema.ts";
import {
  authorize,
  type Grant,
  issueToken,
  listTokens,
  revokeToken,
  type TokenInfo,
  type TokenInput,
} from "./tokens.ts";
import type {
  Agent,
  Delivery,
  IdsInput,
  InboxMessage,
  InboxQuery,
  Message,
  Raven,
  RegisterInput,
  ReplyInput,
  SearchQuery,
  SendInput,
  Sent,
  StreamQuery,
  ThreadState,
  TopicQuery,
} from "./types.ts";
import { Wakeups } from "./wakeups.ts";

export type StoreOptions = {
  /** The clock every timestamp comes from; tests pin it. */
  readonly now?: () => Date;
};

// Each verb runs synchronously against SQLite; Promise.try turns a refusal into a rejection, never a throw.
export class Store implements Raven {
  readonly #db: Database;
  readonly #now: () => Date;
  readonly #wakeups = new Wakeups();
  #closed = false;

  constructor(path: string, options: StoreOptions = {}) {
    this.#db = new Database(path, { create: true, strict: true });
    this.#now = options.now ?? ((): Date => new Date());
    migrate(this.#db);
  }

  /** Ends every open stream, then closes the database; calling it again is harmless. */
  close(): void {
    this.#closed = true;
    this.#wakeups.wakeAll();
    this.#db.close();
  }

  send(input: SendInput): Promise<Sent> {
    return Promise.try(() => this.#commit(send(this.#db, input, this.#ts())));
  }

  reply(input: ReplyInput): Promise<Sent> {
    return Promise.try(() => this.#commit(reply(this.#db, input, this.#ts())));
  }

  /** Throws the RavenError `stream(query)` would raise on its first step, so a server can refuse before streaming. */
  checkStream(query: Pick<StreamQuery, "project" | "agent">): void {
    streamScope(this.#db, query.project, query.agent);
  }

  /** Mints a bearer token; the returned value is the only copy, the store keeps its hash. */
  issueToken(input: TokenInput): string {
    return issueToken(this.#db, input, this.#ts());
  }

  authorize(token: string): Grant | null {
    return authorize(this.#db, token);
  }

  revokeToken(label: string): void {
    revokeToken(this.#db, label, this.#ts());
  }

  listTokens(): TokenInfo[] {
    return listTokens(this.#db);
  }

  async *stream(query: StreamQuery): AsyncIterable<Delivery> {
    const { key, page } = streamScope(this.#db, query.project, query.agent);
    const { signal } = query;
    let cursor = query.after;
    while (signal?.aborted !== true && !this.#closed) {
      const rows = page(cursor);
      for (const row of rows) {
        cursor = row.id;
        yield { cursor, message: toMessage(row) };
      }
      if (rows.length === 0) {
        // Only an empty page waits, and nothing awaits between that query and parking, so a send committed
        // while the consumer held a yielded delivery is found by the next query instead of being missed.
        await this.#wakeups.wait(key, signal);
      }
    }
  }

  inbox(query: InboxQuery): Promise<InboxMessage[]> {
    return Promise.try(() => inbox(this.#db, query, this.#ts()));
  }

  markRead(input: IdsInput): Promise<void> {
    return Promise.try(() => mark(this.#db, input, "read", this.#ts()));
  }

  ack(input: IdsInput): Promise<void> {
    return Promise.try(() => mark(this.#db, input, "ack", this.#ts()));
  }

  topic(query: TopicQuery): Promise<Message[]> {
    return Promise.try(() => topic(this.#db, query));
  }

  search(query: SearchQuery): Promise<Message[]> {
    return Promise.try(() => search(this.#db, query));
  }

  threadState(query: { readonly project: string; readonly thread: number }): Promise<ThreadState> {
    return Promise.try(() => threadState(this.#db, query.project, query.thread));
  }

  agents(query: { readonly project: string }): Promise<Agent[]> {
    return Promise.try(() => agents(this.#db, query.project));
  }

  register(input: RegisterInput): Promise<Agent> {
    return Promise.try(() => register(this.#db, input, this.#ts()));
  }

  retire(input: { readonly project: string; readonly name: string }): Promise<void> {
    return Promise.try(() => retire(this.#db, input.project, input.name, this.#ts()));
  }

  #ts(): string {
    return this.#now().toISOString();
  }

  #commit(written: Written): Sent {
    for (const key of written.wake) {
      this.#wakeups.wake(key);
    }
    return written.sent;
  }
}
