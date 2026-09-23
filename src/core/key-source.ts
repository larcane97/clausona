import type { Profile, SecretSource } from "../types.js";
import { checkBaseUrl, HIDDEN } from "./api-url.js";
import { carriesCredentialToken } from "./credential-token.js";
import { isPosixEnvName } from "./shell.js";

/**
 * How a key source is named on the way out. Here in core rather than beside `redactProfile`
 * because doctor, which is core, has to say where a key comes from too, and a second copy is
 * how two surfaces come to disagree about a command line.
 */

/**
 * Whether clausona knows where this source reads a key from. A hand edit can leave anything
 * in the slot, or nothing; clausona can say nothing true about where such a key comes from,
 * so it is described as unknown, doctor reports it, and it is never resolved to find out.
 */
export function isKnownSecretSource(secret: SecretSource | undefined): secret is SecretSource {
  return secret?.source === "keychain" || secret?.source === "env" || secret?.source === "command";
}

/** Where the key is read from, and nothing the reference could carry. */
export function redactSecretSource(secret: SecretSource | undefined): SecretSource {
  switch (secret?.source) {
    case "keychain":
      return { source: "keychain" };
    case "env":
      // checkSecretSource refuses anything but a name on the way in; a hand edit, or a
      // profile stored before that rule, is how a key gets into this slot, and the name is
      // the one thing that would print it. A key can be a valid name, so it is judged by
      // its shape as well.
      return {
        source: "env",
        name: isPosixEnvName(secret.name) && !carriesCredentialToken(secret.name) ? secret.name : HIDDEN,
      };
    case "command":
      // The command line can carry a vault path, a token argument or the key itself.
      return { source: "command", run: HIDDEN };
    default:
      // A source clausona does not know is one it cannot say anything safe about, beyond that.
      return { source: "unknown" } as unknown as SecretSource;
  }
}

/** The one-word form of a key source, for text: `keychain`, `env:NAME`, `command` or `unknown`. */
export function describeSecretSource(secret: SecretSource | undefined): string {
  const shown = redactSecretSource(secret);
  if (shown.source === "env") return `env:${shown.name}`;
  return shown.source;
}

/**
 * The same, to end a sentence with: "... comes from env:GW_KEY", "... from a command",
 * "... from the credential store", "... from an unknown key source".
 */
export function keySourcePhrase(secret: SecretSource | undefined): string {
  if (!isKnownSecretSource(secret)) return "an unknown key source";
  const shown = redactSecretSource(secret);
  if (shown.source === "command") return "a command";
  if (shown.source === "keychain") return "the credential store";
  return describeSecretSource(shown);
}

/**
 * Whether two key sources give the same key: one variable, or one command line. A stored
 * key is filed under its profile's id, so two `keychain` sources never do.
 */
export function sharesSecretSource(a: SecretSource | undefined, b: SecretSource | undefined): boolean {
  if (a?.source === "env" && b?.source === "env") return a.name === b.name;
  if (a?.source === "command" && b?.source === "command") return a.run === b.run;
  return false;
}

/**
 * The other API profiles whose key comes from the same variable or command as `secret`, and
 * that send it to a different endpoint than `baseUrl`: one key, reaching two endpoints. Each
 * endpoint then receives the other's key, which is the leak a shared source makes possible
 * once the endpoints differ - and nothing on either profile's own screen shows it.
 *
 * Endpoints are compared by origin (scheme, host and port), so two paths on one gateway are
 * one endpoint. A URL too broken to have an origin is never the same endpoint as another,
 * which errs toward naming the profile.
 */
export function keySharersElsewhere(
  id: string,
  secret: SecretSource | undefined,
  baseUrl: string | undefined,
  profiles: Record<string, Profile>,
): string[] {
  const origin = originOf(baseUrl);
  return Object.entries(profiles)
    .filter(
      ([other, entry]) =>
        other !== id &&
        entry.kind === "api" &&
        sharesSecretSource(entry.api?.secret, secret) &&
        (origin === undefined || originOf(entry.api?.baseUrl) !== origin),
    )
    .map(([other]) => other);
}

function originOf(baseUrl: string | undefined): string | undefined {
  if (typeof baseUrl !== "string") return undefined;
  const checked = checkBaseUrl(baseUrl);
  return checked.ok ? checked.url.origin : undefined;
}
