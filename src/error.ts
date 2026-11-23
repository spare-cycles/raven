export type RavenErrorCode =
  | "unknown_project"
  | "unknown_agent"
  | "retired_agent"
  | "unknown_message"
  | "unknown_thread"
  | "invalid";

/** A refused call. `code` is stable across the store and the HTTP client; the message names what was refused. */
export class RavenError extends Error {
  override readonly name: string = "RavenError";
  readonly code: RavenErrorCode;

  constructor(code: RavenErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}
