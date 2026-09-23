import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { type ApiFormState, apiFormFields, emptyApiForm, MODEL_KEY, plaintextSecretNote } from "../api-form.js";
import { renderAt } from "../test-drive.js";
import { flatten, windowsOnScreen } from "../test-frames.js";
import { ApiForm } from "./ApiForm.js";

/** A key shape. The panel may draw a mask in its place, and never any five characters of its body. */
const KEY = "sk-ant-api03-fAkE7wvKpLmN8rTyUbHc5dFgA2sE9oIuWqXv3Bn6Mk1Lp8Rt";

/** What the key field shows instead of a key - the same, whatever is behind it. */
const MASK = "\u2022".repeat(8);

function form(overrides: Partial<ApiFormState> = {}): ApiFormState {
  return { ...emptyApiForm(), ...overrides };
}

function frameFor(state: ApiFormState, keySet = false): string {
  return (
    render(
      <ApiForm form={state} fields={apiFormFields(state)} keySet={keySet} mergeSessions={false} onChange={() => {}} />,
    ).lastFrame() ?? ""
  );
}

/** The index of a field by id, for putting the cursor on it. */
function cursorOn(state: ApiFormState, id: string): number {
  return apiFormFields(state).findIndex((field) => field.id === id);
}

describe("the API key field", () => {
  it("draws a constant, and cannot draw anything else", () => {
    // The panel is handed a boolean, not the key - so the guarantee is the prop's type
    // rather than this component's discipline, and there is nothing here to leak. That the
    // constant is the same width for any key is asserted end to end in src/tui/App.test.tsx,
    // where a real key goes through the real state.
    const state = form();
    const frame = frameFor({ ...state, cursor: cursorOn(state, "key") }, true);

    expect(frame).toContain("API key");
    expect(frame).toContain(MASK);
  });

  it("draws the same constant when the cursor has moved on", () => {
    const state = form();

    expect(frameFor({ ...state, cursor: cursorOn(state, "name") }, true)).toContain(MASK);
  });

  it("draws it with the advanced section open, where the field scrolls out of focus", () => {
    const state = form({ advancedOpen: true });

    expect(frameFor({ ...state, cursor: cursorOn(state, "submit") }, true)).toContain(MASK);
  });

  it("says the field is empty rather than showing a mask over nothing", () => {
    const state = form();

    expect(frameFor({ ...state, cursor: cursorOn(state, "name") })).toContain("not set");
    expect(frameFor({ ...state, cursor: cursorOn(state, "name") })).not.toContain(MASK);
    expect(frameFor({ ...state, cursor: cursorOn(state, "key") })).toContain("type or paste the key");
  });

  it("shows the error under the field, with the field still masked", () => {
    const state = form({ errors: { key: "Enter the API key." } });
    const frame = frameFor({ ...state, cursor: cursorOn(state, "key") }, true);

    expect(frame).toContain("Enter the API key.");
    expect(frame).toContain(MASK);
  });

  it("says where the key goes, so the mask is not the only thing the field explains", () => {
    expect(frameFor(form(), true)).toContain("credential store");
  });
});

describe("the folded form", () => {
  it("shows the six fields and the way in to the rest", () => {
    const frame = frameFor(form());

    for (const label of ["Name", "Endpoint", "Auth", "API key", "Model", "Sessions", "Advanced", "Create profile"]) {
      expect(frame).toContain(label);
    }
  });

  it("says how many settings are folded away, and how to open them", () => {
    const frame = frameFor(form());

    expect(frame).toContain("20 settings");
    expect(frame).toContain("a to open");
  });

  it("keeps every advanced setting off the screen", () => {
    const frame = frameFor(form());

    expect(frame).not.toContain("Context window");
    expect(frame).not.toContain("Request timeout");
  });

  it("counts the settings that are set once some are", () => {
    expect(frameFor(form({ env: { API_TIMEOUT_MS: "600000", [MODEL_KEY]: "glm-4.6" } }))).toContain(
      "1 set · 20 settings",
    );
  });
});

describe("the unfolded form", () => {
  it("shows the settings around the cursor with the hint each one carries", () => {
    const state = form({ advancedOpen: true });
    const frame = frameFor({ ...state, cursor: cursorOn(state, "advanced") });

    expect(frame).toContain("a to fold");
    expect(frame).toContain("Context window");
    // The catalog's hints were written to stand on their own, so the form shows them
    // rather than making the label do the explaining.
    expect(frame).toContain("Real window size");
  });

  it("groups the settings under the group each one belongs to", () => {
    const state = form({ advancedOpen: true });
    const frame = frameFor({ ...state, cursor: cursorOn(state, "advanced") });

    expect(frame).toContain("Model");
    expect(frame).toContain("Context");
  });

  it("shows a window rather than all twenty at once, and says what is off it", () => {
    const state = form({ advancedOpen: true });
    const frame = frameFor({ ...state, cursor: cursorOn(state, "advanced") });

    expect(frame).toMatch(/▼ \d+ more below/);
    expect(frame).not.toContain("HTTPS proxy");
  });

  it("brings a setting into the window when the cursor reaches it", () => {
    const state = form({ advancedOpen: true });
    const frame = frameFor({ ...state, cursor: cursorOn(state, "env:HTTPS_PROXY") });

    expect(frame).toContain("HTTPS proxy");
    expect(frame).toMatch(/▲ \d+ more above/);
  });

  it("shows the free-form row for a variable the catalog has never heard of", () => {
    const state = form({ advancedOpen: true, cursor: 0 });
    const frame = frameFor({ ...state, cursor: cursorOn(state, "customKey") });

    expect(frame).toContain("Setting");
    expect(frame).toContain("VARIABLE_NAME");
  });

  it("warns, without refusing, when a setting will hold a credential in plain text", () => {
    const state = form({ advancedOpen: true, env: { ANTHROPIC_CUSTOM_HEADERS: "X-Api-Key: abc" } });
    const frame = frameFor({ ...state, cursor: cursorOn(state, "env:ANTHROPIC_CUSTOM_HEADERS") });

    expect(frame).toContain("stored in plain text");
  });

  it("says the whole of it at 80 columns, advice included", () => {
    // Cut to one line, the part lost at the panel's edge was the part that says what to do.
    const state = form({ advancedOpen: true, env: { MY_SERVICE_TOKEN: "abc" } });
    const note = plaintextSecretNote("MY_SERVICE_TOKEN", "abc") ?? "";
    const instance = renderAt(
      <ApiForm
        form={{ ...state, cursor: cursorOn(state, "env:MY_SERVICE_TOKEN") }}
        fields={apiFormFields(state)}
        keySet={false}
        mergeSessions={false}
        onChange={() => {}}
      />,
      80,
    );
    const frame = instance.lastFrame() ?? "";
    instance.unmount();

    expect(note).not.toBe("");
    expect(flatten(frame)).toContain(flatten(note));
  });
});

/**
 * #15: the note `config --base-url` prints for a plain-http endpoint off this machine, under
 * the Endpoint field while it is typed - the form is a route to the same profile.
 */
describe("the endpoint row", () => {
  const CLEARTEXT = "is plain http, so the key crosses the network unencrypted.";

  it("says a plain-http endpoint off this machine sends the key unencrypted", () => {
    const frame = frameFor(form({ baseUrl: "http://gpu-box:8000" }));

    expect(flatten(frame)).toContain(flatten(`gpu-box:8000 ${CLEARTEXT}`));
  });

  it.each([
    ["https", "https://openrouter.ai/api"],
    ["plain http on this machine", "http://localhost:8000"],
    ["a URL still being typed", "http://"],
  ])("says nothing of it for %s", (_case, baseUrl) => {
    expect(flatten(frameFor(form({ baseUrl })))).not.toContain(flatten(CLEARTEXT));
  });
});

describe("the auth row", () => {
  it("says what each scheme means, since the choice is two words otherwise", () => {
    const bearer = form();
    expect(frameFor({ ...bearer, cursor: cursorOn(bearer, "auth") })).toContain("Bearer");

    const apiKey = form({ authScheme: "api-key" });
    expect(frameFor({ ...apiKey, cursor: cursorOn(apiKey, "auth") })).toContain("x-api-key");
  });
});

/**
 * Ruling 88's second layer, drawn: a field that shows what it holds shows the key field's mask
 * instead of a key - the same constant, so neither the key nor its length is on screen.
 */
describe("a key in a field that draws what it holds", () => {
  /** The line carrying `label`, to check a row rather than the whole frame. */
  const row = (frame: string, label: string) => frame.split("\n").find((line) => line.includes(label)) ?? "";

  it.each([
    ["Name", form({ name: KEY }), "name"],
    ["Endpoint", form({ baseUrl: `https://gateway.example.com${KEY}` }), "baseUrl"],
    ["Model", form({ env: { [MODEL_KEY]: KEY } }), "model"],
  ])("draws the mask in the %s row, focused or not", (label, state, id) => {
    for (const cursor of [cursorOn(state, id), cursorOn(state, "submit")]) {
      const frame = frameFor({ ...state, cursor });

      expect(row(frame, label)).toContain(MASK);
      expect(windowsOnScreen([frame], KEY)).toEqual([]);
    }
  });

  it("draws the same thing for a short key and a long one", () => {
    const short = form({ env: { [MODEL_KEY]: KEY } });
    const long = form({ env: { [MODEL_KEY]: KEY.repeat(6) } });

    expect(frameFor({ ...long, cursor: cursorOn(long, "model") })).toBe(
      frameFor({ ...short, cursor: cursorOn(short, "model") }),
    );
  });

  it.each([
    [
      "Custom headers",
      "env:ANTHROPIC_CUSTOM_HEADERS",
      { ANTHROPIC_CUSTOM_HEADERS: "abc" },
      { ANTHROPIC_CUSTOM_HEADERS: "X-Team: infrastructure-and-more" },
    ],
    ["Model", "model", { [MODEL_KEY]: KEY.slice(0, 40) }, { [MODEL_KEY]: KEY.repeat(3) }],
  ])("draws the same mask in the %s row for a value shorter than the mask and a longer one", (_row, id, short, long) => {
    // The mask was a glyph per character cut to eight, so a value under eight drew fewer: `abc`
    // in Custom headers drew three, and the length the key field never shows was on screen.
    const shortForm = form({ advancedOpen: true, env: short });
    const longForm = form({ advancedOpen: true, env: long });

    for (const at of [id, "submit"]) {
      expect(frameFor({ ...shortForm, cursor: cursorOn(shortForm, at) })).toBe(
        frameFor({ ...longForm, cursor: cursorOn(longForm, at) }),
      );
    }
  });

  it("finds no part of a key on a form that shows none, even where the form says x-api-key", () => {
    // `-api` is in the key's public prefix and in the auth row's own text: a window of the
    // whole key found it here once. The helper searches the key's random body only.
    const state = form({ authScheme: "api-key" });

    expect(windowsOnScreen([frameFor({ ...state, cursor: cursorOn(state, "auth") }, true)], KEY)).toEqual([]);
  });

  it("draws a model id as it is", () => {
    const state = form({ env: { [MODEL_KEY]: "z-ai/glm-5.3" } });

    expect(row(frameFor(state), "Model")).toContain("z-ai/glm-5.3");
  });

  it("masks ANTHROPIC_CUSTOM_HEADERS whatever it holds, and still says it is stored in plain text", () => {
    // The decision: a key belongs there, so it is not refused - and every output path hides
    // the value whole, so the form does too.
    const state = form({ advancedOpen: true, env: { ANTHROPIC_CUSTOM_HEADERS: `Authorization: Bearer ${KEY}` } });
    const frame = frameFor({ ...state, cursor: cursorOn(state, "env:ANTHROPIC_CUSTOM_HEADERS") });

    expect(row(frame, "Custom headers")).toContain(MASK);
    expect(row(frame, "Custom headers")).not.toContain("Authorization");
    expect(windowsOnScreen([frame], KEY)).toEqual([]);
    expect(frame).toContain("stored in plain text");
  });
});
