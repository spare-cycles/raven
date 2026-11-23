/** The message model and the one interface every raven implementation (store, HTTP client) answers. */

export type Importance = "low" | "normal" | "high" | "urgent";

export type Message = {
  /** Global and monotonic: a recipient's deliveries are an ordered subsequence, so it doubles as the cursor. */
  readonly id: number;
  readonly project: string;
  readonly from: string;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly subject: string;
  readonly body: string;
  /** The id of the thread's root message; a root's thread is its own id. */
  readonly thread: number;
  readonly topic: string | null;
  readonly importance: Importance;
  readonly ackRequired: boolean;
  readonly ts: string;
};

/** A message as one recipient holds it. */
export type InboxMessage = Message & {
  readonly kind: "to" | "cc";
  readonly readTs: string | null;
  readonly ackTs: string | null;
};

export type Sent = { readonly id: number; readonly thread: number; readonly ts: string };

/** One pushed message; `cursor` is the message id, the `after` a reconnecting stream resumes from. */
export type Delivery = { readonly cursor: number; readonly message: Message };

/** An identity; `retiredTs` is set once it is retired, and `agents()` lists those only when asked. */
export type Agent = {
  readonly name: string;
  readonly program: string;
  readonly model: string;
  readonly task: string;
  readonly createdTs: string;
  readonly retiredTs: string | null;
};

export type AgentsQuery = {
  readonly project: string;
  /** Lists retired identities too: every name ever registered, for a caller choosing a fresh one. */
  readonly includeRetired?: boolean;
};

export type ThreadState = {
  readonly thread: number;
  readonly count: number;
  readonly last: { readonly id: number; readonly from: string; readonly ts: string };
};

export type SendInput = {
  readonly project: string;
  readonly from: string;
  readonly to: readonly string[];
  readonly cc?: readonly string[];
  readonly subject: string;
  readonly body: string;
  /** Joins an existing thread; omitted, the message roots a new one. */
  readonly thread?: number;
  readonly topic?: string;
  readonly importance?: Importance;
  readonly ackRequired?: boolean;
  /** A retried send with the same sender and key returns the first send's result and stores nothing. */
  readonly idempotencyKey?: string;
};

export type ReplyInput = {
  readonly project: string;
  readonly from: string;
  /** The id of the message replied to; the reply goes to its sender, in its thread, under its topic. */
  readonly to: number;
  readonly body: string;
  readonly cc?: readonly string[];
  readonly idempotencyKey?: string;
};

export type StreamQuery = {
  readonly project: string;
  /** One recipient's deliveries; omitted, every message in the project (the firehose). */
  readonly agent?: string;
  /** Resume after this message id; 0 replays everything. */
  readonly after: number;
  readonly signal?: AbortSignal;
};

export type InboxQuery = {
  readonly project: string;
  readonly agent: string;
  /** Defaults to true. */
  readonly unreadOnly?: boolean;
  readonly limit?: number;
  /** Marks the returned messages read. Defaults to false. */
  readonly markRead?: boolean;
};

export type IdsInput = {
  readonly project: string;
  readonly agent: string;
  readonly ids: readonly number[];
};

export type TopicQuery = {
  readonly project: string;
  readonly topic: string;
  /** Only messages strictly newer than this ISO-8601 timestamp. */
  readonly since?: string;
  readonly limit?: number;
};

export type SearchQuery = {
  readonly project: string;
  /** SQLite FTS5 syntax over subject and body: words, "phrases", prefix*, AND/OR/NOT. */
  readonly query: string;
  readonly limit?: number;
};

export type RegisterInput = {
  readonly project: string;
  /** Chosen by the caller: raven never invents names. */
  readonly name: string;
  readonly program: string;
  readonly model: string;
  readonly task?: string;
};

export interface Raven {
  /** Resolves once the message and its deliveries are committed. */
  send: (input: SendInput) => Promise<Sent>;
  reply: (input: ReplyInput) => Promise<Sent>;
  /** In id order, at least once: a consumer dedupes by `cursor` and persists it to resume. */
  stream: (query: StreamQuery) => AsyncIterable<Delivery>;
  /** Newest first. */
  inbox: (query: InboxQuery) => Promise<InboxMessage[]>;
  markRead: (input: IdsInput) => Promise<void>;
  /** The message-level acknowledgement; redelivery is governed by the consumer's cursor, not by this. */
  ack: (input: IdsInput) => Promise<void>;
  /** Newest first. */
  topic: (query: TopicQuery) => Promise<Message[]>;
  /** Best match first; an FTS5 syntax error is refused as `invalid`. */
  search: (query: SearchQuery) => Promise<Message[]>;
  threadState: (query: {
    readonly project: string;
    readonly thread: number;
  }) => Promise<ThreadState>;
  agents: (query: AgentsQuery) => Promise<Agent[]>;
  /** Creates the project and the agent when missing; registering a retired name brings it back. */
  register: (input: RegisterInput) => Promise<Agent>;
  retire: (input: { readonly project: string; readonly name: string }) => Promise<void>;
}
