import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import { type ApiFormState, apiFormFields, emptyApiForm, MODEL_KEY } from "../api-form.js";
import { ApiForm } from "./ApiForm.js";

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
});

describe("the auth row", () => {
  it("says what each scheme means, since the choice is two words otherwise", () => {
    const bearer = form();
    expect(frameFor({ ...bearer, cursor: cursorOn(bearer, "auth") })).toContain("Bearer");

    const apiKey = form({ authScheme: "api-key" });
    expect(frameFor({ ...apiKey, cursor: cursorOn(apiKey, "auth") })).toContain("x-api-key");
  });
});
