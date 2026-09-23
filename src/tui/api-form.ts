/**
 * The API-profile form's model: its fields, and what is wrong with each of them.
 *
 * Pure, and separate from both the step machine in App.tsx and the panel in
 * components/ApiForm.tsx, so that every rule below can be asserted without driving a key
 * sequence to reach the form first.
 *
 * None of the rules are written here. The name allowlist, the base-URL shape, and what a
 * setting's value may be each live in one place already - `src/lib/profile-ref.ts`,
 * `src/core/api-url.ts`, `src/tools/claude-env-catalog.ts` - and `addApiProfile` checks
 * all three again before its first side effect. What is here is the wording, which has to
 * differ: a CLI message can point at a flag and repeat what it refused, and neither is
 * right in a form where the offending value is still on screen and still editable.
 */

import { checkBaseUrl, isAnthropicHost } from "../core/api-url.js";
import { CREDENTIAL_ENV_KEYS, envKeyCaseTwin, envKeyCaseTwinError } from "../lib/profile-env.js";
import { foldProfileName, looksLikeCredential, profileId, validateProfileName } from "../lib/profile-ref.js";
import {
  CLAUDE_ENV_CATALOG,
  catalogEntry,
  type EnvCatalogEntry,
  type EnvGroup,
  validateEnvEntry,
} from "../tools/claude-env-catalog.js";

/** The model field, promoted out of the Advanced section because nearly every endpoint needs it. */
export const MODEL_KEY = "ANTHROPIC_MODEL";

/**
 * The catalog minus the model, which has its own row above. One editor per variable: two
 * rows writing the same key is how a form comes to disagree with itself about what it will
 * send, which is the disagreement `clausona add --api` refuses outright between `--model`
 * and `--set ANTHROPIC_MODEL`.
 */
export const ADVANCED_ENTRIES: EnvCatalogEntry[] = CLAUDE_ENV_CATALOG.filter((entry) => entry.key !== MODEL_KEY);

const MODEL_ENTRY = CLAUDE_ENV_CATALOG.find((entry) => entry.key === MODEL_KEY);

export type ApiFormState = {
  name: string;
  baseUrl: string;
  authScheme: "bearer" | "api-key";
  /** True once the scheme was chosen by hand, after which the URL stops steering it. */
  authTouched: boolean;
  /** The env map the profile will carry, model included. Blank values are "not set". */
  env: Record<string, string>;
  advancedOpen: boolean;
  /** The free-form row, for a variable the catalog has no entry for. */
  customKey: string;
  customValue: string;
  /** Index into `apiFormFields`. */
  cursor: number;
  /** Field id -> what is wrong with it, shown under that field. */
  errors: Record<string, string>;
};

export function emptyApiForm(): ApiFormState {
  return {
    name: "",
    baseUrl: "",
    authScheme: "bearer",
    authTouched: false,
    env: {},
    advancedOpen: false,
    customKey: "",
    customValue: "",
    cursor: 0,
    errors: {},
  };
}

export type ApiFieldKind = "text" | "secret" | "auth" | "sessions" | "advanced" | "submit" | "env";

export type ApiField = {
  id: string;
  kind: ApiFieldKind;
  /** For an env field: the variable it writes, and its catalog entry when it has one. */
  envKey?: string;
  entry?: EnvCatalogEntry;
};

/** A field whose keystrokes belong to a TextInput, so no bare letter is a shortcut there. */
export function isTypingField(field: ApiField | undefined): boolean {
  return field?.kind === "text" || field?.kind === "secret" || field?.kind === "env";
}

/**
 * The fields, in the order the cursor walks them. The Advanced ones are absent while the
 * section is folded: someone registering a gateway should reach Submit in six steps, not
 * twenty-seven.
 */
export function apiFormFields(form: ApiFormState): ApiField[] {
  const fields: ApiField[] = [
    { id: "name", kind: "text" },
    { id: "baseUrl", kind: "text" },
    { id: "auth", kind: "auth" },
    { id: "key", kind: "secret" },
    { id: "model", kind: "env", envKey: MODEL_KEY, entry: MODEL_ENTRY },
    { id: "sessions", kind: "sessions" },
    { id: "advanced", kind: "advanced" },
  ];
  if (form.advancedOpen) {
    for (const entry of ADVANCED_ENTRIES) {
      fields.push({ id: envFieldId(entry.key), kind: "env", envKey: entry.key, entry });
    }
    // A variable the catalog has no entry for, committed from the free-form row below.
    // Without a row of its own it would be set and invisible.
    for (const key of Object.keys(form.env)) {
      if (key === MODEL_KEY || catalogEntry(key)) continue;
      fields.push({ id: envFieldId(key), kind: "env", envKey: key });
    }
    fields.push({ id: "customKey", kind: "text" }, { id: "customValue", kind: "text" });
  }
  fields.push({ id: "submit", kind: "submit" });
  return fields;
}

export function envFieldId(key: string): string {
  return key === MODEL_KEY ? "model" : `env:${key}`;
}

/** The advanced fields only, which is the run the panel scrolls a window over. */
export function advancedFieldIndexes(fields: ApiField[]): number[] {
  const first = fields.findIndex((field) => field.id === "advanced");
  if (first === -1) return [];
  const last = fields.findIndex((field) => field.id === "submit");
  return fields.map((_, index) => index).filter((index) => index > first && index < last);
}

/** The group a run of advanced fields belongs to, for the heading above it. */
export function fieldGroup(field: ApiField): EnvGroup | "custom" | undefined {
  if (field.kind !== "env") return undefined;
  return field.entry?.group ?? "custom";
}

// ── Validation ───────────────────────────────────────────────────

/**
 * What is wrong with the profile name.
 *
 * The credential shape is tested first and answered separately, exactly as
 * `validateProfileName` does internally - the message below quotes the name, and a key
 * pasted into this field must not be the thing it quotes. The advice differs from the
 * CLI's because the CLI's is about argv: there is no `ps` here and no flag to reach for,
 * only the masked field two rows down.
 */
export function nameError(name: string, existingIds: readonly string[]): string | undefined {
  const trimmed = name.trim();
  if (trimmed === "") return "Enter a profile name.";
  if (looksLikeCredential(trimmed)) return "That looks like an API key, not a name. The key goes in the Key field.";
  const check = validateProfileName(trimmed);
  if (!check.ok) return check.error;
  const id = profileId("claude", trimmed);
  const folded = foldProfileName(id);
  // Folded, not compared literally: `Work` and `work` are one directory on this
  // filesystem, and `addApiProfile` refuses the pair for that reason.
  if (existingIds.some((existing) => foldProfileName(existing) === folded)) {
    return `Profile '${id}' already exists.`;
  }
  return undefined;
}

/**
 * What is wrong with the base URL. The rule is `checkBaseUrl`, which answers with a reason
 * and never the URL; nothing below puts the URL back into the answer, because a URL is
 * where a password would be and the whole point of refusing one is not to carry it around.
 */
export function baseUrlError(baseUrl: string): string | undefined {
  const checked = checkBaseUrl(baseUrl.trim());
  if (checked.ok) return undefined;
  switch (checked.problem.reason) {
    case "empty":
      return "Enter the endpoint's base URL.";
    case "unparseable":
      return "Not a URL - it must be absolute, like https://api.example.com.";
    case "scheme":
      return `The scheme must be http or https, not '${checked.problem.scheme}'.`;
    // Every reason, and no default: a fifth one added to `BaseUrlProblem` should fail to
    // compile here rather than quietly inherit whichever message came last.
    case "credentials":
      return "The URL must not carry a user or password. Put the key in the Key field.";
  }
}

/**
 * What is wrong with one advanced setting, by the rules `addApiProfile` applies to the
 * same pair: `validateEnvEntry`, and then the case-twin check for a name that would be a
 * managed variable on Windows.
 *
 * With one substitution. `validateEnvEntry` repeats the value it refused for a number or
 * bool entry, which is right for a command line - the value is already in the scrollback -
 * and wrong for a form, where a key mis-pasted into "Context window" would be echoed in
 * plain text under the field. Same rule, same refusal; the expectation is named instead of
 * the value. The json branch already refuses to echo, for the same reason.
 */
export function envError(key: string, value: string, others: readonly string[]): string | undefined {
  const result = validateEnvEntry(key, value);
  if (!result.ok) {
    const entry = catalogEntry(key);
    if (looksLikeCredential(value) && (entry?.kind === "number" || entry?.kind === "bool")) {
      return `${key} expects ${entry.kind === "number" ? "a whole number" : "0 or 1"}.`;
    }
    return result.error;
  }
  const twin = envKeyCaseTwin(key, others, "api");
  if (twin !== undefined) return envKeyCaseTwinError(key, twin);
  return undefined;
}

/** What is wrong with the free-form row, and which of its two fields to say it under. */
export function customEntryError(form: ApiFormState): { field: string; message: string } | undefined {
  const key = form.customKey.trim();
  const value = form.customValue;
  if (key === "") {
    if (value.trim() === "") return undefined;
    return { field: "customKey", message: "Name the setting before giving it a value." };
  }
  if (key === MODEL_KEY || catalogEntry(key) || key in form.env) {
    return { field: "customKey", message: `${key} has a field of its own above.` };
  }
  if (value.trim() === "") return { field: "customValue", message: `Give ${key} a value, or clear the name.` };
  const problem = envError(key, value, [...Object.keys(form.env), key]);
  return problem ? { field: "customValue", message: problem } : undefined;
}

export type ApiFormContext = {
  /** Registered profile ids, for the uniqueness check. */
  existingIds: readonly string[];
  /** Whether a key has been typed. The key itself never reaches this module. */
  hasKey: boolean;
};

/** Everything wrong with the form, keyed by field id. Empty means it is ready to submit. */
export function validateApiForm(form: ApiFormState, context: ApiFormContext): Record<string, string> {
  const errors: Record<string, string> = {};
  const name = nameError(form.name, context.existingIds);
  if (name) errors.name = name;
  const url = baseUrlError(form.baseUrl);
  if (url) errors.baseUrl = url;
  if (!context.hasKey) {
    errors.key = "Enter the API key. It goes to the credential store, never to profiles.json.";
  }
  const keys = Object.keys(form.env);
  for (const key of keys) {
    const value = form.env[key];
    // A blank value is "not set" rather than "set to nothing", so it is dropped, not checked.
    if (value.trim() === "") continue;
    const problem = envError(key, value, keys);
    if (problem) errors[envFieldId(key)] = problem;
  }
  const custom = customEntryError(form);
  if (custom) errors[custom.field] = custom.message;
  return errors;
}

/** The env map to send, with blank fields dropped and the free-form row folded in. */
export function apiFormEnv(form: ApiFormState): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(form.env)) {
    if (value.trim() !== "") env[key] = value;
  }
  const customKey = form.customKey.trim();
  if (customKey !== "" && form.customValue.trim() !== "") env[customKey] = form.customValue;
  return env;
}

/**
 * The same message with the key taken out of it.
 *
 * Nothing in the service puts a stored key into what it throws, and this is not a fix for
 * something that does. It is the last thing between a key and the screen on the one path
 * where the key and an arbitrary string meet - an error from the submit - so that a change
 * anywhere below `addApiProfile` cannot turn a failed save into a printed credential.
 *
 * A very short secret is left alone: it is not a credential, and splitting a message on it
 * would shred the message for nothing.
 */
const MIN_SCRUBBABLE_SECRET = 4;

export function scrubSecret(message: string, secret: string): string {
  if (secret.length < MIN_SCRUBBABLE_SECRET) return message;
  return message.split(secret).join("<redacted>");
}

/**
 * What to say under a field while it is being typed in, which is not what to say when
 * Submit is pressed: an empty field is unfinished rather than wrong, and a form that reads
 * "Enter a profile name." before a name has been entered is nagging, not helping.
 */
export function liveApiFieldError(
  field: ApiField,
  form: ApiFormState,
  existingIds: readonly string[],
): string | undefined {
  if (field.id === "name") return form.name.trim() === "" ? undefined : nameError(form.name, existingIds);
  if (field.id === "baseUrl") return form.baseUrl.trim() === "" ? undefined : baseUrlError(form.baseUrl);
  if (field.kind === "env" && field.envKey) {
    const value = form.env[field.envKey] ?? "";
    return value.trim() === "" ? undefined : envError(field.envKey, value, Object.keys(form.env));
  }
  // The free-form row is not here: what is wrong with it is not always wrong at the field
  // being typed in, so it is judged as a whole by `customEntryError` and its message is
  // placed at the field that one names.
  return undefined;
}

/** The endpoint's host, for the line that reports the profile was added. Empty until the URL parses. */
export function apiFormHost(form: ApiFormState): string {
  const checked = checkBaseUrl(form.baseUrl.trim());
  // `host` carries no userinfo - checkBaseUrl refuses a URL that has any - so this cannot
  // put a credential into the success line.
  return checked.ok ? checked.url.host : "";
}

/** The scheme to offer for an endpoint, while the user has not chosen one. */
export function defaultAuthScheme(baseUrl: string): "bearer" | "api-key" {
  const checked = checkBaseUrl(baseUrl.trim());
  return checked.ok && isAnthropicHost(checked.url.hostname) ? "api-key" : "bearer";
}

/** The same record without the named keys, for clearing an error once its field is fixed. */
export function withoutKeys(errors: Record<string, string>, ...ids: string[]): Record<string, string> {
  const next = { ...errors };
  for (const id of ids) delete next[id];
  return next;
}

/**
 * A note under a setting whose name is one Claude Code reads a credential from, and whose
 * value therefore sits in plain text in profiles.json.
 *
 * The same thing `clausona add --api` prints after a `--set`, and non-blocking for the
 * same reason: a legitimate non-secret header override goes through the same map, so this
 * says what happened rather than refusing it. The doctor reports it again afterwards.
 */
export function plaintextSecretNote(key: string, value: string): string | undefined {
  if (value.trim() === "" || !(CREDENTIAL_ENV_KEYS as readonly string[]).includes(key)) return undefined;
  return `${key} is stored in plain text in profiles.json - an API key belongs in the Key field.`;
}
