import {
  checkRoute,
  checkRouteName,
  DEFAULT_STRATEGY,
  newRouteSpec,
  type RouteSpec,
  type RouteTool,
  type Strategy,
  toolsOf,
} from "../../core/route-config.js";
import { splitToolPrefix } from "../../core/route-patterns.js";
import type { ToolName } from "../../types.js";

/**
 * The route form's state, pure: what the form holds, how each key changes it, and the spec it
 * saves. No Ink here - RouteForm.tsx draws this and turns keys into actions.
 *
 * Accounts are held by id. A route names them its own way - the bare name on a claude or codex
 * route, the id on an `all` route, where a bare name matches both tools - and only formToSpec
 * writes that form, so changing the tool changes how every ticked account is saved.
 */

export type FormField = "name" | "tool" | "accounts" | "from" | "exclude" | "strategy" | "max" | "reserve" | "fallback";
export const FORM_FIELDS: readonly FormField[] = [
  "name",
  "tool",
  "accounts",
  "from",
  "exclude",
  "strategy",
  "max",
  "reserve",
  "fallback",
];

export type FormAccount = { id: string; tool: ToolName; name: string; email: string };

export type RouteFormState = {
  mode: "new" | "edit";
  /** edit: the name on disk. */
  originalName?: string;
  name: string;
  tool: RouteTool;
  /** `*` in from. */
  every: boolean;
  /** Account ids ticked. Without `every`, the from list; with it, everyone not excluded. */
  ticked: string[];
  /** Extra from patterns (globs, emails), comma-separated. */
  fromText: string;
  /** Exclude patterns that are not plain account names, comma-separated. */
  excludeText: string;
  strategy: Strategy;
  /** Blank leaves the limit unset, so the route takes the default. */
  maxText: string;
  reserveText: string;
  /** Ordered: an account's id, or a pattern kept as written. */
  fallback: string[];
  focus: FormField;
  /** The row within accounts (0 is "every account") or fallback. */
  cursor: number;
  errors: Partial<Record<FormField | "form", string>>;
  dirty: boolean;
};

export type FormAction =
  | { type: "focus"; delta: 1 | -1 }
  | { type: "cursor"; delta: 1 | -1 }
  /** accounts: tick or untick the cursor row, or row 0, "every account". */
  | { type: "toggle" }
  | { type: "text"; field: "name" | "from" | "exclude" | "max" | "reserve"; value: string }
  | { type: "tool"; tool: RouteTool }
  | { type: "strategy"; strategy: Strategy }
  | { type: "fallback-add"; id: string }
  /** At the cursor. */
  | { type: "fallback-remove" }
  /** At the cursor. */
  | { type: "fallback-move"; delta: 1 | -1 };

type ErrorKey = keyof RouteFormState["errors"];

const PICK_ONE = "Pick at least one account.";

const TEXT_KEYS = {
  name: "name",
  from: "fromText",
  exclude: "excludeText",
  max: "maxText",
  reserve: "reserveText",
} as const;

/** The subscription accounts a route of `tool` takes, by id. The caller leaves API profiles out. */
export function accountsFor(tool: RouteTool, all: FormAccount[]): FormAccount[] {
  const tools = toolsOf(tool);
  return all.filter((account) => tools.includes(account.tool)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** How a route of `tool` writes one of its accounts. */
function nameIn(tool: RouteTool, account: FormAccount): string {
  return tool === "all" ? account.id : account.name;
}

function splitList(text: string): string[] {
  return text
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

const joinList = (entries: string[]) => entries.join(", ");

const unique = (entries: string[]) => [...new Set(entries)];

export function initialFormState(
  input: { mode: "new" } | { mode: "edit"; name: string; spec: RouteSpec },
  accounts: FormAccount[],
): RouteFormState {
  // A new route is what `route add` writes: the defaults, written out.
  const spec = input.mode === "edit" ? input.spec : newRouteSpec();
  const listed = accountsFor(spec.tool, accounts);
  const byName = new Map(listed.map((account) => [nameIn(spec.tool, account), account.id]));
  const from = spec.from ?? ["*"];
  const exclude = spec.exclude ?? [];
  const every = from.includes("*");

  let ticked: string[];
  let fromText: string[];
  let excludeText: string[];
  if (every) {
    // An exclude naming an account is that account unticked; under a from list it stays a
    // pattern, since only `every` writes unticked accounts back as excludes.
    const excluded = new Set(exclude.filter((entry) => byName.has(entry)));
    ticked = listed.filter((account) => !excluded.has(nameIn(spec.tool, account))).map((account) => account.id);
    fromText = from.filter((entry) => entry !== "*");
    excludeText = exclude.filter((entry) => !excluded.has(entry));
  } else {
    ticked = unique(from.flatMap((entry) => byName.get(entry) ?? []));
    fromText = from.filter((entry) => !byName.has(entry));
    excludeText = exclude;
  }

  return {
    mode: input.mode,
    ...(input.mode === "edit" ? { originalName: input.name } : {}),
    name: input.mode === "edit" ? input.name : "",
    tool: spec.tool,
    every,
    ticked,
    fromText: joinList(fromText),
    excludeText: joinList(excludeText),
    strategy: spec.strategy ?? DEFAULT_STRATEGY,
    maxText: spec.maxUsage === undefined ? "" : String(spec.maxUsage),
    reserveText: spec.reserveUsage === undefined ? "" : String(spec.reserveUsage),
    fallback: (spec.fallback ?? []).map((entry) => byName.get(entry) ?? entry),
    focus: "name",
    cursor: 0,
    errors: {},
    dirty: false,
  };
}

/** The last cursor row of the focused list. */
function lastRow(state: RouteFormState, accounts: FormAccount[]): number {
  if (state.focus === "accounts") return accountsFor(state.tool, accounts).length;
  if (state.focus === "fallback") return Math.max(0, state.fallback.length - 1);
  return 0;
}

const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), max);

/** A value changed: the form is dirty, and the errors of what changed are out of date. */
function changed(state: RouteFormState, next: Partial<RouteFormState>, cleared: ErrorKey[] | "all"): RouteFormState {
  const errors = cleared === "all" ? {} : { ...state.errors };
  if (cleared !== "all") for (const key of [...cleared, "form" as const]) delete errors[key];
  return { ...state, ...next, errors, dirty: true };
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
}

function toggle(state: RouteFormState, accounts: FormAccount[]): RouteFormState {
  if (state.focus !== "accounts") return state;
  const listed = accountsFor(state.tool, accounts);
  if (state.cursor === 0) {
    if (state.every) return changed(state, { every: false }, ["accounts"]);
    const names = new Set(listed.map((account) => nameIn(state.tool, account)));
    return changed(
      state,
      {
        every: true,
        ticked: listed.map((account) => account.id),
        excludeText: joinList(splitList(state.excludeText).filter((entry) => !names.has(entry))),
      },
      ["accounts", "exclude"],
    );
  }
  const account = listed[state.cursor - 1];
  if (!account) return state;
  if (state.ticked.includes(account.id)) {
    return changed(state, { ticked: state.ticked.filter((id) => id !== account.id) }, ["accounts"]);
  }
  // A from list is saved in the order it was ticked; under `every` the order says nothing.
  const ticked = state.every
    ? listed.filter((each) => each.id === account.id || state.ticked.includes(each.id)).map((each) => each.id)
    : [...state.ticked, account.id];
  return changed(state, { ticked }, ["accounts"]);
}

function changeTool(state: RouteFormState, tool: RouteTool, accounts: FormAccount[]): RouteFormState {
  if (tool === state.tool) return state;
  const before = toolsOf(state.tool);
  const kept = toolsOf(tool);
  const listed = accountsFor(tool, accounts);
  const ticked = state.every
    ? // Everyone not excluded: the accounts of a tool just added have no exclude yet.
      listed
        .filter((account) => !before.includes(account.tool) || state.ticked.includes(account.id))
        .map((account) => account.id)
    : state.ticked.filter((id) => listed.some((account) => account.id === id));
  const fallback = state.fallback.filter((entry) => {
    const { prefix } = splitToolPrefix(entry);
    return prefix === null || kept.includes(prefix as ToolName);
  });
  const next = { ...state, tool, ticked, fallback };
  return changed(state, { tool, ticked, fallback, cursor: clamp(state.cursor, lastRow(next, accounts)) }, "all");
}

function setFallback(state: RouteFormState, fallback: string[], cursor: number): RouteFormState {
  return changed(state, { fallback, cursor }, ["fallback"]);
}

export function reduceForm(state: RouteFormState, action: FormAction, accounts: FormAccount[]): RouteFormState {
  switch (action.type) {
    case "focus": {
      const at = FORM_FIELDS.indexOf(state.focus);
      const focus = FORM_FIELDS[(at + action.delta + FORM_FIELDS.length) % FORM_FIELDS.length] ?? "name";
      return { ...state, focus, cursor: 0 };
    }
    case "cursor": {
      const cursor = clamp(state.cursor + action.delta, lastRow(state, accounts));
      return cursor === state.cursor ? state : { ...state, cursor };
    }
    case "toggle":
      return toggle(state, accounts);
    case "text": {
      const key = TEXT_KEYS[action.field];
      if (state[key] === action.value) return state;
      return changed(state, { [key]: action.value }, [action.field]);
    }
    case "tool":
      return changeTool(state, action.tool, accounts);
    case "strategy":
      return action.strategy === state.strategy ? state : changed(state, { strategy: action.strategy }, ["strategy"]);
    case "fallback-add": {
      const listed = accountsFor(state.tool, accounts).some((account) => account.id === action.id);
      if (!listed || state.fallback.includes(action.id)) return state;
      return setFallback(state, [...state.fallback, action.id], state.cursor);
    }
    case "fallback-remove": {
      if (state.focus !== "fallback" || state.cursor >= state.fallback.length) return state;
      const fallback = state.fallback.filter((_, index) => index !== state.cursor);
      return setFallback(state, fallback, clamp(state.cursor, Math.max(0, fallback.length - 1)));
    }
    case "fallback-move": {
      const to = state.cursor + action.delta;
      if (
        state.focus !== "fallback" ||
        state.cursor >= state.fallback.length ||
        to < 0 ||
        to >= state.fallback.length
      ) {
        return state;
      }
      const fallback = [...state.fallback];
      [fallback[state.cursor], fallback[to]] = [fallback[to] as string, fallback[state.cursor] as string];
      return sameList(fallback, state.fallback) ? state : setFallback(state, fallback, to);
    }
  }
}

/** Where checkRoute says a problem is, read back from the prefix it is given here. */
const AT = "route";
const PROBLEM = /^route(?:\.(\w+))?(?:\[(\d+)\])?: (.*)$/s;

const FIELD_OF: Partial<Record<string, ErrorKey>> = {
  exclude: "exclude",
  maxUsage: "max",
  reserveUsage: "reserve",
  fallback: "fallback",
};

/**
 * The spec the form saves, and its problems by field. The spec is there only when there are
 * none. Problems come from the checks the CLI runs, so a pattern the CLI refuses is refused here
 * the same way, and nothing key-shaped is quoted back.
 */
export function formToSpec(
  state: RouteFormState,
  accounts: FormAccount[],
): { name: string; spec?: RouteSpec; errors: RouteFormState["errors"] } {
  const name = state.name.trim();
  const listed = accountsFor(state.tool, accounts);
  const byId = new Map(listed.map((account) => [account.id, account]));
  const tickedNames = state.ticked.flatMap((id) => {
    const account = byId.get(id);
    return account ? [nameIn(state.tool, account)] : [];
  });
  const untickedNames = listed
    .filter((account) => !state.ticked.includes(account.id))
    .map((account) => nameIn(state.tool, account));
  const fromExtra = splitList(state.fromText);

  const from = unique(state.every ? ["*", ...fromExtra] : [...tickedNames, ...fromExtra]);
  const exclude = unique([...splitList(state.excludeText), ...(state.every ? untickedNames : [])]);
  const fallback = state.fallback.map((entry) => {
    const account = byId.get(entry);
    return account ? nameIn(state.tool, account) : entry;
  });
  // In the order route add writes the keys, which is the order routes.json shows them in.
  const spec: RouteSpec = { tool: state.tool };
  if (from.length > 0) spec.from = from;
  if (exclude.length > 0) spec.exclude = exclude;
  spec.strategy = state.strategy;
  if (state.maxText.trim() !== "") spec.maxUsage = Number(state.maxText.trim());
  if (state.reserveText.trim() !== "") spec.reserveUsage = Number(state.reserveText.trim());
  if (fallback.length > 0) spec.fallback = fallback;

  const errors: RouteFormState["errors"] = {};
  const nameProblem = checkRouteName(name);
  if (nameProblem) errors.name = nameProblem;
  // An empty from list is not saved, and a route without one takes every account.
  if (from.length === 0) errors.accounts = PICK_ONE;

  // The name has its own check above; a stand-in keeps a refused one out of the spec's checks.
  const ticked = new Set(tickedNames);
  for (const problem of checkRoute(nameProblem ? AT : name, spec, AT)) {
    const [, key, index, message = problem] = PROBLEM.exec(problem) ?? [];
    let field: ErrorKey = "form";
    if (key === "from") {
      const entry = index === undefined ? undefined : from[Number(index)];
      field = entry !== undefined && !ticked.has(entry) ? "from" : "accounts";
    } else if (key !== undefined) {
      field = FIELD_OF[key] ?? "form";
    }
    errors[field] ??= message;
  }

  return Object.keys(errors).length === 0 ? { name, spec, errors } : { name, errors };
}
