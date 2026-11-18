// SPDX-License-Identifier: Apache-2.0
/** The exit codes of rlx. */
export const EXIT = {
  ok: 0,
  user: 1,
  notSignedIn: 2,
  server: 3,
  cancelled: 4,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** An error that rlx shows to the user, with an exit code. */
export class CliError extends Error {
  readonly exitCode: ExitCode;
  readonly code: string | undefined;
  readonly status: number | undefined;
  /** The id of the call that failed, as the server states it, so the person can name the call. */
  readonly callId: string | undefined;
  /** One line from the server for the person: what to do next. */
  readonly hint: string | undefined;

  constructor(
    message: string,
    options: { exitCode?: ExitCode; code?: string; status?: number; callId?: string; hint?: string } = {},
  ) {
    super(message);
    this.name = "CliError";
    this.exitCode = options.exitCode ?? EXIT.user;
    this.code = options.code;
    this.status = options.status;
    this.callId = options.callId;
    this.hint = options.hint;
  }
}

export function userError(message: string, code?: string): CliError {
  return new CliError(message, { exitCode: EXIT.user, code });
}

export function serverError(message: string, code?: string, status?: number): CliError {
  return new CliError(message, { exitCode: EXIT.server, code, status });
}

export function notSignedIn(message = "You are not signed in. Run: rlx login"): CliError {
  return new CliError(message, { exitCode: EXIT.notSignedIn, code: "NOT_SIGNED_IN" });
}

export function cancelled(message = "Cancelled."): CliError {
  return new CliError(message, { exitCode: EXIT.cancelled, code: "CANCELLED" });
}
