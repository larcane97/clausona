import { describe, expect, it } from "vitest";

import { newRouteSpec, type RouteSpec, type Strategy, withDefaults } from "../../core/route-config.js";
import { expandPatterns } from "../../core/route-patterns.js";
import type { ToolName } from "../../types.js";
import {
  accountsFor,
  FORM_FIELDS,
  type FormAccount,
  type FormAction,
  formToSpec,
  initialFormState,
  type RouteFormState,
  reduceForm,
} from "./route-form-state.js";

/** Listed out of id order, so the sorting in accountsFor is what puts them in order. */
const ACCOUNTS: FormAccount[] = [
  { id: "claude:team", tool: "claude", name: "team", email: "team@work.example.com" },
  { id: "claude:work", tool: "claude", name: "work", email: "me@work.example.com" },
  { id: "codex:x", tool: "codex", name: "x", email: "x@example.com" },
  { id: "claude:side", tool: "claude", name: "side", email: "me@side.example.com" },
  { id: "claude:ops-share", tool: "claude", name: "ops-share", email: "ops@work.example.com" },
];

const CLAUDE_IDS = ["claude:ops-share", "claude:side", "claude:team", "claude:work"];

/** Built from pieces, so the file carries nothing a secret scanner takes for a key. */
const keyShaped = () => ["sk", "ant", "api03", "x".repeat(24)].join("-");

const newForm = () => initialFormState({ mode: "new" }, ACCOUNTS);
const editForm = (spec: RouteSpec, name = "main") => initialFormState({ mode: "edit", name, spec }, ACCOUNTS);

function run(state: RouteFormState, ...actions: FormAction[]): RouteFormState {
  return actions.reduce((next, action) => reduceForm(next, action, ACCOUNTS), state);
}

/** Focus the accounts list and put the cursor on `row` (0 is "every account"). */
function onAccountsRow(state: RouteFormState, row: number): RouteFormState {
  const focused = { ...state, focus: "accounts" as const, cursor: 0 };
  return run(focused, ...Array.from({ length: row }, () => ({ type: "cursor", delta: 1 }) as const));
}

/** The accounts row of an id in the list the form shows for its tool. */
function rowOf(state: RouteFormState, id: string): number {
  return accountsFor(state.tool, ACCOUNTS).findIndex((account) => account.id === id) + 1;
}

function toggleAccount(state: RouteFormState, id: string): RouteFormState {
  return run(onAccountsRow(state, rowOf(state, id)), { type: "toggle" });
}

/** The accounts a from list takes, as routing expands it: what makes two lists the same route. */
function picks(patterns: string[] | undefined, tool: ToolName): string[] {
  const members = ACCOUNTS.filter((account) => account.tool === tool).map((account) => ({
    ...account,
    kind: "subscription" as const,
    sharesSessions: true,
    configDir: `/h/.${account.tool}-${account.name}`,
  }));
  return expandPatterns(patterns ?? [], members).members.map(({ member }) => member.id);
}

const named = (state: RouteFormState, name = "main") => run(state, { type: "text", field: "name", value: name });

describe("accountsFor", () => {
  it("lists one tool's accounts by id", () => {
    expect(accountsFor("claude", ACCOUNTS).map((account) => account.id)).toEqual(CLAUDE_IDS);
    expect(accountsFor("codex", ACCOUNTS).map((account) => account.id)).toEqual(["codex:x"]);
  });

  it("lists both tools' accounts for an all route", () => {
    expect(accountsFor("all", ACCOUNTS).map((account) => account.id)).toEqual([...CLAUDE_IDS, "codex:x"]);
  });
});

describe("a new form", () => {
  it("starts on every claude account, round-robin, 80% and 95%, with the name focused", () => {
    expect(newForm()).toEqual({
      mode: "new",
      name: "",
      tool: "claude",
      every: true,
      ticked: CLAUDE_IDS,
      fromText: "",
      excludeText: "",
      strategy: "round-robin",
      maxText: "80",
      reserveText: "95",
      fallback: [],
      focus: "name",
      cursor: 0,
      errors: {},
      dirty: false,
    });
  });

  it("saves what route add writes", () => {
    expect(formToSpec(named(newForm()), ACCOUNTS)).toEqual({ name: "main", spec: newRouteSpec(), errors: {} });
  });
});

describe("an edit form", () => {
  it("keeps the name on disk and starts clean", () => {
    const state = editForm(newRouteSpec(), "solo");
    expect(state).toMatchObject({ mode: "edit", originalName: "solo", name: "solo", dirty: false, focus: "name" });
  });

  it("reads * in from as every account, unticking the accounts its exclude names", () => {
    const state = editForm({ tool: "claude", from: ["*"], exclude: ["side", "*-share", "claude:work"] });
    expect(state.every).toBe(true);
    // `claude:work` is not the bare name a claude route writes, so it stays a pattern.
    expect(state.ticked).toEqual(["claude:ops-share", "claude:team", "claude:work"]);
    expect(state.excludeText).toBe("*-share, claude:work");
  });

  it("names accounts by id on an all route", () => {
    const state = editForm({ tool: "all", from: ["*"], exclude: ["claude:side", "work"] });
    expect(state.ticked).toEqual(["claude:ops-share", "claude:team", "claude:work", "codex:x"]);
    // A bare name on an all route matches both tools: a pattern, not one account.
    expect(state.excludeText).toBe("work");
  });

  it("ticks the accounts from names, in from's order, and keeps globs and emails as text", () => {
    const state = editForm({ tool: "claude", from: ["team", "*@work.example.com", "side", "gone"] });
    expect(state.every).toBe(false);
    expect(state.ticked).toEqual(["claude:team", "claude:side"]);
    expect(state.fromText).toBe("*@work.example.com, gone");
  });

  it("ticks the accounts from names with the route's own tool prefix, and saves the same accounts", () => {
    const spec: RouteSpec = { tool: "claude", from: ["claude:work", "claude:side"] };
    const state = editForm(spec);
    expect(state.ticked).toEqual(["claude:work", "claude:side"]);
    expect(state.fromText).toBe("");
    const saved = formToSpec(state, ACCOUNTS).spec;
    expect(saved).toEqual({ tool: "claude", from: ["work", "side"], strategy: "round-robin" });
    expect(picks(saved?.from, "claude")).toEqual(picks(spec.from, "claude"));
  });

  it("ticks a codex: name on a codex route the same way", () => {
    const spec: RouteSpec = { tool: "codex", from: ["codex:x"] };
    const state = editForm(spec);
    expect(state.ticked).toEqual(["codex:x"]);
    expect(state.fromText).toBe("");
    const saved = formToSpec(state, ACCOUNTS).spec;
    expect(saved).toEqual({ tool: "codex", from: ["x"], strategy: "round-robin" });
    expect(picks(saved?.from, "codex")).toEqual(picks(spec.from, "codex"));
  });

  it("keeps a name with the other tool's prefix as a pattern, which saving refuses", () => {
    const state = editForm({ tool: "claude", from: ["team", "codex:x"] });
    expect(state.ticked).toEqual(["claude:team"]);
    expect(state.fromText).toBe("codex:x");
    expect(formToSpec(state, ACCOUNTS).errors).toEqual({ from: expect.stringMatching(/names a codex profile/) });
  });

  it("keeps an exclude naming an account as text when from is a list, so saving does not drop it", () => {
    const spec: RouteSpec = { tool: "claude", from: ["*@work.example.com"], exclude: ["ops-share"] };
    const state = editForm(spec);
    expect(state.ticked).toEqual([]);
    expect(state.excludeText).toBe("ops-share");
    expect(formToSpec(state, ACCOUNTS).spec).toEqual({ ...spec, strategy: "round-robin" });
  });

  it("holds fallback accounts by id and other patterns as they are", () => {
    expect(editForm({ tool: "claude", fallback: ["side", "personal"] }).fallback).toEqual(["claude:side", "personal"]);
  });

  it("leaves limits the spec does not set blank, and saves them unset", () => {
    const state = editForm({ tool: "codex", from: ["x"], strategy: "expiring" });
    expect([state.maxText, state.reserveText]).toEqual(["", ""]);
    expect(formToSpec(state, ACCOUNTS).spec).toEqual({ tool: "codex", from: ["x"], strategy: "expiring" });
  });
});

describe("the every account row", () => {
  it("turned off, keeps the current ticks as the from list", () => {
    const off = run(onAccountsRow(toggleAccount(named(newForm()), "claude:side"), 0), { type: "toggle" });
    expect(off.every).toBe(false);
    expect(off.ticked).toEqual(["claude:ops-share", "claude:team", "claude:work"]);
    expect(formToSpec(off, ACCOUNTS).spec).toMatchObject({ from: ["ops-share", "team", "work"] });
    expect(formToSpec(off, ACCOUNTS).spec?.exclude).toBeUndefined();
  });

  it("turned on, ticks everyone and clears the excludes that name accounts", () => {
    const state = editForm({ tool: "claude", from: ["team"], exclude: ["side", "*-share"] });
    const on = run(onAccountsRow(state, 0), { type: "toggle" });
    expect(on.every).toBe(true);
    expect(on.ticked).toEqual(CLAUDE_IDS);
    expect(on.excludeText).toBe("*-share");
    expect(formToSpec(on, ACCOUNTS).spec).toMatchObject({ from: ["*"], exclude: ["*-share"] });
  });
});

describe("ticking accounts", () => {
  it("under every, unticking excludes the account and ticking it back removes the exclude", () => {
    const unticked = toggleAccount(named(newForm()), "claude:side");
    expect(formToSpec(unticked, ACCOUNTS).spec).toMatchObject({ from: ["*"], exclude: ["side"] });

    const back = run(unticked, { type: "toggle" });
    expect(back.ticked).toEqual(CLAUDE_IDS);
    expect(formToSpec(back, ACCOUNTS).spec?.exclude).toBeUndefined();
  });

  it("excludes by id on an all route", () => {
    const state = toggleAccount(named(run(newForm(), { type: "tool", tool: "all" })), "codex:x");
    expect(formToSpec(state, ACCOUNTS).spec).toMatchObject({ tool: "all", from: ["*"], exclude: ["codex:x"] });
  });

  it("without every, adds to and takes from the from list", () => {
    const state = toggleAccount(editForm({ tool: "claude", from: ["team"] }), "claude:work");
    expect(formToSpec(state, ACCOUNTS).spec?.from).toEqual(["team", "work"]);
    const untick = toggleAccount(state, "claude:team");
    expect(formToSpec(untick, ACCOUNTS).spec?.from).toEqual(["work"]);
  });

  it("does nothing when the accounts list is not focused", () => {
    const state = newForm();
    expect(run(state, { type: "toggle" })).toBe(state);
  });
});

describe("changing the tool", () => {
  it("lists the new tool's accounts, ticking the ones that join under every", () => {
    const state = run(toggleAccount(named(newForm()), "claude:side"), { type: "tool", tool: "all" });
    expect(state.ticked).toEqual(["claude:ops-share", "claude:team", "claude:work", "codex:x"]);
    expect(formToSpec(state, ACCOUNTS).spec).toMatchObject({ tool: "all", from: ["*"], exclude: ["claude:side"] });
  });

  it("drops the ticks and fallback entries of a tool no longer included", () => {
    const state = editForm({
      tool: "all",
      from: ["claude:team", "codex:x"],
      fallback: ["codex:x", "claude:side", "codex:gone", "personal"],
    });
    const claude = run(state, { type: "tool", tool: "claude" });
    expect(claude.ticked).toEqual(["claude:team"]);
    expect(claude.fallback).toEqual(["claude:side", "personal"]);
    expect(formToSpec(claude, ACCOUNTS).spec).toEqual({
      tool: "claude",
      from: ["team"],
      strategy: "round-robin",
      fallback: ["side", "personal"],
    });
  });

  it("keeps the accounts cursor on a row that exists", () => {
    const state = onAccountsRow(run(newForm(), { type: "tool", tool: "all" }), 5);
    expect(run(state, { type: "tool", tool: "codex" }).cursor).toBe(1);
  });
});

describe("focus and cursor", () => {
  it("tab walks every field in order and wraps both ways, putting the cursor back on the first row", () => {
    let state = { ...newForm(), cursor: 2 };
    const seen: string[] = [];
    for (let step = 0; step < FORM_FIELDS.length; step++) {
      seen.push(state.focus);
      state = run(state, { type: "focus", delta: 1 });
      expect(state.cursor).toBe(0);
    }
    expect(seen).toEqual([...FORM_FIELDS]);
    expect(state.focus).toBe("name");
    expect(run(state, { type: "focus", delta: -1 }).focus).toBe("fallback");
  });

  it("moves within the accounts rows, every account row included", () => {
    const top = onAccountsRow(newForm(), 0);
    expect(run(top, { type: "cursor", delta: -1 }).cursor).toBe(0);
    const bottom = onAccountsRow(newForm(), 9);
    expect(bottom.cursor).toBe(CLAUDE_IDS.length);
  });

  it("moves within the fallback entries", () => {
    const state = { ...editForm({ tool: "claude", fallback: ["side", "team"] }), focus: "fallback" as const };
    const steps = run(state, { type: "cursor", delta: 1 }, { type: "cursor", delta: 1 });
    expect(steps.cursor).toBe(1);
    expect(run(steps, { type: "cursor", delta: -1 }, { type: "cursor", delta: -1 }).cursor).toBe(0);
  });

  it("does not move on a field that has no rows", () => {
    expect(run(newForm(), { type: "cursor", delta: 1 }).cursor).toBe(0);
  });
});

describe("fallback", () => {
  const onFallback = (state: RouteFormState) => ({ ...state, focus: "fallback" as const, cursor: 0 });

  it("adds a listed account once, at the end", () => {
    const state = run(
      newForm(),
      { type: "fallback-add", id: "claude:side" },
      { type: "fallback-add", id: "claude:team" },
      { type: "fallback-add", id: "claude:side" },
    );
    expect(state.fallback).toEqual(["claude:side", "claude:team"]);
  });

  it("ignores an id the route does not list", () => {
    const state = newForm();
    expect(run(state, { type: "fallback-add", id: "codex:x" })).toBe(state);
  });

  it("removes and moves the entry at the cursor, the cursor following it", () => {
    const state = onFallback(editForm({ tool: "claude", fallback: ["side", "team", "work"] }));
    const moved = run(state, { type: "fallback-move", delta: 1 });
    expect(moved.fallback).toEqual(["claude:team", "claude:side", "claude:work"]);
    expect(moved.cursor).toBe(1);
    expect(run(state, { type: "fallback-move", delta: -1 })).toBe(state);

    const last = run(state, { type: "cursor", delta: 1 }, { type: "cursor", delta: 1 });
    const removed = run(last, { type: "fallback-remove" });
    expect(removed.fallback).toEqual(["claude:side", "claude:team"]);
    expect(removed.cursor).toBe(1);
  });

  it("saves fallback accounts as the route names them", () => {
    const claude = run(named(newForm()), { type: "fallback-add", id: "claude:side" });
    expect(formToSpec(claude, ACCOUNTS).spec?.fallback).toEqual(["side"]);
    const all = run(named(newForm()), { type: "tool", tool: "all" }, { type: "fallback-add", id: "codex:x" });
    expect(formToSpec(all, ACCOUNTS).spec?.fallback).toEqual(["codex:x"]);
  });

  it("saves an entry once when the fallback names it twice", () => {
    const state = editForm({ tool: "claude", fallback: ["side", "claude:side", "personal", "personal"] });
    expect(formToSpec(state, ACCOUNTS).spec?.fallback).toEqual(["side", "personal"]);
  });
});

describe("dirty", () => {
  it("stays false for moving around and for setting a value to what it already is", () => {
    const state = run(
      newForm(),
      { type: "focus", delta: 1 },
      { type: "focus", delta: 1 },
      { type: "cursor", delta: 1 },
      { type: "text", field: "max", value: "80" },
      { type: "tool", tool: "claude" },
      { type: "strategy", strategy: "round-robin" },
      { type: "fallback-remove" },
    );
    expect(state.dirty).toBe(false);
  });

  it.each<[string, (state: RouteFormState) => RouteFormState]>([
    ["text", (state) => run(state, { type: "text", field: "exclude", value: "*-share" })],
    ["tool", (state) => run(state, { type: "tool", tool: "codex" })],
    ["strategy", (state) => run(state, { type: "strategy", strategy: "headroom" })],
    ["toggle", (state) => toggleAccount(state, "claude:team")],
    ["fallback-add", (state) => run(state, { type: "fallback-add", id: "claude:team" })],
    [
      "fallback-remove",
      (state) => run({ ...state, fallback: ["claude:team"], focus: "fallback" }, { type: "fallback-remove" }),
    ],
    [
      "fallback-move",
      (state) =>
        run(
          { ...state, fallback: ["claude:team", "claude:side"], focus: "fallback" },
          { type: "fallback-move", delta: 1 },
        ),
    ],
  ])("turns true on a %s that changes a value", (_label, act) => {
    expect(act(newForm()).dirty).toBe(true);
  });
});

describe("formToSpec", () => {
  it("splits the pattern text on commas, trimmed, and leaves out empty lists", () => {
    const state = run(
      named(editForm({ tool: "claude", from: ["team"] })),
      { type: "text", field: "from", value: " *@work.example.com ,, side ," },
      { type: "text", field: "exclude", value: " , " },
    );
    expect(formToSpec(state, ACCOUNTS).spec).toEqual({
      tool: "claude",
      from: ["team", "*@work.example.com", "side"],
      strategy: "round-robin",
    });
  });

  it("writes each pattern once", () => {
    const state = run(toggleAccount(named(newForm()), "claude:side"), {
      type: "text",
      field: "exclude",
      value: "side, *-share, *-share",
    });
    expect(formToSpec(state, ACCOUNTS).spec?.exclude).toEqual(["side", "*-share"]);
  });

  it("keeps the from patterns after * under every", () => {
    const state = run(named(newForm()), { type: "text", field: "from", value: "*@side.example.com" });
    expect(formToSpec(state, ACCOUNTS).spec?.from).toEqual(["*", "*@side.example.com"]);
  });

  it("reads the limits as numbers", () => {
    const state = run(
      named(newForm()),
      { type: "text", field: "max", value: " 70 " },
      { type: "text", field: "reserve", value: "90" },
    );
    expect(formToSpec(state, ACCOUNTS).spec).toMatchObject({ maxUsage: 70, reserveUsage: 90 });
  });

  it("asks for an account when from would be empty", () => {
    const state = run(onAccountsRow(named(newForm()), 0), { type: "toggle" });
    const none = CLAUDE_IDS.reduce(toggleAccount, state);
    expect(none.ticked).toEqual([]);
    expect(formToSpec(none, ACCOUNTS)).toEqual({ name: "main", errors: { accounts: "Pick at least one account." } });

    const pattern = run(none, { type: "text", field: "from", value: "*@work.example.com" });
    expect(formToSpec(pattern, ACCOUNTS).errors).toEqual({});
  });

  it("puts a name problem on the name, trimming the name first", () => {
    expect(formToSpec(named(newForm(), "  main  "), ACCOUNTS).name).toBe("main");
    const bad = formToSpec(named(newForm(), "-main"), ACCOUNTS);
    expect(bad.spec).toBeUndefined();
    expect(bad.errors.name).toMatch(/^Invalid route name/);
    expect(Object.keys(bad.errors)).toEqual(["name"]);
  });

  // An empty name is the form's first mistake (the CLI never has one), and "Invalid route name ''"
  // read like a glitch.
  it("asks for a name when there is none, rather than calling an empty one invalid", () => {
    for (const name of ["", "   "]) {
      const result = formToSpec(named(newForm(), name), ACCOUNTS);
      expect(result.spec).toBeUndefined();
      expect(result.errors).toEqual({ name: "Give the route a name." });
    }
  });

  it("refuses a key-shaped name without quoting it anywhere", () => {
    const key = keyShaped();
    const state = run(named(newForm(), key), { type: "text", field: "max", value: "nope" });
    const result = formToSpec(state, ACCOUNTS);
    expect(result.spec).toBeUndefined();
    expect(result.errors.name).toBe("That looks like an API key, not a route name.");
    expect(result.errors.max).toBe("must be a number from 1 to 100");
    expect(JSON.stringify(result.errors)).not.toContain(key);
  });

  it("refuses a key-shaped pattern without quoting it", () => {
    const key = keyShaped();
    const state = run(named(newForm()), { type: "text", field: "from", value: `*@work.example.com, ${key}` });
    const { errors } = formToSpec(state, ACCOUNTS);
    expect(errors.from).toMatch(/looks like an API key/);
    expect(JSON.stringify(errors)).not.toContain(key);
  });

  it.each<[string, (state: RouteFormState) => RouteFormState, keyof RouteFormState["errors"], RegExp]>([
    ["a from pattern", (s) => run(s, { type: "text", field: "from", value: "codex:*" }), "from", /names a codex/],
    ["an exclude pattern", (s) => run(s, { type: "text", field: "exclude", value: "a b" }), "exclude", /not a profile/],
    ["the cut", (s) => run(s, { type: "text", field: "max", value: "0" }), "max", /from 1 to 100/],
    ["the reserve", (s) => run(s, { type: "text", field: "reserve", value: "60" }), "reserve", /from maxUsage \(80\)/],
    ["a fallback", (s) => ({ ...s, fallback: ["codex:x"] }), "fallback", /names a codex/],
    ["anything else", (s) => ({ ...s, strategy: "fastest" as Strategy }), "form", /must be one of/],
  ])("puts a problem with %s on its field, without the location", (_label, act, field, message) => {
    const { spec, errors } = formToSpec(act(named(newForm())), ACCOUNTS);
    expect(spec).toBeUndefined();
    expect(Object.keys(errors)).toEqual([field]);
    expect(errors[field]).toMatch(message);
    expect(errors[field]).not.toMatch(/routes?\./);
  });

  it("puts a problem with a ticked name on the accounts list", () => {
    // The registry never holds a name like this; a pattern check still covers the ticked list.
    const odd: FormAccount = { id: "claude:a b", tool: "claude", name: "a b", email: "" };
    const ticked = { ...editForm({ tool: "claude", from: ["team"] }), ticked: ["claude:a b"] };
    expect(formToSpec(ticked, [...ACCOUNTS, odd]).errors).toEqual({ accounts: expect.stringMatching(/not a profile/) });
  });
});

describe("errors", () => {
  it("clears a field's error when that field changes", () => {
    const state = {
      ...newForm(),
      errors: { name: "Invalid route name", max: "must be a number from 1 to 100", form: "x" },
    };
    expect(run(state, { type: "text", field: "max", value: "70" }).errors).toEqual({ name: "Invalid route name" });
  });

  const failed: RouteFormState["errors"] = {
    name: "n",
    accounts: "Pick at least one account.",
    from: "f",
    exclude: "e",
    max: "m",
    reserve: "r",
    fallback: "b",
    form: "x",
  };
  const without = (...keys: (keyof RouteFormState["errors"])[]) =>
    Object.fromEntries(Object.entries(failed).filter(([key]) => !keys.includes(key as keyof typeof failed)));

  it.each<[string, (state: RouteFormState) => RouteFormState, RouteFormState["errors"]]>([
    [
      "typing a from pattern clears the from and accounts errors",
      (state) => run(state, { type: "text", field: "from", value: "*@work.example.com" }),
      without("from", "accounts", "form"),
    ],
    [
      "ticking an account clears the accounts error",
      (state) => toggleAccount(state, "claude:side"),
      without("accounts", "form"),
    ],
    [
      "turning every account off clears the accounts error",
      (state) => run(onAccountsRow(state, 0), { type: "toggle" }),
      without("accounts", "form"),
    ],
    [
      "turning every account on clears the accounts and exclude errors",
      (state) => run(onAccountsRow({ ...state, every: false }, 0), { type: "toggle" }),
      without("accounts", "exclude", "form"),
    ],
    ["changing the tool clears every error", (state) => run(state, { type: "tool", tool: "all" }), {}],
  ])("%s", (_label, act, left) => {
    expect(act({ ...newForm(), errors: failed }).errors).toEqual(left);
  });
});

describe("a round trip through the form", () => {
  it.each<RouteSpec>([
    {
      tool: "claude",
      from: ["*"],
      exclude: ["*-share"],
      strategy: "headroom",
      maxUsage: 80,
      reserveUsage: 95,
      fallback: ["side"],
    },
    { tool: "claude", from: ["*"], exclude: ["*-share", "side"], strategy: "round-robin", maxUsage: 70 },
    { tool: "claude", from: ["team", "work", "*@side.example.com"], strategy: "expiring", fallback: ["personal"] },
    {
      tool: "all",
      from: ["*"],
      exclude: ["claude:side", "codex:x"],
      strategy: "round-robin",
      fallback: ["claude:team"],
    },
    { tool: "codex", from: ["x"], strategy: "headroom", maxUsage: 60, reserveUsage: 100 },
  ])("saves the spec it was opened with: %j", (spec) => {
    expect(formToSpec(editForm(spec), ACCOUNTS)).toEqual({ name: "main", spec, errors: {} });
  });

  it("writes out the * a spec with no from means", () => {
    const spec: RouteSpec = { tool: "claude", exclude: ["side"], strategy: "headroom" };
    const { spec: saved, errors } = formToSpec(editForm(spec), ACCOUNTS);
    expect(errors).toEqual({});
    expect(saved).toEqual({ ...spec, from: ["*"] });
    expect(withDefaults(saved ?? spec)).toEqual(withDefaults(spec));
  });
});
