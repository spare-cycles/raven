/** The one module that reads the environment; everything else takes these values as arguments. */

import process from "node:process";
import { RavenError } from "./error.ts";

/** `raven mcp`'s configuration. `agent` is the identity this process wakes; without it, nothing is pushed. */
export type McpEnv = {
  readonly url: string;
  readonly token: string;
  readonly project: string | undefined;
  readonly agent: string | undefined;
};

function required(key: string): string {
  const value = process.env[key];
  if (value === undefined || value === "") {
    throw new RavenError("invalid", `${key} is not set`);
  }
  return value;
}

function optional(key: string): string | undefined {
  const value = process.env[key];
  return value === undefined || value === "" ? undefined : value;
}

export function mcpEnv(): McpEnv {
  return {
    url: required("RAVEN_URL"),
    token: required("RAVEN_TOKEN"),
    project: optional("RAVEN_PROJECT"),
    agent: optional("RAVEN_AGENT"),
  };
}
