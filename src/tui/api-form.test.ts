import { describe, expect, it } from "vitest";

import {
  ADVANCED_ENTRIES,
  type ApiFormState,
  apiFormEnv,
  apiFormFields,
  baseUrlError,
  customEntryError,
  defaultAuthScheme,
  emptyApiForm,
  envError,
  liveApiFieldError,
  MODEL_KEY,
  nameError,
  plaintextSecretNote,
  scrubSecret,
  validateApiForm,
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
    expect(defaultAuthScheme(url)).toBe(expected);
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

  it("refuses a key mis-pasted into a number field without echoing it back", () => {
    // The shared validator quotes the value it refused, which is right on a command line
    // and wrong here: this is the field next to the masked one, and a mis-pasted key would
    // otherwise be printed in full under it.
    const message = envError("CLAUDE_CODE_MAX_CONTEXT_TOKENS", KEY, []);

    expect(message).toBe("CLAUDE_CODE_MAX_CONTEXT_TOKENS expects a whole number.");
    expect(message).not.toContain(KEY);
  });

  it("refuses a key mis-pasted into a bool field without echoing it back", () => {
    const message = envError("DISABLE_PROMPT_CACHING", KEY, []);

    expect(message).toBe("DISABLE_PROMPT_CACHING expects 0 or 1.");
    expect(message).not.toContain(KEY);
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
