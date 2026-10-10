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
 * An error that ends the command with its own exit code: 1 for not found, refused, changed or
 * failed, 2 for bad usage or a name several items have. `stdout` is a payload for stdout instead
 * of the message on stderr, such as the `--json` answer to an ambiguous name. `kind` is what
 * `--json` calls it, and `extra` the keys its object adds after `message`.
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
