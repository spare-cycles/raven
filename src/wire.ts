/** The HTTP contract: `/v1/rpc` method names, their validated params, and the error envelope. */
import { z } from "zod";
import type { RavenErrorCode } from "./error.ts";
import type {
  IdsInput,
  InboxQuery,
  RegisterInput,
  ReplyInput,
  SendInput,
  TopicQuery,
} from "./types.ts";

/** What each `/v1/rpc` method takes: the matching `Raven` method's argument. */
export type RpcParams = {
  send: SendInput;
  reply: ReplyInput;
  inbox: InboxQuery;
  markRead: IdsInput;
  ack: IdsInput;
  topic: TopicQuery;
  threadState: { readonly project: string; readonly thread: number };
  agents: { readonly project: string };
  register: RegisterInput;
  retire: { readonly project: string; readonly name: string };
};

export type RpcMethod = keyof RpcParams;

const name = z.string().min(1);
const project = z.string().min(1);
const id = z.number().int().positive();
const importance = z.enum(["low", "normal", "high", "urgent"]);

/** Params per method; `stream` is `/v1/stream`, not an rpc. Typing each schema by its interface argument keeps the two in step. */
export const RPC: { readonly [M in RpcMethod]: z.ZodType<RpcParams[M]> } = {
  send: z.strictObject({
    project,
    from: name,
    to: z.array(name).min(1),
    cc: z.array(name).exactOptional(),
    subject: z.string(),
    body: z.string(),
    thread: id.exactOptional(),
    topic: z.string().min(1).exactOptional(),
    importance: importance.exactOptional(),
    ackRequired: z.boolean().exactOptional(),
    idempotencyKey: z.string().min(1).exactOptional(),
  }),
  reply: z.strictObject({
    project,
    from: name,
    to: id,
    body: z.string(),
    cc: z.array(name).exactOptional(),
    idempotencyKey: z.string().min(1).exactOptional(),
  }),
  inbox: z.strictObject({
    project,
    agent: name,
    unreadOnly: z.boolean().exactOptional(),
    limit: id.exactOptional(),
    markRead: z.boolean().exactOptional(),
  }),
  markRead: z.strictObject({ project, agent: name, ids: z.array(id) }),
  ack: z.strictObject({ project, agent: name, ids: z.array(id) }),
  topic: z.strictObject({
    project,
    topic: z.string().min(1),
    since: z.string().exactOptional(),
    limit: id.exactOptional(),
  }),
  threadState: z.strictObject({ project, thread: id }),
  agents: z.strictObject({ project }),
  register: z.strictObject({
    project,
    name: name.exactOptional(),
    program: z.string(),
    model: z.string(),
    task: z.string().exactOptional(),
  }),
  retire: z.strictObject({ project, name }),
};

export const rpcRequest: z.ZodType<{ method: string; params: unknown }> = z.strictObject({
  method: z.string(),
  params: z.unknown(),
});

/** Every refusal on the wire: `{ error: { code, message } }`. */
export const errorEnvelope: z.ZodType<{ error: { code: RavenErrorCode; message: string } }> =
  z.object({
    error: z.object({
      code: z.enum([
        "unknown_project",
        "unknown_agent",
        "retired_agent",
        "unknown_message",
        "unknown_thread",
        "invalid",
        "unauthorized",
        "forbidden",
        "unavailable",
      ]),
      message: z.string(),
    }),
  });

export const STATUS: Record<RavenErrorCode, number> = {
  invalid: 400,
  unauthorized: 401,
  forbidden: 403,
  unknown_project: 404,
  unknown_agent: 404,
  unknown_message: 404,
  unknown_thread: 404,
  retired_agent: 409,
  unavailable: 503,
};
