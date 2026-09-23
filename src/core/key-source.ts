import type { SecretSource } from "../types.js";
import { HIDDEN } from "./api-url.js";
import { isPosixEnvName } from "./shell.js";

/**
 * How a key source is named on the way out. Here in core rather than beside `redactProfile`
 * because doctor, which is core, has to say where a key comes from too, and a second copy is
 * how two surfaces come to disagree about a command line.
 */

/** Where the key is read from, and nothing the reference could carry. */
export function redactSecretSource(secret: SecretSource | undefined): SecretSource {
  switch (secret?.source) {
    case "keychain":
      return { source: "keychain" };
    case "env":
      // checkSecretSource refuses anything but a name on the way in; a hand edit is how a
      // key gets into this slot, and the name is the one thing that would print it.
      return { source: "env", name: isPosixEnvName(secret.name) ? secret.name : HIDDEN };
    case "command":
      // The command line can carry a vault path, a token argument or the key itself.
      return { source: "command", run: HIDDEN };
    default:
      // A source clausona does not know is one it cannot say anything safe about.
      return { source: HIDDEN } as unknown as SecretSource;
  }
}

/** The one-word form of a key source, for text: `keychain`, `env:NAME` or `command`. */
export function describeSecretSource(secret: SecretSource | undefined): string {
  const shown = redactSecretSource(secret);
  if (shown.source === "env") return `env:${shown.name}`;
  return shown.source;
}

/**
 * The same, to end a sentence with: "... comes from env:GW_KEY", "... from a command",
 * "... from the credential store".
 */
export function keySourcePhrase(secret: SecretSource | undefined): string {
  const shown = redactSecretSource(secret);
  if (shown.source === "command") return "a command";
  if (shown.source === "keychain") return "the credential store";
  return describeSecretSource(shown);
}
