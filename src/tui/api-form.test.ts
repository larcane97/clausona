import { describe, expect, it } from "vitest";

import { EMPTY_SECRET_INPUT } from "../lib/prompt-secret.js";
import {
  ADVANCED_ENTRIES,
  type ApiField,
  type ApiFormState,
  apiFormEnv,
  apiFormFields,
  baseUrlError,
  concealsValue,
  customEntryError,
  emptyApiForm,
  envError,
  KEY_FIELD_MESSAGES,
  keyInputRefusal,
  keyReadRefusal,
  LOST_PASTE_START,
  liveApiFieldError,
  MISPLACED_KEY,
  MODEL_KEY,
  NO_RAW_KEY_INPUT,
  nameError,
  offeredAuthScheme,
  plaintextSecretNote,
  scrubSecret,
  UNFINISHED_PASTE,
  UNFINISHED_SEQUENCE,
  UNREADABLE_KEY_INPUT,
  validateApiForm,
  withoutMisplacedKeys,
} from "./api-form.js";

/** A key shape, for the fields it must never reach or be echoed from. */
const KEY = "sk-ant-api03-not-a-real-key-0000000000000000";

function form(overrides: Partial<ApiFormState> = {}): ApiFormState {
  return { ...emptyApiForm(), ...overrides };
}

describe("the name field", () => {
  it("takes a name the allowlist allows", () => {
    expect(nameError("gpu-box", [])).toBeUndefined();
  });

  it("asks for one rather than complaining about the empty string", () => {
    expect(nameError("  ", [])).toBe("Enter a profile name.");
  });

  it("refuses a name that would escape the profile directory, and says why", () => {
    expect(nameError("../evil", [])).toMatch(/Invalid profile name/);
  });

  it("refuses a key pasted into it without putting the key in the message", () => {
    const message = nameError(KEY, []);

    expect(message).toMatch(/looks like an API key/);
    expect(message).not.toContain(KEY);
    expect(message).not.toContain("sk-");
  });

  it("refuses a name too long to be one, again without echoing it", () => {
    const long = "a".repeat(65);
    const message = nameError(long, []);

    expect(message).toMatch(/looks like an API key/);
    expect(message).not.toContain(long);
  });

  it("refuses a name a registered profile already holds, whatever its case", () => {
    // `Work` and `work` are one directory on a case-insensitive filesystem, which is why
    // addApiProfile refuses the pair - the form has to refuse it in the same place.
    expect(nameError("Work", ["claude:work"])).toBe("Profile 'claude:Work' already exists.");
    expect(nameError("work", ["claude:work"])).toBe("Profile 'claude:work' already exists.");
  });

  it("leaves a name taken under the other tool alone", () => {
    expect(nameError("work", ["codex:work"])).toBeUndefined();
  });
});

describe("the endpoint field", () => {
  it("takes an absolute https URL", () => {
    expect(baseUrlError("https://api.example.com")).toBeUndefined();
  });

  it("takes an http URL, which is how a local server is reached", () => {
    expect(baseUrlError("http://localhost:8080")).toBeUndefined();
  });

  it("asks for a URL rather than reporting the empty string", () => {
    expect(baseUrlError("")).toBe("Enter the endpoint's base URL.");
  });

  it("refuses a relative URL without repeating it", () => {
    const message = baseUrlError("api.example.com/v1");

    expect(message).toMatch(/must be absolute/);
    expect(message).not.toContain("api.example.com/v1");
  });

  it("names the scheme it refused, which is the one part of a URL that cannot hide a password", () => {
    expect(baseUrlError("ftp://files.example.com")).toBe("The scheme must be http or https, not 'ftp'.");
  });

  it("refuses a URL carrying credentials and repeats neither the URL nor the password", () => {
    const message = baseUrlError("https://alice:hunter2@api.example.com");

    expect(message).toMatch(/must not carry a user or password/);
    expect(message).not.toContain("hunter2");
    expect(message).not.toContain("alice");
    expect(message).not.toContain("api.example.com");
  });

  it("refuses a URL whose password is a key, and does not print the key", () => {
    const message = baseUrlError(`https://x:${KEY}@api.example.com`);

    expect(message).not.toContain(KEY);
  });

  it.each([
    ["glued to its host, as input meant for the key field leaves it", `https://gateway.example.com${KEY}`],
    ["in its path", `https://gateway.example.com/v1/${KEY}`],
    ["in its query", `https://gateway.example.com/v1?key=${KEY}`],
    ["pasted in place of the URL", KEY],
  ])("refuses a URL carrying a key %s, and says where the key goes instead", (_where, url) => {
    const message = baseUrlError(url);

    expect(message).toBe("That looks like an API key - it goes in the API key field.");
  });
});

describe("the auth scheme offered for an endpoint", () => {
  it.each([
    ["Anthropic itself", "https://api.anthropic.com", "api-key"],
    ["the apex domain", "https://anthropic.com", "api-key"],
    ["a gateway", "https://gateway.example.com", "bearer"],
    ["a look-alike domain", "https://evilanthropic.com", "bearer"],
    ["a URL that does not parse yet", "https:/", "bearer"],
  ])("offers %s the %s scheme", (_case, url, expected) => {
    expect(offeredAuthScheme(url)).toBe(expected);
  });
});

describe("an advanced setting", () => {
  it("takes a number for a number entry", () => {
    expect(envError("CLAUDE_CODE_MAX_CONTEXT_TOKENS", "262144", [])).toBeUndefined();
  });

  it("refuses a name no shell could export", () => {
    expect(envError("not a name", "1", [])).toMatch(/not a valid environment variable name/);
  });

  it("refuses a name clausona manages", () => {
    expect(envError("CLAUDE_CONFIG_DIR", "/tmp", [])).toMatch(/managed by clausona/);
  });

  it("refuses a name that differs from a managed one only in case", () => {
    expect(envError("anthropic_base_url", "https://x.example.com", [])).toMatch(/differs from ANTHROPIC_BASE_URL/);
  });

  it("refuses a value of the wrong shape, quoting it so the field can be corrected", () => {
    expect(envError("CLAUDE_CODE_MAX_CONTEXT_TOKENS", "lots", [])).toBe(
      "CLAUDE_CODE_MAX_CONTEXT_TOKENS expects a whole number, got 'lots'",
    );
    expect(envError("DISABLE_AUTO_COMPACT", "yes", [])).toBe("DISABLE_AUTO_COMPACT expects 0 or 1, got 'yes'");
  });

  it.each([
    ["a number field", "CLAUDE_CODE_MAX_CONTEXT_TOKENS"],
    ["a bool field", "DISABLE_PROMPT_CACHING"],
  ])("refuses a key mis-pasted into %s by saying where it goes, without echoing it", (_field, name) => {
    // The shared validator quotes the value it refused, which is right on a command line
    // and wrong here: this is the field next to the masked one, and a mis-pasted key would
    // otherwise be printed in full under it.
    const message = envError(name, KEY, []);

    expect(message).toBe(MISPLACED_KEY);
    expect(message).not.toContain(KEY);
  });

  it.each([
    ["a number field", "CLAUDE_CODE_MAX_CONTEXT_TOKENS", "CLAUDE_CODE_MAX_CONTEXT_TOKENS expects a whole number."],
    ["a bool field", "DISABLE_PROMPT_CACHING", "DISABLE_PROMPT_CACHING expects 0 or 1."],
  ])("names what %s expects, not the value, for one the name rule calls a key", (_field, name, expected) => {
    // Too short to be a key by shape, and still `sk-`: the name rule's line, and the
    // validator would have quoted it.
    const message = envError(name, "sk-abc", []);

    expect(message).toBe(expected);
    expect(message).not.toContain("sk-abc");
  });

  it("never echoes what it could not parse as JSON", () => {
    const message = envError("CLAUDE_CODE_EXTRA_BODY", `{"auth": "${KEY}"`, []);

    expect(message).toBe("CLAUDE_CODE_EXTRA_BODY expects a JSON object");
    expect(message).not.toContain(KEY);
  });

  it("takes a long header block, which is not a credential just because it is long", () => {
    // The name check has a length ceiling - a name over it is a key - and applying that
    // ceiling to a value would refuse a perfectly ordinary multi-line header override.
    const headers = Array.from({ length: 6 }, (_, i) => `X-Custom-Header-${i}: value-${i}`).join("\n");

    expect(headers.length).toBeGreaterThan(64);
    expect(envError("ANTHROPIC_CUSTOM_HEADERS", headers, [])).toBeUndefined();
  });

  it("says when a setting will be stored in plain text, without refusing it", () => {
    expect(plaintextSecretNote("ANTHROPIC_CUSTOM_HEADERS", "X-Api-Key: abc")).toMatch(/stored in plain text/);
    expect(plaintextSecretNote("ANTHROPIC_CUSTOM_HEADERS", "")).toBeUndefined();
    expect(plaintextSecretNote("CLAUDE_CODE_MAX_RETRIES", "3")).toBeUndefined();
  });

  it("says it for every name `add --api --set` and doctor call secret, in their words for each", () => {
    // The CLI and doctor go by `isSecretEnvName`, the form went by the clear list alone - so
    // another service's token got no note here, and only here.
    const own = plaintextSecretNote("ANTHROPIC_AUTH_TOKEN", "abc");
    const other = plaintextSecretNote("MY_SERVICE_TOKEN", "abc");

    expect(own).toMatch(/^ANTHROPIC_AUTH_TOKEN is stored in plain text in profiles\.json/);
    expect(own).toMatch(/an API key belongs in the Key field/);
    // Not this profile's key, so the Key field is the wrong advice; the CLI's is the shell.
    expect(other).toMatch(/^MY_SERVICE_TOKEN is stored in plain text in profiles\.json/);
    expect(other).toMatch(/your shell's environment can hold it instead/);
    expect(other).toMatch(/every claude profile launched from that shell/);
    expect(other).not.toMatch(/Key field/);
    expect(plaintextSecretNote("MAX_THINKING_TOKENS", "8000")).toBeUndefined();
  });
});

describe("the free-form row", () => {
  it("is fine while both halves are empty", () => {
    expect(customEntryError(form())).toBeUndefined();
  });

  it("asks for a name before a value", () => {
    expect(customEntryError(form({ customValue: "1" }))?.field).toBe("customKey");
  });

  it("asks for a value once a name is given", () => {
    expect(customEntryError(form({ customKey: "MY_VAR" }))?.field).toBe("customValue");
  });

  it("sends a catalog variable back to its own field", () => {
    expect(customEntryError(form({ customKey: "API_TIMEOUT_MS", customValue: "1000" }))?.message).toBe(
      "API_TIMEOUT_MS has a field of its own above.",
    );
    expect(customEntryError(form({ customKey: MODEL_KEY, customValue: "x" }))?.message).toMatch(/field of its own/);
  });

  it("applies the same value rules as a catalog field", () => {
    expect(customEntryError(form({ customKey: "not a name", customValue: "1" }))?.message).toMatch(/not a valid/);
  });

  it("takes a variable the catalog has never heard of", () => {
    expect(customEntryError(form({ customKey: "SOME_FUTURE_VAR", customValue: "1" }))).toBeUndefined();
  });
});

describe("the fields the cursor walks", () => {
  it("stops before the advanced settings while the section is folded", () => {
    const ids = apiFormFields(form()).map((field) => field.id);

    expect(ids).toEqual(["name", "baseUrl", "auth", "key", "model", "sessions", "advanced", "submit"]);
  });

  it("adds every catalog setting and the free-form row when it is open", () => {
    const ids = apiFormFields(form({ advancedOpen: true })).map((field) => field.id);

    expect(ids).toHaveLength(8 + ADVANCED_ENTRIES.length + 2);
    expect(ids).toContain("env:CLAUDE_CODE_MAX_CONTEXT_TOKENS");
    expect(ids.at(-1)).toBe("submit");
  });

  it("gives the model one field, not two", () => {
    // Promoted to the top and left out of the section below it. Two rows writing the same
    // variable is the disagreement `add --api` refuses between --model and --set.
    const ids = apiFormFields(form({ advancedOpen: true })).map((field) => field.id);

    expect(ids.filter((id) => id === "model" || id === `env:${MODEL_KEY}`)).toEqual(["model"]);
    expect(ADVANCED_ENTRIES.map((entry) => entry.key)).not.toContain(MODEL_KEY);
  });

  it("gives a committed free-form setting a field of its own, so it is not set invisibly", () => {
    const ids = apiFormFields(form({ advancedOpen: true, env: { SOME_FUTURE_VAR: "1" } })).map((field) => field.id);

    expect(ids).toContain("env:SOME_FUTURE_VAR");
  });
});

describe("what the form would send", () => {
  it("drops a setting left blank rather than sending an empty value", () => {
    expect(apiFormEnv(form({ env: { [MODEL_KEY]: "glm-4.6", API_TIMEOUT_MS: "  " } }))).toEqual({
      [MODEL_KEY]: "glm-4.6",
    });
  });

  it("folds an uncommitted free-form pair in, so reaching Submit does not lose it", () => {
    expect(apiFormEnv(form({ customKey: "SOME_FUTURE_VAR", customValue: "1" }))).toEqual({ SOME_FUTURE_VAR: "1" });
  });
});

describe("the whole form, on submit", () => {
  const ready = form({ name: "gpu-box", baseUrl: "https://gateway.example.com" });

  it("is ready when every field is", () => {
    expect(validateApiForm(ready, { existingIds: [], hasKey: true })).toEqual({});
  });

  it("asks for the key before anything is created", () => {
    expect(validateApiForm(ready, { existingIds: [], hasKey: false }).key).toMatch(/Enter the API key/);
  });

  it("reports every field that is wrong at once, keyed to the field", () => {
    const errors = validateApiForm(form({ name: "", baseUrl: "nope", env: { API_TIMEOUT_MS: "soon" } }), {
      existingIds: [],
      hasKey: true,
    });

    expect(Object.keys(errors).sort()).toEqual(["baseUrl", "env:API_TIMEOUT_MS", "name"]);
  });

  it("ignores a setting left blank", () => {
    expect(validateApiForm({ ...ready, env: { API_TIMEOUT_MS: "" } }, { existingIds: [], hasKey: true })).toEqual({});
  });
});

describe("what is said while a field is still being typed in", () => {
  const nameField = { id: "name", kind: "text" } as const;
  const urlField = { id: "baseUrl", kind: "text" } as const;

  it("says nothing about a field nobody has typed in yet", () => {
    expect(liveApiFieldError(nameField, form(), [])).toBeUndefined();
    expect(liveApiFieldError(urlField, form(), [])).toBeUndefined();
  });

  it("says what is wrong as soon as there is something wrong to say", () => {
    expect(liveApiFieldError(nameField, form({ name: "../evil" }), [])).toMatch(/Invalid profile name/);
    expect(liveApiFieldError(urlField, form({ baseUrl: "ftp://x" }), [])).toMatch(/http or https/);
  });

  it("catches a key pasted into the name field on the keystroke, not at submit", () => {
    const message = liveApiFieldError(nameField, form({ name: KEY }), []);

    expect(message).toMatch(/looks like an API key/);
    expect(message).not.toContain(KEY);
  });
});

describe("scrubbing a key out of a message", () => {
  it("takes it out wherever it appears", () => {
    expect(scrubSecret(`sent ${KEY} to the store, ${KEY} failed`, KEY)).toBe(
      "sent <redacted> to the store, <redacted> failed",
    );
  });

  it("leaves a message that does not carry it alone", () => {
    expect(scrubSecret("Profile 'claude:x' already exists.", KEY)).toBe("Profile 'claude:x' already exists.");
  });

  it("leaves a message alone rather than shredding it over something too short to be a key", () => {
    expect(scrubSecret("a b c", "")).toBe("a b c");
    expect(scrubSecret("a b c", "a")).toBe("a b c");
  });
});

/**
 * Ruling 88's second layer: a field that draws what it holds never draws a key.
 *
 * The first layer - input goes only to the field under the cursor - is App.tsx's, and is what
 * keeps a key from landing in the wrong field. This is what happens when one lands anyway: a
 * key pasted into the wrong row on purpose, or a token that layer did not see. The field shows
 * a mask instead, and says where the key goes.
 */
describe("a key in a field that draws what it holds", () => {
  const field = (id: string): ApiField => {
    const found = apiFormFields(form({ advancedOpen: true })).find((candidate) => candidate.id === id);
    if (!found) throw new Error(`no field ${id}`);
    return found;
  };
  const model = field("model");
  const headers = field("env:ANTHROPIC_CUSTOM_HEADERS");
  const body = field("env:CLAUDE_CODE_EXTRA_BODY");

  it.each([
    ["the name", field("name"), form({ name: KEY })],
    [
      "the endpoint, with the key glued to its host",
      field("baseUrl"),
      form({ baseUrl: `https://gw.example.com${KEY}` }),
    ],
    ["the model", model, form({ env: { [MODEL_KEY]: KEY } })],
    ["the model, after a model id", model, form({ env: { [MODEL_KEY]: `glm-5${KEY}` } })],
    ["the free-form row's name", field("customKey"), form({ customKey: KEY })],
    ["the free-form row's value", field("customValue"), form({ customKey: "MY_VAR", customValue: KEY })],
  ])("conceals one in %s", (_where, target, state) => {
    expect(concealsValue(target, state)).toBe(true);
  });

  it.each([
    ["a name", field("name"), form({ name: "gpu-box" })],
    ["an endpoint", field("baseUrl"), form({ baseUrl: "https://gateway.example.com/v1" })],
    ["a model id", model, form({ env: { [MODEL_KEY]: "Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8" } })],
    ["an empty field", model, form()],
    ["an ordinary setting", field("customValue"), form({ customKey: "MY_VAR", customValue: "1" })],
  ])("draws %s as it is", (_what, target, state) => {
    expect(concealsValue(target, state)).toBe(false);
  });

  it("conceals a name the name rule already refuses as a key, even one too short to be a token", () => {
    expect(concealsValue(field("name"), form({ name: "sk-" }))).toBe(true);
  });

  it.each([
    ["any value", model, form({ env: { [MODEL_KEY]: KEY } })],
    ["the name", field("name"), form({ name: `work${KEY}` })],
  ])("says where the key goes, in words that do not repeat it, for %s", (_what, target, state) => {
    const message = liveApiFieldError(target, state, []);

    expect(message).toBe(MISPLACED_KEY);
    expect(message).not.toContain(KEY.slice(13, 25));
  });

  it("refuses a key in the model at submit, which would store it in plain text", () => {
    const errors = validateApiForm(
      form({ name: "gpu-box", baseUrl: "https://gateway.example.com", env: { [MODEL_KEY]: KEY } }),
      { existingIds: [], hasKey: true },
    );

    expect(errors).toEqual({ model: MISPLACED_KEY });
  });

  it("refuses a key typed as a setting's name, without echoing it in the name's messages", () => {
    expect(customEntryError(form({ customKey: KEY, customValue: "1" }))).toEqual({
      field: "customKey",
      message: MISPLACED_KEY,
    });
  });

  it("refuses a key typed as the value before any name, at the value", () => {
    // Rather than asking for a name first, which is true and not the problem.
    expect(customEntryError(form({ customKey: "", customValue: KEY }))).toEqual({
      field: "customValue",
      message: MISPLACED_KEY,
    });
  });

  it("refuses a key as the value of an ordinary setting", () => {
    expect(customEntryError(form({ customKey: "MY_VAR", customValue: KEY }))).toEqual({
      field: "customValue",
      message: MISPLACED_KEY,
    });
  });

  /**
   * The decision the brief asked for. A header carrying a key is what ANTHROPIC_CUSTOM_HEADERS
   * is for - a gateway that wants `x-api-key` alongside Authorization - and a json body is where
   * a self-hosted gateway takes its auth field. Every output path already hides both whole
   * (src/lib/redact.ts), so the form does too: always masked, whatever they hold, and never
   * refused for holding a key. The plain-text note under the row is still what warns.
   */
  describe("where a key belongs: a credential variable and a json setting", () => {
    it.each([
      [
        "a header with a key in it",
        headers,
        form({ env: { ANTHROPIC_CUSTOM_HEADERS: `Authorization: Bearer ${KEY}` } }),
      ],
      ["a header with no key in it", headers, form({ env: { ANTHROPIC_CUSTOM_HEADERS: "X-Team: infra" } })],
      ["a request body", body, form({ env: { CLAUDE_CODE_EXTRA_BODY: '{"temperature":0}' } })],
      [
        "a credential variable set from the free-form row",
        field("customValue"),
        form({ customKey: "ANTHROPIC_AUTH_TOKEN", customValue: "abc" }),
      ],
    ])("conceals %s", (_what, target, state) => {
      expect(concealsValue(target, state)).toBe(true);
    });

    it.each([
      ["ANTHROPIC_CUSTOM_HEADERS", `Authorization: Bearer ${KEY}`],
      ["CLAUDE_CODE_EXTRA_BODY", `{"api_key":"${KEY}"}`],
      ["ANTHROPIC_AUTH_TOKEN", KEY],
    ])("takes a key in %s without refusing it", (name, value) => {
      expect(envError(name, value, [])).toBeUndefined();
    });

    it.each([
      "CLAUDE_CODE_OAUTH_TOKEN",
      "ANTHROPIC_IDENTITY_TOKEN",
    ])("takes a key in the free-form row under %s without refusing it", (name) => {
      // The other half of the decision: not only the catalog's header row, but any credential
      // variable a person names themselves.
      expect(customEntryError(form({ customKey: name, customValue: KEY }))).toBeUndefined();
    });

    it("keeps a key under a credential name in the free-form row when the form is left", () => {
      // It was never refused, so it is not one of the misplaced keys leaving the form forgets.
      const state = form({ customKey: "CLAUDE_CODE_OAUTH_TOKEN", customValue: KEY });

      expect(withoutMisplacedKeys(state)).toEqual(state);
    });

    it("still says the header will sit in plain text", () => {
      expect(plaintextSecretNote("ANTHROPIC_CUSTOM_HEADERS", `Authorization: Bearer ${KEY}`)).toMatch(/plain text/);
    });
  });

  it("forgets every key it refused when the form is left, and nothing else", () => {
    // The key field is cleared on the way out; a key sitting in a plain field is the same key.
    const left = withoutMisplacedKeys(
      form({
        name: KEY,
        baseUrl: `https://gw.example.com${KEY}`,
        env: { [MODEL_KEY]: KEY, API_TIMEOUT_MS: "600000", ANTHROPIC_CUSTOM_HEADERS: `x-api-key: ${KEY}` },
        customKey: "MY_VAR",
        customValue: KEY,
      }),
    );

    expect(left).toEqual(
      form({
        name: "",
        baseUrl: "",
        env: { [MODEL_KEY]: "", API_TIMEOUT_MS: "600000", ANTHROPIC_CUSTOM_HEADERS: `x-api-key: ${KEY}` },
        customKey: "MY_VAR",
        customValue: "",
      }),
    );
  });

  it("leaves a form with no key in it exactly as it was", () => {
    const state = form({ name: "gpu-box", baseUrl: "https://gateway.example.com", env: { [MODEL_KEY]: "glm-5" } });

    expect(withoutMisplacedKeys(state)).toEqual(state);
  });
});

/**
 * Why the key field refuses to save beyond being empty. Each comes from the state of the
 * reader behind the field, and each is a branch that has been reachable at some point in this
 * field's history and is not reachable through input today - so they are pinned here, one
 * case per branch, where deleting one fails a test.
 */
describe("keyInputRefusal", () => {
  it("has nothing to say about a reader holding nothing", () => {
    expect(keyInputRefusal(EMPTY_SECRET_INPUT, true)).toBeUndefined();
  });

  it("refuses while a paste is open", () => {
    expect(keyInputRefusal({ pending: "", pasting: true }, true)).toBe(UNFINISHED_PASTE);
  });

  it("refuses while a sequence is still arriving", () => {
    expect(keyInputRefusal({ pending: "\u001b]0;", pasting: false }, true)).toBe(UNFINISHED_SEQUENCE);
  });

  it("refuses a field that never had a reader, whatever the reader says", () => {
    expect(keyInputRefusal(EMPTY_SECRET_INPUT, false)).toBe(NO_RAW_KEY_INPUT);
    expect(keyInputRefusal({ pending: "\u001b]", pasting: true }, false)).toBe(NO_RAW_KEY_INPUT);
  });
});

/** What the field says when its reader gives up on what arrived, one case per reason. */
describe("keyReadRefusal", () => {
  it("says input it could not measure cleared the field", () => {
    expect(keyReadRefusal("unreadable")).toBe(UNREADABLE_KEY_INPUT);
  });

  it("says a paste that ended with no start cleared the field", () => {
    expect(keyReadRefusal("lost-paste-start")).toBe(LOST_PASTE_START);
  });
});

/**
 * The panel cuts an error to one line, so a message that does not fit loses its end - which
 * is where "ctrl-u" used to be. Every message the key field can show leads with what to do,
 * and fits the 66 columns the error line has at an 80-column terminal (measured through the
 * real App in src/tui/App.test.tsx).
 */
describe("what the key field says", () => {
  it.each(Object.entries(KEY_FIELD_MESSAGES))("keeps %s to one line at 80 columns", (_name, message) => {
    expect(message.length).toBeLessThanOrEqual(66);
  });
});
