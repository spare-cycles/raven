/**
 * The agent-facing tools. Names and argument shapes follow Agent Mail's wherever raven keeps the concept, so a
 * brief written for Agent Mail works by switching servers.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { RavenError } from "./error.ts";
import type { InboxMessage, Message, Raven, Sent } from "./types.ts";

/** Who a call acts for when it does not say: the process's own project and agent. */
export type Defaults = { readonly project: string | undefined; readonly agent: string | undefined };

/** Tells the server that a tool registered an agent; registering the process's own agent starts its wake-ups. */
export type OnRegistered = (name: string) => void;

type Ctx = { readonly server: McpServer; readonly raven: Raven; readonly d: Defaults };

const projectKey = z.string().min(1).optional().describe("Project key; defaults to RAVEN_PROJECT");
const agentName = z.string().min(1).optional().describe("Agent name; defaults to RAVEN_AGENT");
const messageId = z.number().int().positive();
const names = z.array(z.string().min(1));

function pick(value: string | undefined, fallback: string | undefined, what: string): string {
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
function present<T extends Record<string, unknown>>(
  entries: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  const kept = Object.entries(entries).filter(([, v]) => v !== undefined);
  // Object.fromEntries forgets the key types; the filter above is what makes the narrower type true.
  return Object.fromEntries(kept) as { [K in keyof T]?: Exclude<T[K], undefined> };
}

/** A message in Agent Mail's field names; `body_md` only when asked for. */
function mail(m: Message | InboxMessage, bodies: boolean): Record<string, unknown> {
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

function sentOf(s: Sent): Record<string, unknown> {
  return { id: s.id, thread_id: s.thread, created_ts: s.ts };
}

/** Runs a tool body; a RavenError becomes an `isError` result naming its code, anything else propagates. */
async function result(body: () => Promise<unknown>): Promise<CallToolResult> {
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

function sendMessage({ server, raven, d }: Ctx): void {
  const inputSchema = {
    project_key: projectKey,
    sender_name: agentName,
    to: names.min(1),
    cc: names.optional(),
    subject: z.string(),
    body_md: z.string(),
    thread_id: messageId.optional().describe("Root message id of the thread to join"),
    topic: z.string().min(1).optional(),
    importance: z.enum(["low", "normal", "high", "urgent"]).optional(),
    ack_required: z.boolean().optional(),
    idempotency_key: z.string().min(1).optional(),
  };
  const description = "Send a message. Resolves once stored; recipients must be registered agents.";
  server.registerTool("send_message", { description, inputSchema }, (a) =>
    result(async () => {
      const sent = await raven.send({
        project: pick(a.project_key, d.project, "project_key"),
        from: pick(a.sender_name, d.agent, "sender_name"),
        to: a.to,
        subject: a.subject,
        body: a.body_md,
        ...present({
          cc: a.cc,
          thread: a.thread_id,
          topic: a.topic,
          importance: a.importance,
          ackRequired: a.ack_required,
          idempotencyKey: a.idempotency_key,
        }),
      });
      return sentOf(sent);
    }),
  );
}

function replyMessage({ server, raven, d }: Ctx): void {
  const inputSchema = {
    project_key: projectKey,
    message_id: messageId,
    sender_name: agentName,
    body_md: z.string(),
    cc: names.optional(),
    idempotency_key: z.string().min(1).optional(),
  };
  const description =
    "Reply in a message's thread, to its sender; replying to your own message follows it up to its recipients.";
  server.registerTool("reply_message", { description, inputSchema }, (a) =>
    result(async () => {
      const sent = await raven.reply({
        project: pick(a.project_key, d.project, "project_key"),
        from: pick(a.sender_name, d.agent, "sender_name"),
        to: a.message_id,
        body: a.body_md,
        ...present({ cc: a.cc, idempotencyKey: a.idempotency_key }),
      });
      return sentOf(sent);
    }),
  );
}

function fetchInbox({ server, raven, d }: Ctx): void {
  const inputSchema = {
    project_key: projectKey,
    agent_name: agentName,
    unread_only: z.boolean().optional().describe("Defaults to true"),
    limit: z.number().int().positive().optional(),
    include_bodies: z.boolean().optional().describe("Defaults to false"),
  };
  const description = "Messages addressed to an agent, newest first; marks the returned ones read.";
  server.registerTool("fetch_inbox", { description, inputSchema }, (a) =>
    result(async () => {
      const rows = await raven.inbox({
        project: pick(a.project_key, d.project, "project_key"),
        agent: pick(a.agent_name, d.agent, "agent_name"),
        markRead: true,
        ...present({ unreadOnly: a.unread_only, limit: a.limit }),
      });
      return rows.map((m) => mail(m, a.include_bodies === true));
    }),
  );
}

function markTools({ server, raven, d }: Ctx): void {
  const inputSchema = { project_key: projectKey, agent_name: agentName, message_id: messageId };
  const tools = [
    ["mark_message_read", "markRead", "Mark a message read."],
    [
      "acknowledge_message",
      "ack",
      "Acknowledge a message delivered to an agent (also marks it read).",
    ],
  ] as const;
  for (const [tool, verb, description] of tools) {
    server.registerTool(tool, { description, inputSchema }, (a) =>
      result(() =>
        raven[verb]({
          project: pick(a.project_key, d.project, "project_key"),
          agent: pick(a.agent_name, d.agent, "agent_name"),
          ids: [a.message_id],
        }),
      ),
    );
  }
}

function fetchTopic({ server, raven, d }: Ctx): void {
  const inputSchema = {
    project_key: projectKey,
    topic_name: z.string().min(1),
    limit: z.number().int().positive().optional(),
    include_bodies: z.boolean().optional().describe("Defaults to true"),
    since_ts: z.string().optional().describe("ISO-8601; only messages strictly newer"),
  };
  const description =
    "Every message of a project under a topic, newest first, whoever it was addressed to.";
  server.registerTool("fetch_topic", { description, inputSchema }, (a) =>
    result(async () => {
      const rows = await raven.topic({
        project: pick(a.project_key, d.project, "project_key"),
        topic: a.topic_name,
        ...present({ limit: a.limit, since: a.since_ts }),
      });
      return rows.map((m) => mail(m, a.include_bodies !== false));
    }),
  );
}

function listAgents({ server, raven, d }: Ctx): void {
  const inputSchema = { project_key: projectKey };
  server.registerTool(
    "list_agents",
    { description: "The project's active agents.", inputSchema },
    (a) =>
      result(async () => {
        const agents = await raven.agents({
          project: pick(a.project_key, d.project, "project_key"),
        });
        return agents.map((x) => ({
          name: x.name,
          program: x.program,
          model: x.model,
          task_description: x.task,
          inception_ts: x.createdTs,
        }));
      }),
  );
}

function registerAgent({ server, raven, d }: Ctx, onRegistered: OnRegistered): void {
  const inputSchema = {
    project_key: projectKey,
    name: z.string().min(1),
    program: z.string(),
    model: z.string(),
    task_description: z.string().optional(),
  };
  const description =
    "Create or update an agent identity (and its project). The caller chooses the name; registering a retired name restores it.";
  server.registerTool("register_agent", { description, inputSchema }, (a) =>
    result(async () => {
      const agent = await raven.register({
        project: pick(a.project_key, d.project, "project_key"),
        name: a.name,
        program: a.program,
        model: a.model,
        ...present({ task: a.task_description }),
      });
      onRegistered(agent.name);
      return agent;
    }),
  );
}

function retireAgent({ server, raven, d }: Ctx): void {
  const inputSchema = { project_key: projectKey, agent_name: z.string().min(1) };
  const description =
    "Retire an agent: it stops receiving messages and leaves list_agents. Needs an admin token.";
  server.registerTool("retire_agent", { description, inputSchema }, (a) =>
    result(() =>
      raven.retire({ project: pick(a.project_key, d.project, "project_key"), name: a.agent_name }),
    ),
  );
}

export function registerTools(
  server: McpServer,
  raven: Raven,
  d: Defaults,
  onRegistered: OnRegistered,
): void {
  const ctx = { server, raven, d };
  sendMessage(ctx);
  replyMessage(ctx);
  fetchInbox(ctx);
  markTools(ctx);
  fetchTopic(ctx);
  listAgents(ctx);
  registerAgent(ctx, onRegistered);
  retireAgent(ctx);
}
