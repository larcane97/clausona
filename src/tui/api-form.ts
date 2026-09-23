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

import { checkBaseUrl, sendsKeyInCleartext } from "../core/api-url.js";
import { carriesCredentialToken } from "../core/credential-token.js";
import { envKeyCaseTwin, envKeyCaseTwinError, isSecretEnvName } from "../lib/profile-env.js";
import { foldProfileName, looksLikeCredential, profileId, validateProfileName } from "../lib/profile-ref.js";
import type { SecretChunk, SecretInputState } from "../lib/prompt-secret.js";
import { hidesEnvValue, isCredentialEnvKey } from "../lib/redact.js";
import { defaultAuthScheme } from "../lib/service.js";
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

// ── What the form says about a key ───────────────────────────────
//
// The panel cuts an error to one line, and at an 80-column terminal the line has 66 columns.
// So each of these fits in 66 and leads with what to do: when one did not fit, the part cut
// off was the way out - "ctrl-u" was past column 100.

/** A key in a field that draws what it holds, from the name to the free-form row. */
export const MISPLACED_KEY = "That looks like an API key - it goes in the API key field.";

/** Submit with nothing in the key field. */
export const KEY_REQUIRED = "Enter the API key. It goes to the credential store.";

/**
 * Ruling 98: the key had a space or a line break inside it once its ends were trimmed - two
 * pasted lines, or a key and what came after it. `hasInnerWhitespace` is the rule, the prompt's
 * too; the field is cleared, because what it holds cannot be seen to be fixed.
 */
export const KEY_HAS_WHITESPACE = "Paste the key again - it had a space or a line break inside.";

/**
 * The terminal sent something the key field's reader cannot measure, so where it ended is a
 * guess. The situation, and the refusal, are `prompt-secret.ts`'s; the words are not, because
 * the prompt's way out is to pipe the key in and a form has no pipe behind it.
 */
export const UNREADABLE_KEY_INPUT = "Paste the key again - unreadable input cleared the field.";

/**
 * A paste whose closing bracket arrived with no opening one: its start went somewhere else,
 * so what the field held was the back of a key, and it has been cleared.
 */
export const LOST_PASTE_START = "Paste the key again - only its end arrived, so it was cleared.";

/**
 * Input is going nowhere: a paste that began as the cursor moved is being dropped to its end,
 * and the end has not arrived. Shown under whichever field has the cursor; an arrow key ends it.
 */
export const PASTE_SKIPPED = "Press an arrow key to type here - the rest of a paste is skipped.";

/** A paste whose closing bracket has not arrived: what is in the field is the front of a key. */
export const UNFINISHED_PASTE = "Clear it with ctrl-u and paste again: the paste never finished.";

/** A sequence still arriving: real bytes are parked behind it. */
export const UNFINISHED_SEQUENCE = "Clear it with ctrl-u and paste again: part of the key is unread.";

/**
 * The key field could not get at ink's input events, and there is no other reader it would
 * trust - see App.tsx. The way out is the CLI, so the command is what comes first.
 */
export const NO_RAW_KEY_INPUT = "Use clausona add --api --key-from env:NAME instead of this field.";

/** Every message the key field can show, for the test that holds them to one line. */
export const KEY_FIELD_MESSAGES = {
  MISPLACED_KEY,
  KEY_REQUIRED,
  KEY_HAS_WHITESPACE,
  UNREADABLE_KEY_INPUT,
  LOST_PASTE_START,
  PASTE_SKIPPED,
  UNFINISHED_PASTE,
  UNFINISHED_SEQUENCE,
  NO_RAW_KEY_INPUT,
} as const;

/**
 * What the key field says when its reader gives up on what arrived. The field has been
 * cleared either way; the message says why, and that pasting again is the way on.
 */
export function keyReadRefusal(problem: NonNullable<SecretChunk["problem"]>): string {
  switch (problem) {
    case "unreadable":
      return UNREADABLE_KEY_INPUT;
    case "lost-paste-start":
      return LOST_PASTE_START;
    default: {
      // A third reason added to `SecretChunk` fails to compile here, rather than clearing the
      // field under whichever message a fall-through happened to pick.
      const unhandled: never = problem;
      throw new Error(`unhandled key input problem: ${JSON.stringify(unhandled)}`);
    }
  }
}

/**
 * Why the key field cannot be saved from as it stands, beyond being empty.
 *
 * There being no reader at all is reachable, from a host that renders its own StdinContext
 * without ink's input events. The other two - the reader holding part of something, an open
 * paste or a sequence still arriving - are not reachable through the keyboard today: the field
 * holds the cursor while a paste is open, leaving it settles a sequence, and input for a field
 * the cursor has left is dropped. They stay because what they guard is a credential stored
 * wrong, and "unreachable" is a property of those three other places rather than of the save.
 */
export function keyInputRefusal(input: SecretInputState, canRead: boolean): string | undefined {
  if (!canRead) return NO_RAW_KEY_INPUT;
  if (input.pending !== "") return UNFINISHED_SEQUENCE;
  if (input.pasting) return UNFINISHED_PASTE;
  return undefined;
}

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
  /**
   * Where the text cursor is inside a field: the field it was last moved or typed in, and the
   * offset. Every other field has it at the end of its value - see `caretIn`.
   */
  caret?: { field: string; at: number };
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

/** A field whose keystrokes belong to a text input, so no bare letter is a shortcut there. */
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
  if (looksLikeCredential(trimmed) || carriesCredentialToken(trimmed)) return MISPLACED_KEY;
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
    case "credentials":
      return "The URL must not carry a user or password. Put the key in the Key field.";
    case "key-shaped":
      return MISPLACED_KEY;
    default: {
      // Every reason, and a default that cannot be reached: a fifth one added to
      // `BaseUrlProblem` fails to compile here. Leaving the switch open instead returns
      // `undefined` for the new reason, which is this function's word for "nothing is
      // wrong" - a URL the checker refused, shown with no error under it.
      const unhandled: never = checked.problem;
      throw new Error(`unhandled base URL problem: ${JSON.stringify(unhandled)}`);
    }
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
  // First, so that no message below gets as far as quoting it. Not under a name whose value
  // is hidden on every output path: a header or a request body is where a gateway takes a key.
  if (!hidesEnvValue(key) && carriesCredentialToken(value)) return MISPLACED_KEY;
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
  // Before anything that names the setting: two of the messages below quote it.
  if (carriesCredentialToken(key)) return { field: "customKey", message: MISPLACED_KEY };
  if (!hidesEnvValue(key) && carriesCredentialToken(value)) return { field: "customValue", message: MISPLACED_KEY };
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
  if (!context.hasKey) errors.key = KEY_REQUIRED;
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

/**
 * The scheme to offer for what the Endpoint field holds, while the user has not chosen one:
 * `defaultAuthScheme`, the rule `add --api` and `config --base-url` apply to a host - and bearer
 * until the field holds a URL with a host to apply it to.
 */
export function offeredAuthScheme(baseUrl: string): "bearer" | "api-key" {
  const checked = checkBaseUrl(baseUrl.trim());
  return checked.ok ? defaultAuthScheme(checked.url.hostname) : "bearer";
}

/** The same record without the named keys, for clearing an error once its field is fixed. */
export function withoutKeys(errors: Record<string, string>, ...ids: string[]): Record<string, string> {
  const next = { ...errors };
  for (const id of ids) delete next[id];
  return next;
}

/**
 * A note under a setting whose name says it holds a secret, and whose value therefore sits in
 * plain text in profiles.json.
 *
 * What `clausona add --api` prints after a `--set`: for the same names - `isSecretEnvName`, as
 * the doctor's finding too - and with the same advice for each, in the form's terms. A variable
 * Claude Code reads its key from gets the Key field, where the CLI names the credential store;
 * another service's secret gets the shell's environment, and what that costs - every claude
 * profile launched from that shell gets it - since the Key field is no answer for it.
 * Non-blocking for the CLI's reason: a legitimate non-secret header override goes through the
 * same map, so this says what happened rather than refusing it. The doctor reports it again.
 */
export function plaintextSecretNote(key: string, value: string): string | undefined {
  if (value.trim() === "" || !isSecretEnvName(key)) return undefined;
  const stored = `${key} is stored in plain text in profiles.json`;
  if (isCredentialEnvKey(key)) return `${stored} - an API key belongs in the Key field.`;
  return `${stored}. If it carries a secret, your shell's environment can hold it instead - but the hook then passes it to every claude profile launched from that shell, not just this one. If only this profile should have it, leave it here: output hides it.`;
}

/**
 * A note under the endpoint when it would carry the key unencrypted off this machine: the words
 * `config --base-url` prints for the same URL, by the same rule (`sendsKeyInCleartext`). Not a
 * refusal - a server on the local network is a legitimate endpoint - and nothing until the URL
 * parses. The host carries no userinfo: `checkBaseUrl` refuses a URL with any.
 */
export function cleartextNote(baseUrl: string): string | undefined {
  const checked = checkBaseUrl(baseUrl.trim());
  if (!checked.ok || !sendsKeyInCleartext(checked.url)) return undefined;
  return `${checked.url.host} is plain http, so the key crosses the network unencrypted.`;
}

// ── Fields that draw what they hold ──────────────────────────────

/** What a field other than the key draws: its own value, from wherever the form keeps it. */
export function fieldValue(field: ApiField, form: ApiFormState): string {
  if (field.kind === "env") return form.env[field.envKey ?? ""] ?? "";
  if (field.id === "name") return form.name;
  if (field.id === "baseUrl") return form.baseUrl;
  if (field.id === "customKey") return form.customKey;
  if (field.id === "customValue") return form.customValue;
  return "";
}

/**
 * Where the text cursor is in a field: where it was left, if that was in this field, and at the
 * end of the value otherwise - where a text input puts it when it is first drawn. Clamped, as a
 * value can shrink under it (a masked value is cleared on the first erase).
 */
export function caretIn(field: ApiField, form: ApiFormState): number {
  const length = fieldValue(field, form).length;
  return form.caret?.field === field.id ? Math.max(0, Math.min(form.caret.at, length)) : length;
}

/** The variable a field's value would be stored under, when it writes the env map at all. */
function storedUnder(field: ApiField, form: ApiFormState): string | undefined {
  if (field.kind === "env") return field.envKey;
  if (field.id === "customValue") return form.customKey.trim();
  return undefined;
}

/**
 * Whether a field shows a mask instead of what it holds.
 *
 * Every field but the key draws its value, one glyph per character, and whatever routes input
 * to them a key can still end up in one: pasted into the wrong row, or routed there by a gap
 * nobody has found. So none of them draws one:
 *
 * - a value stored under a name every output path hides - a credential variable such as
 *   ANTHROPIC_CUSTOM_HEADERS, or a json setting - is masked whatever it holds. A key is
 *   legitimate there, and `config --show` would print none of it, so neither does the form;
 * - a name the name rule refuses as a key is masked, as that rule is the one the field's
 *   message comes from;
 * - anything else is masked when it carries something shaped like a key, anywhere in it -
 *   `carriesCredentialToken`, which says what it misses.
 *
 * Masked means the constant the key field shows (ApiForm.tsx), not a glyph per character.
 */
export function concealsValue(field: ApiField, form: ApiFormState): boolean {
  const value = fieldValue(field, form);
  if (value === "") return false;
  const under = storedUnder(field, form);
  if (under && hidesEnvValue(under)) return true;
  if (field.id === "name" && looksLikeCredential(value.trim())) return true;
  return carriesCredentialToken(value);
}

/**
 * The form as it is left, with every key it holds outside the key field dropped.
 *
 * The key field is cleared on every way out of the form; a key sitting in a plain field is
 * the same key, and the form is remembered for as long as the add flow is open. What stays
 * is what the form would have taken: a setting where a key belongs keeps it.
 */
export function withoutMisplacedKeys(form: ApiFormState): ApiFormState {
  const misplaced = (value: string) => carriesCredentialToken(value);
  const env = Object.fromEntries(
    Object.entries(form.env).map(([key, value]) => [key, !hidesEnvValue(key) && misplaced(value) ? "" : value]),
  );
  const next: ApiFormState = {
    ...form,
    name: looksLikeCredential(form.name.trim()) || misplaced(form.name) ? "" : form.name,
    baseUrl: misplaced(form.baseUrl) ? "" : form.baseUrl,
    env,
    customKey: misplaced(form.customKey) ? "" : form.customKey,
    customValue: !hidesEnvValue(form.customKey.trim()) && misplaced(form.customValue) ? "" : form.customValue,
  };
  const changed = (Object.keys(next) as (keyof ApiFormState)[]).some(
    (key) => JSON.stringify(next[key]) !== JSON.stringify(form[key]),
  );
  return changed ? next : form;
}
