/**
 * An error that ends the command with its own exit code: 1 for not found, 2 for bad usage or a
 * name several items have. `stdout` is a payload for stdout instead of the message on stderr,
 * such as the `--json` answer to an ambiguous name.
 */
export class ExitError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly stdout?: string,
  ) {
    super(message);
    this.name = "ExitError";
  }
}
