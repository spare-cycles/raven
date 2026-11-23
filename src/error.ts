export type RavenErrorCode =
  | "unknown_project"
  | "unknown_agent"
  | "retired_agent"
  | "unknown_message"
  | "unknown_thread"
  | "invalid"
  /** No token, or one that is unknown or revoked. */
  | "unauthorized"
  /** A valid token whose scope or projects do not cover the call. */
  | "forbidden"
  /** The server could not be reached or failed; the call may be retried. */
  | "unavailable";

/** A refused call. `code` is stable across the store and the HTTP client; the message names what was refused. */
export class RavenError extends Error {
  override readonly name: string = "RavenError";
  readonly code: RavenErrorCode;

  constructor(code: RavenErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }
}
