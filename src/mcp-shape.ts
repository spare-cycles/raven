/** What every `raven mcp` tool shares: defaults, argument schemas, Agent Mail field names and the result envelope. */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { RavenError } from "./error.ts";
import type { InboxMessage, Message, Raven, Sent } from "./types.ts";

/** Who a call acts for when it does not say: the process's own project and agent. */
export type Defaults = { readonly project: string | undefined; readonly agent: string | undefined };

/** Tells the server that a tool registered an agent; registering the process's own agent starts its wake-ups. */
export type OnRegistered = (name: string) => void;

export type Ctx = { readonly server: McpServer; readonly raven: Raven; readonly d: Defaults };

export const projectKey: z.ZodOptional<z.ZodString> = z
  .string()
  .min(1)
  .optional()
  .describe("Project key; defaults to RAVEN_PROJECT");
export const agentName: z.ZodOptional<z.ZodString> = z
  .string()
  .min(1)
  .optional()
  .describe("Agent name; defaults to RAVEN_AGENT");
export const messageId: z.ZodNumber = z.number().int().positive();
export const names: z.ZodArray<z.ZodString> = z.array(z.string().min(1));

export function pick(
  value: string | undefined,
  fallback: string | undefined,
  what: string,
): string {
  const chosen = value ?? fallback;
  if (chosen === undefined) {
    throw new RavenError(
      "invalid",
      `${what} is required: pass it or set the matching RAVEN_ variable`,
    );
  }
  return chosen;
}

/** The given entries minus the undefined ones, so an omitted tool argument stays absent rather than `undefined`. */
export function present<T extends Record<string, unknown>>(
  entries: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  const kept = Object.entries(entries).filter(([, v]) => v !== undefined);
  // Object.fromEntries forgets the key types; the filter above is what makes the narrower type true.
  return Object.fromEntries(kept) as { [K in keyof T]?: Exclude<T[K], undefined> };
}

/** A message in Agent Mail's field names; `body_md` only when asked for. */
export function mail(m: Message | InboxMessage, bodies: boolean): Record<string, unknown> {
  return {
    id: m.id,
    from: m.from,
    to: m.to,
    cc: m.cc,
    subject: m.subject,
    ...(bodies ? { body_md: m.body } : {}),
    thread_id: m.thread,
    topic: m.topic,
    importance: m.importance,
    ack_required: m.ackRequired,
    created_ts: m.ts,
    ...("kind" in m ? { kind: m.kind, read_ts: m.readTs, ack_ts: m.ackTs } : {}),
  };
}

export function sentOf(s: Sent): Record<string, unknown> {
  return { id: s.id, thread_id: s.thread, created_ts: s.ts };
}

/** Runs a tool body; a RavenError becomes an `isError` result naming its code, anything else propagates. */
export async function result(body: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const value = await body();
    return { content: [{ type: "text", text: JSON.stringify(value ?? { ok: true }) }] };
  } catch (e) {
    if (!(e instanceof RavenError)) {
      throw e;
    }
    const text = JSON.stringify({ error: { code: e.code, message: e.message } });
    return { isError: true, content: [{ type: "text", text }] };
  }
}
