/** `Raven` over HTTP: the same interface as the store, for processes that do not hold the database. */
import { RavenError } from "./error.ts";
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
import { errorEnvelope, type RpcMethod, type RpcParams } from "./wire.ts";

export type ClientOptions = {
  /** The server's base URL, e.g. `http://127.0.0.1:7811`. */
  readonly url: string;
  readonly token: string;
  /** Reconnect backoff of a dropped stream, doubling from `min` to `max` ms; 1 s → 30 s by default. */
  readonly retry?: { readonly min: number; readonly max: number };
};

/** Refusals the server will repeat however often it is asked; a stream stops on these instead of retrying. */
const FINAL: Record<string, true> = {
  invalid: true,
  unauthorized: true,
  forbidden: true,
  unknown_project: true,
  unknown_agent: true,
};

const TRAILING_SLASHES = /\/+$/u;

/** Rethrows a refusal the server would only repeat; anything else is a dropped connection worth retrying. */
function throwIfFinal(e: unknown): void {
  if (e instanceof RavenError && Object.hasOwn(FINAL, e.code)) {
    throw e;
  }
}

async function refusalOf(res: Response): Promise<RavenError> {
  const parsed = errorEnvelope.safeParse(await res.json().catch(() => null));
  return parsed.success
    ? new RavenError(parsed.data.error.code, parsed.data.error.message)
    : new RavenError("unavailable", `HTTP ${res.status} from raven`);
}

/** One `event: delivery` frame's `data`, or null for comments, `retry:` and anything else. */
function deliveryOf(frame: string): Delivery | null {
  let event = "message";
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      data.push(line.slice("data:".length).trimStart());
    }
  }
  return event === "delivery" && data.length > 0 ? (JSON.parse(data.join("\n")) as Delivery) : null;
}

/** Read through a call so TypeScript does not narrow it across awaits: an abort can land at any of them. */
function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** Waits `ms`, or less if `signal` aborts first. */
function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener(
    "abort",
    () => {
      clearTimeout(timer);
      resolve();
    },
    { once: true },
  );
  return promise;
}

export class RavenClient implements Raven {
  readonly #base: string;
  readonly #auth: string;
  readonly #retry: { readonly min: number; readonly max: number };

  constructor(options: ClientOptions) {
    this.#base = options.url.replace(TRAILING_SLASHES, "");
    this.#auth = `Bearer ${options.token}`;
    this.#retry = options.retry ?? { min: 1000, max: 30_000 };
  }

  send(input: SendInput): Promise<Sent> {
    return this.#rpc("send", input) as Promise<Sent>;
  }

  reply(input: ReplyInput): Promise<Sent> {
    return this.#rpc("reply", input) as Promise<Sent>;
  }

  /**
   * Reconnects with `Last-Event-ID` after a dropped connection or a server failure, so a restart costs no
   * delivery; stops with a RavenError on a refusal that would only repeat, and quietly on abort.
   */
  async *stream(query: StreamQuery): AsyncIterable<Delivery> {
    const url = new URL(`${this.#base}/v1/stream`);
    url.searchParams.set("project", query.project);
    if (query.agent !== undefined) {
      url.searchParams.set("agent", query.agent);
    }
    const { signal } = query;
    let cursor = query.after;
    let backoff = this.#retry.min;
    while (!aborted(signal)) {
      try {
        for await (const d of this.#connect(url, cursor, signal)) {
          ({ cursor } = d);
          backoff = this.#retry.min;
          yield d;
        }
      } catch (e) {
        if (aborted(signal)) {
          return;
        }
        throwIfFinal(e);
      }
      await pause(backoff, signal);
      backoff = Math.min(backoff * 2, this.#retry.max);
    }
  }

  inbox(query: InboxQuery): Promise<InboxMessage[]> {
    return this.#rpc("inbox", query) as Promise<InboxMessage[]>;
  }

  markRead(input: IdsInput): Promise<void> {
    return this.#rpc("markRead", input).then(() => undefined);
  }

  ack(input: IdsInput): Promise<void> {
    return this.#rpc("ack", input).then(() => undefined);
  }

  topic(query: TopicQuery): Promise<Message[]> {
    return this.#rpc("topic", query) as Promise<Message[]>;
  }

  search(query: SearchQuery): Promise<Message[]> {
    return this.#rpc("search", query) as Promise<Message[]>;
  }

  threadState(query: RpcParams["threadState"]): Promise<ThreadState> {
    return this.#rpc("threadState", query) as Promise<ThreadState>;
  }

  agents(query: RpcParams["agents"]): Promise<Agent[]> {
    return this.#rpc("agents", query) as Promise<Agent[]>;
  }

  register(input: RegisterInput): Promise<Agent> {
    return this.#rpc("register", input) as Promise<Agent>;
  }

  retire(input: RpcParams["retire"]): Promise<void> {
    return this.#rpc("retire", input).then(() => undefined);
  }

  /** The server validates every params object; results are trusted as the server's own `Raven` shapes. */
  async #rpc<M extends RpcMethod>(method: M, params: RpcParams[M]): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${this.#base}/v1/rpc`, {
        method: "POST",
        headers: { authorization: this.#auth, "content-type": "application/json" },
        body: JSON.stringify({ method, params }),
      });
    } catch (e) {
      throw new RavenError(
        "unavailable",
        `raven unreachable: ${e instanceof Error ? e.message : String(e)}`,
        { cause: e },
      );
    }
    if (!res.ok) {
      throw await refusalOf(res);
    }
    const body = (await res.json()) as { result: unknown };
    return body.result;
  }

  /** One SSE connection's deliveries; ends when the server closes it. */
  async *#connect(
    url: URL,
    after: number,
    signal: AbortSignal | undefined,
  ): AsyncIterable<Delivery> {
    const res = await fetch(url, {
      headers: {
        authorization: this.#auth,
        accept: "text/event-stream",
        "last-event-id": String(after),
      },
      ...(signal === undefined ? {} : { signal }),
    });
    if (!res.ok || res.body === null) {
      throw await refusalOf(res);
    }
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let end = buffer.indexOf("\n\n");
      while (end !== -1) {
        const d = deliveryOf(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
        if (d !== null && d.cursor > after) {
          yield d;
        }
        end = buffer.indexOf("\n\n");
      }
    }
  }
}

export function createClient(options: ClientOptions): Raven {
  return new RavenClient(options);
}
