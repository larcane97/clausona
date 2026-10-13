/**
 * How a command's failure leaves the process, and the one JSON object `--json` turns it into.
 * The Extensions commands and `clausona route` share it, so a script reads both the same way.
 */

/** What went wrong, as `--json` names it in `error`: docs/extensions.md lists each with its exit code. */
export const ERROR_KINDS = [
  "usage",
  "ambiguous",
  "not-found",
  "refused",
  "changed",
  "conflict",
  "locked",
  "failed",
  "nothing-to-undo",
] as const;
export type ErrorKind = (typeof ERROR_KINDS)[number];

/**
 * An error that ends the command with its own exit code. The Extensions commands use 1 for not
 * found, refused, changed or failed and 2 for bad usage or a name several items have; `clausona
 * route` uses 1 for bad usage too. `stdout` is a payload for stdout instead of the message on
 * stderr, such as the `--json` answer to an ambiguous name. `kind` is what `--json` calls it, and
 * `extra` the keys its object adds after `message`.
 */
export class ExitError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly stdout?: string,
    readonly kind?: ErrorKind,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ExitError";
  }
}

const pretty = (value: unknown) => JSON.stringify(value, null, 2);

/**
 * With --json, an ExitError without stdout and any other error become one JSON object on stdout:
 * `{ version: 1, error: <kind>, message, …extra }`, the exit code kept. An ExitError that has its
 * own stdout - the ambiguous object - goes as it is.
 */
export async function withJsonErrors(args: string[], run: () => Promise<string>): Promise<string> {
  if (!args.includes("--json")) return run();
  try {
    return await run();
  } catch (error) {
    if (error instanceof ExitError) {
      if (error.stdout !== undefined) throw error;
      const kind: ErrorKind = error.kind ?? (error.code === 2 ? "usage" : "not-found");
      const body = { version: 1, error: kind, message: error.message, ...error.extra };
      throw new ExitError(error.message, error.code, pretty(body), error.kind, error.extra);
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new ExitError(message, 1, pretty({ version: 1, error: "failed", message }), "failed");
  }
}
