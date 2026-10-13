import { Box, type Key, Text, useInput, useStdout } from "ink";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { QuotaTarget } from "../../core/quota-store.js";
import { type Budget, type Budgets, budgetWarnings, clearBudget, readBudgets } from "../../core/route-budgets.js";
import {
  type BrokenRoute,
  DEFAULT_MAX_USAGE,
  type RouteSpec,
  type RoutesFile,
  withDefaults,
} from "../../core/route-config.js";
import { compareIds, expandPatterns } from "../../core/route-patterns.js";
import {
  clearDefaultRoute,
  clearDirRoute,
  readRules,
  removeReferences,
  routeProblem,
  rulesNaming,
  ruleWarnings,
  SLOT_TOOLS,
  type Slots,
} from "../../core/route-rules.js";
import { RoutesFileError } from "../../core/routes-store.js";
import { type Ranking, rankRoute } from "../../core/routing.js";
import { type BudgetRow, budgetNote, budgetRowOf, freeNow, nothingRead } from "../../lib/route-render.js";
import { apiMembers, limitProblem, membersOf, namesOf, quotaTargets, spendTarget } from "../../lib/route-service.js";
import type { QuotaSnapshot, Registry, ToolName } from "../../types.js";
import { Chrome } from "../components/Chrome.js";
import { QuotaCell } from "../components/QuotaCell.js";
import { color, symbol } from "../theme.js";
import { useWidth } from "../use-width.js";
import { BudgetForm } from "./BudgetForm.js";
import { type Entry, GAP, MARK, RouteDetail, Setting } from "./RouteDetail.js";
import { formAccounts, RouteForm } from "./RouteForm.js";
import { RuleForm, type RuleTarget } from "./RuleForm.js";
import { defaultRoutesScreenDeps, errorText, type RoutesListDeps } from "./routes-deps.js";

/**
 * The dashboard's Routes screen: every route, and the one selected with its members ranked as
 * `csn route explain` ranks them. It reads routes.json, the registry, quota and the pick record,
 * and writes only when a route is removed or saved from its form (RouteForm.tsx), a dir rule or
 * default changed (RuleForm.tsx), or a budget set (BudgetForm.tsx) or cleared; a pick is never
 * recorded here.
 */

/** From this many terminal columns the detail sits beside the list; below, under it. */
const WIDE_AT = 100;
const LIST_WIDTH = 30;

const HINTS = [
  { keys: "↑↓", action: "move" },
  { keys: "n", action: "new" },
  { keys: "e", action: "edit" },
  { keys: "d", action: "delete" },
  { keys: "r", action: "refresh" },
  { keys: "tab", action: "dir rules" },
  { keys: "b", action: "budgets" },
  { keys: "esc", action: "back" },
];
const CONFIRM_HINTS = [
  { keys: "y", action: "remove" },
  { keys: "n/esc", action: "cancel" },
];
/** With no routes there is nothing to move to, edit, delete or refresh. */
const EMPTY_HINTS = [
  { keys: "n", action: "new" },
  { keys: "tab", action: "dir rules" },
  { keys: "b", action: "budgets" },
  { keys: "esc", action: "back" },
];
const BACK_HINTS = [{ keys: "esc", action: "back" }];
/** The dir rules view: the defaults' row is always there, so every key has something to act on. */
const RULE_HINTS = [
  { keys: "↑↓", action: "move" },
  { keys: "n", action: "new" },
  { keys: "e", action: "edit" },
  { keys: "d", action: "clear" },
  { keys: "tab", action: "routes" },
  { keys: "esc", action: "back" },
];
const CLEAR_HINTS = [
  { keys: "y", action: "clear" },
  { keys: "n/esc", action: "cancel" },
];
/** The budgets view: every API profile, each with a budget to set; one with none has nothing to clear. */
const BUDGET_HINTS = [
  { keys: "↑↓", action: "move" },
  { keys: "e", action: "set budget" },
  { keys: "d", action: "clear" },
  { keys: "tab", action: "routes" },
  { keys: "esc", action: "back" },
];
const NO_API_HINTS = [
  { keys: "tab", action: "routes" },
  { keys: "esc", action: "back" },
];

type Loaded =
  | { kind: "loading" }
  | { kind: "broken"; error: unknown }
  /** `broken` are the routes routes.json holds that cannot be used, which are not listed. */
  | { kind: "ready"; file: RoutesFile; broken: BrokenRoute[]; registry: Registry | null };

/** A row of the dir rules view: a dir rule, or the defaults (always last, and always there). */
type RuleEntry = { target: Exclude<RuleTarget, { kind: "new" }>; label: string; slots: Slots };

/** One quota read, and the pick record as it was then. */
type Reading = { quotas: Record<string, QuotaSnapshot>; lastPicked: Record<string, string>; now: number };

/** The form on screen: a new route, or the selected one as stored. */
type FormOpen = { mode: "new" } | { mode: "edit"; name: string; spec: RouteSpec };

/** Without profiles.json the form has no accounts to offer, and every pattern names nobody. */
const NO_PROFILES: Registry = { version: 2, primarySources: {}, activeProfiles: {}, profiles: {} };

/** Every route, by name, ranked on `reading`; with none yet, on nothing, which lists the members only. */
function rankAll(file: RoutesFile, registry: Registry | null, reading: Reading | null, now: number): Entry[] {
  return Object.keys(file.routes)
    .sort()
    .map((name) => {
      const route = withDefaults(file.routes[name]);
      const ranking = rankRoute({
        route,
        members: registry ? membersOf(registry, route.tool) : [],
        quotas: reading?.quotas ?? {},
        lastPicked: reading?.lastPicked ?? {},
        now: reading?.now ?? now,
        resume: false,
      });
      return { name, route, ranking };
    });
}

/** Every API profile, by id. */
const apiProfiles = (registry: Registry | null) =>
  registry
    ? membersOf(registry, "all")
        .filter((member) => member.kind === "api")
        .sort(compareIds)
    : [];

/** The spend of every API profile, against its budget: what the budgets view and the form show. */
const spendTargets = (registry: Registry | null, budgets: Budgets) =>
  apiProfiles(registry).flatMap(
    (member) => spendTarget(member, Object.hasOwn(budgets, member.id) ? budgets[member.id] : undefined) ?? [],
  );

/**
 * Every subscription account and every API profile's spend: what the form offers, whether or not
 * a route takes it yet. An API profile is offered once it has a limit, which takes its reading.
 */
const everyTarget = (registry: Registry, budgets: Budgets) => [
  ...quotaTargets(withDefaults({ tool: "all" }), membersOf(registry, "all"), false),
  ...spendTargets(registry, budgets),
];

/**
 * The members of every route, once each: one quota read serves them all, as in `csn route list`.
 * An API profile's is its spend, against its budget when it has one.
 */
function targetsOf(file: RoutesFile, registry: Registry | null): QuotaTarget[] {
  const targets = new Map<string, QuotaTarget>();
  const { budgets } = readBudgets(file, namesOf(registry));
  for (const spec of Object.values(file.routes)) {
    const route = withDefaults(spec);
    const members = registry ? membersOf(registry, route.tool) : [];
    for (const target of quotaTargets(route, members, false, undefined, budgets)) targets.set(target.id, target);
  }
  return [...targets.values()];
}

/** The dir rules, then the defaults, as the rules view lists them. */
function ruleEntries(rules: ReturnType<typeof readRules>): RuleEntry[] {
  return [
    ...rules.dirs.map(
      (rule): RuleEntry => ({ target: { kind: "dir", dir: rule.dir }, label: rule.dir, slots: rule.slots }),
    ),
    { target: { kind: "defaults" }, label: "default", slots: rules.defaults },
  ];
}

/**
 * What `d` asks, naming the dir rules and defaults that go with the route, as `clausona route
 * remove` says what it removed: `Remove route work and the 2 dir rules that name it? (y/N)`.
 */
function removeQuestion(name: string, file: RoutesFile | undefined): string {
  const refs = file ? rulesNaming(file, name) : [];
  const dirs = new Set(refs.flatMap((ref) => (ref.dir === undefined ? [] : [ref.dir]))).size;
  const defaults = SLOT_TOOLS.filter((tool) => refs.some((ref) => ref.dir === undefined && ref.tool === tool));
  const parts = [
    ...(dirs ? [dirs === 1 ? "the dir rule" : `the ${dirs} dir rules`] : []),
    ...(defaults.length ? [`the ${defaults.join(" and ")} default${defaults.length > 1 ? "s" : ""}`] : []),
  ];
  if (parts.length === 0) return `Remove route ${name}? (y/N)`;
  const verb = dirs + defaults.length > 1 ? "name" : "names";
  const rules = parts.length === 1 ? ` and ${parts[0]}` : `, ${parts[0]} and ${parts[1]}`;
  return `Remove route ${name}${rules} that ${verb} it? (y/N)`;
}

/** The line that says routes are left out, and where to see why: `route list` lists each problem. */
function brokenNotice(count: number): string {
  const what = count === 1 ? "a route" : `${count} routes`;
  return `⚠ routes.json has ${what} that cannot be used: clausona route list says why.`;
}

/** A failed read is nothing read: the screen shows "no quota reading" rather than an error. */
const settle = <T,>(read: () => Promise<T>, fallback: T) =>
  Promise.resolve()
    .then(read)
    .catch(() => fallback);

/** The terminal's width, read again when it is resized. */
function useColumns(): number {
  const { stdout } = useStdout();
  const [columns, setColumns] = useState(stdout.columns ?? 80);
  useEffect(() => {
    const onResize = () => setColumns(stdout.columns ?? 80);
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);
  return columns;
}

export function RoutesScreen({ deps, onExit }: { deps?: RoutesListDeps; onExit: () => void }) {
  const [io] = useState(() => deps ?? defaultRoutesScreenDeps());
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [reading, setReading] = useState<Reading | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [removing, setRemoving] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [form, setForm] = useState<FormOpen | null>(null);
  /** Which list is on screen: the routes, the dir rules and defaults, or the API profiles' budgets. */
  const [view, setView] = useState<"routes" | "rules" | "budgets">("routes");
  const [ruleCursor, setRuleCursor] = useState(0);
  const [clearing, setClearing] = useState<RuleEntry | null>(null);
  const [ruleForm, setRuleForm] = useState<{ target: RuleTarget; slots: Slots } | null>(null);
  /** Quota of the accounts no route took, read for the form and the budgets view: they are on their rows. */
  const [extra, setExtra] = useState<Record<string, QuotaSnapshot>>({});
  const [budgetCursor, setBudgetCursor] = useState(0);
  /** The budget editor, on an API profile with its budget as stored. */
  const [budgetForm, setBudgetForm] = useState<{ id: string; budget?: Budget } | null>(null);
  /** The API profile whose budget `d` asks to clear. */
  const [clearingBudget, setClearingBudget] = useState<string | null>(null);
  const columns = useColumns();
  const alive = useRef(true);
  /** Only the latest read is shown: an `r` pressed twice must not end on the older answer. */
  const readSeq = useRef(0);

  const rank = useCallback(
    async (file: RoutesFile, registry: Registry | null, refresh: boolean) => {
      const seq = ++readSeq.current;
      const [quotas, lastPicked] = await Promise.all([
        settle(() => io.collectQuotas(targetsOf(file, registry), { refresh }), {}),
        settle(() => io.readPicks(), {}),
      ]);
      if (!alive.current || seq !== readSeq.current) return;
      setReading({ quotas, lastPicked, now: io.clock() });
      setRefreshing(false);
    },
    [io],
  );

  useEffect(() => {
    alive.current = true;
    void (async () => {
      try {
        const [{ file, broken }, registry] = await Promise.all([io.loadRoutes(), io.loadRegistry()]);
        // A profiles.json that cannot be read loads as none at all, which listed every route with
        // no accounts. None that is not there is clausona not set up, which the App sends to init.
        const problem = registry === null ? await io.registryProblem() : null;
        if (!alive.current) return;
        if (problem) {
          setLoaded({ kind: "broken", error: new Error(problem) });
          return;
        }
        // Painted at once; the quota follows.
        setLoaded({ kind: "ready", file, broken, registry });
        await rank(file, registry, false);
      } catch (error) {
        if (alive.current) setLoaded({ kind: "broken", error });
      }
    })();
    return () => {
      alive.current = false;
    };
  }, [io, rank]);

  /** Everything read so far: a saved route whose accounts were read for the form shows them at once. */
  const shown = useMemo(() => reading && { ...reading, quotas: { ...extra, ...reading.quotas } }, [reading, extra]);
  const entries = useMemo(
    () => (loaded.kind === "ready" ? rankAll(loaded.file, loaded.registry, shown, io.clock()) : []),
    [loaded, shown, io],
  );
  const index = Math.min(cursor, Math.max(0, entries.length - 1));
  const selected = entries[index];
  const rules = useMemo(
    () => (loaded.kind === "ready" ? readRules(loaded.file, io.system.platform) : null),
    [loaded, io],
  );
  const rows = useMemo(() => (rules ? ruleEntries(rules) : []), [rules]);
  /** What is wrong with the rules, as `clausona route list` warns about it. */
  const ruleNotes = useMemo(
    () =>
      rules && loaded.kind === "ready" ? [...rules.problems, ...ruleWarnings(loaded.file, loaded.broken, rules)] : [],
    [rules, loaded],
  );
  const ruleIndex = Math.min(ruleCursor, Math.max(0, rows.length - 1));
  const budgets = useMemo(
    () => (loaded.kind === "ready" ? readBudgets(loaded.file, namesOf(loaded.registry)) : null),
    [loaded],
  );
  /** Every API profile as the budgets view lists it, from what has been read of its spend. */
  const budgetRows = useMemo((): BudgetRow[] => {
    if (loaded.kind !== "ready" || !budgets) return [];
    const quotas = shown?.quotas ?? extra;
    return apiProfiles(loaded.registry).map((member) => {
      const budget = Object.hasOwn(budgets.budgets, member.id) ? budgets.budgets[member.id] : undefined;
      const routes = Object.keys(loaded.file.routes).filter((name) =>
        apiMembers(loaded.file.routes[name], loaded.registry ?? NO_PROFILES).some((each) => each.id === member.id),
      );
      return budgetRowOf(member.id, quotas[member.id], budget, routes);
    });
  }, [loaded, budgets, shown, extra]);
  /** What is wrong with the budgets, as `clausona route budget` warns about it. */
  const budgetNotes = useMemo(
    () =>
      budgets && loaded.kind === "ready"
        ? [...budgets.problems, ...(loaded.registry ? budgetWarnings(budgets.budgets, loaded.registry.profiles) : [])]
        : [],
    [budgets, loaded],
  );
  const budgetIndex = Math.min(budgetCursor, Math.max(0, budgetRows.length - 1));

  async function remove(name: string) {
    try {
      let written = false;
      const file = await io.updateRoutes((current) => {
        if (!Object.hasOwn(current.routes, name)) return null;
        delete current.routes[name];
        // As `clausona route remove` does: a rule that names it would only be skipped from now on.
        removeReferences(current, name);
        written = true;
        return current;
      });
      if (!alive.current) return;
      // A file written has nothing left that cannot be used; one left alone has what it had.
      setLoaded((prev) => (prev.kind === "ready" ? { ...prev, file, broken: written ? [] : prev.broken } : prev));
      setCursor((prev) => Math.max(0, Math.min(prev, Object.keys(file.routes).length - 1)));
    } catch (error) {
      if (!alive.current) return;
      if (error instanceof RoutesFileError) setLoaded({ kind: "broken", error });
      else setMessage(`${symbol.cross} ${errorText(error)}`);
    }
  }

  /** Reads `targets` into `extra`, through the cache: rows the routes' own read did not cover. */
  function readExtra(targets: QuotaTarget[]) {
    if (targets.length === 0) return;
    void settle(() => io.collectQuotas(targets), {}).then((quotas) => {
      if (alive.current) setExtra((prev) => ({ ...prev, ...quotas }));
    });
  }

  function openForm(open: FormOpen) {
    if (loaded.kind !== "ready") return;
    setForm(open);
    if (!loaded.registry) return;
    // The form offers every subscription account, so the ones no route takes are read too: from
    // the quota cache while it is fresh, else fetched, which may renew a lapsed sign-in as the
    // dashboard's own read does (collectQuotas' rules, never a forced refresh). So is each API
    // profile's spend, which says whether it has a limit to be offered with.
    const read = new Set([
      ...targetsOf(loaded.file, loaded.registry).map((target) => target.id),
      ...Object.keys(extra),
    ]);
    readExtra(everyTarget(loaded.registry, budgets?.budgets ?? {}).filter((target) => !read.has(target.id)));
  }

  /** The budgets view, with every API profile's spend read for it: a budget set since counts at once. */
  function openBudgets(file: RoutesFile, registry: Registry | null) {
    setView("budgets");
    readExtra(spendTargets(registry, readBudgets(file, namesOf(registry)).budgets));
  }

  /** routes.json read again after a budget was set or cleared, and the spend with it. */
  async function budgetChanged() {
    if (loaded.kind !== "ready") return;
    const { registry } = loaded;
    try {
      const { file, broken } = await io.loadRoutes();
      if (!alive.current) return;
      setLoaded({ kind: "ready", file, broken, registry });
      openBudgets(file, registry);
      await rank(file, registry, false);
    } catch (error) {
      if (alive.current) setLoaded({ kind: "broken", error });
    }
  }

  async function clearBudgetOf(id: string) {
    try {
      await io.updateRoutes((current) => (clearBudget(current, id) ? current : null));
      if (alive.current) await budgetChanged();
    } catch (error) {
      if (!alive.current) return;
      if (error instanceof RoutesFileError) setLoaded({ kind: "broken", error });
      else setMessage(`${symbol.cross} ${errorText(error)}`);
    }
  }

  /** The keys of the budgets view. */
  function handleBudgets(input: string, key: Key) {
    const count = budgetRows.length;
    const row = budgetRows[budgetIndex];
    if (key.tab) setView("routes");
    else if (key.upArrow && count > 0) setBudgetCursor((budgetIndex - 1 + count) % count);
    else if (key.downArrow && count > 0) setBudgetCursor((budgetIndex + 1) % count);
    else if (input === "e" && row) setBudgetForm({ id: row.id, ...(row.budget ? { budget: row.budget } : {}) });
    else if (input === "d" && row?.budget) setClearingBudget(row.id);
  }

  /**
   * Back to the list, with routes.json read again whichever way the form was left: it may have
   * saved, or found the file changed by another terminal and reloaded. The saved route is
   * selected, else the one that was. `note` is what the save also changed.
   */
  async function closeForm(saved: string | null, note?: string) {
    setForm(null);
    if (note) setMessage(note);
    if (loaded.kind !== "ready") return;
    const { registry } = loaded;
    const keep = saved ?? selected?.name;
    try {
      const { file, broken } = await io.loadRoutes();
      if (!alive.current) return;
      if (
        saved === null &&
        JSON.stringify(file) === JSON.stringify(loaded.file) &&
        broken.length === loaded.broken.length
      ) {
        return;
      }
      setLoaded({ kind: "ready", file, broken, registry });
      setCursor(Math.max(0, keep === undefined ? 0 : Object.keys(file.routes).sort().indexOf(keep)));
      await rank(file, registry, false);
    } catch (error) {
      if (alive.current) setLoaded({ kind: "broken", error });
    }
  }

  /** routes.json read again after the rule form, or a rule cleared, wrote it. */
  async function reload() {
    if (loaded.kind !== "ready") return;
    const { registry } = loaded;
    try {
      const { file, broken } = await io.loadRoutes();
      if (!alive.current) return;
      setLoaded({ kind: "ready", file, broken, registry });
      await rank(file, registry, false);
    } catch (error) {
      if (alive.current) setLoaded({ kind: "broken", error });
    }
  }

  async function clearRule(entry: RuleEntry) {
    try {
      await io.updateRoutes((current) => {
        const cleared =
          entry.target.kind === "defaults"
            ? clearDefaultRoute(current, SLOT_TOOLS)
            : clearDirRoute(current, undefined, (stored) => stored === entry.label);
        return cleared.length ? current : null;
      });
      if (alive.current) await reload();
    } catch (error) {
      if (!alive.current) return;
      if (error instanceof RoutesFileError) setLoaded({ kind: "broken", error });
      else setMessage(`${symbol.cross} ${errorText(error)}`);
    }
  }

  /** The keys of the dir rules view. */
  function handleRules(input: string, key: Key) {
    const count = rows.length;
    const entry = rows[ruleIndex];
    if (key.tab) setView("routes");
    else if (key.upArrow) setRuleCursor((ruleIndex - 1 + count) % count);
    else if (key.downArrow) setRuleCursor((ruleIndex + 1) % count);
    else if (input === "n") setRuleForm({ target: { kind: "new" }, slots: {} });
    else if (input === "e" && entry) setRuleForm({ target: entry.target, slots: entry.slots });
    else if (input === "d" && entry && Object.keys(entry.slots).length > 0) setClearing(entry);
  }

  const handle = (input: string, key: Key) => {
    // The question takes the next key, whatever it is: only y removes.
    if (removing) {
      setRemoving(null);
      if (input === "y" || input === "Y") void remove(removing);
      return;
    }
    if (clearing) {
      setClearing(null);
      if (input === "y" || input === "Y") void clearRule(clearing);
      return;
    }
    if (clearingBudget) {
      setClearingBudget(null);
      if (input === "y" || input === "Y") void clearBudgetOf(clearingBudget);
      return;
    }
    if (key.escape) {
      onExit();
      return;
    }
    // Loading, or a routes.json that cannot be used: esc is the only key.
    if (loaded.kind !== "ready") return;
    setMessage("");
    if (view === "rules") {
      handleRules(input, key);
      return;
    }
    if (view === "budgets") {
      handleBudgets(input, key);
      return;
    }
    if (key.tab) {
      setView("rules");
      return;
    }
    if (input === "b") {
      openBudgets(loaded.file, loaded.registry);
      return;
    }
    const count = entries.length;
    if (key.upArrow && count > 0) setCursor((index - 1 + count) % count);
    else if (key.downArrow && count > 0) setCursor((index + 1) % count);
    else if (input === "r" && count > 0) {
      setRefreshing(true);
      void rank(loaded.file, loaded.registry, true);
    } else if (input === "d" && selected) setRemoving(selected.name);
    else if (input === "n") openForm({ mode: "new" });
    else if (input === "e" && selected) {
      openForm({ mode: "edit", name: selected.name, spec: loaded.file.routes[selected.name] });
    }
  };
  // Answered with the state on screen, as the App's keys are (`useCommittedHandler` in App.tsx).
  const handler = useRef(handle);
  useLayoutEffect(() => {
    handler.current = handle;
  });
  const onInput = useCallback((input: string, key: Key) => handler.current(input, key), []);
  // The forms answer their own keys.
  useInput(onInput, { isActive: form === null && ruleForm === null && budgetForm === null });

  const question = removing
    ? removeQuestion(removing, loaded.kind === "ready" ? loaded.file : undefined)
    : clearing
      ? clearing.target.kind === "defaults"
        ? "Clear the defaults? (y/N)"
        : `Clear the dir rule for ${clearing.label}? (y/N)`
      : clearingBudget
        ? `Clear the budget for ${clearingBudget}? (y/N)`
        : undefined;
  const notice = loaded.kind === "ready" && loaded.broken.length > 0 ? brokenNotice(loaded.broken.length) : "";
  // Said on the routes list, where the rules are out of sight.
  const rulesNotice =
    view === "routes" && ruleNotes.length > 0 ? "⚠ A dir rule or default needs a look: tab shows it." : "";
  const footer = [notice, rulesNotice, refreshing ? "Reading quota again…" : message];
  const hints = removing
    ? CONFIRM_HINTS
    : clearing || clearingBudget
      ? CLEAR_HINTS
      : loaded.kind !== "ready"
        ? BACK_HINTS
        : view === "rules"
          ? RULE_HINTS
          : view === "budgets"
            ? budgetRows.length === 0
              ? NO_API_HINTS
              : BUDGET_HINTS
            : entries.length === 0
              ? EMPTY_HINTS
              : HINTS;

  if (loaded.kind !== "ready") {
    return (
      <Chrome title="Routes" hints={hints}>
        {loaded.kind === "loading" ? (
          <Text color={color.muted}>Reading routes…</Text>
        ) : (
          <FileProblem error={loaded.error} />
        )}
      </Chrome>
    );
  }

  if (ruleForm) {
    return (
      <RuleForm
        {...ruleForm}
        routes={Object.keys(loaded.file.routes)
          .sort()
          .map((name) => ({ name, tool: loaded.file.routes[name].tool }))}
        broken={loaded.broken.map((route) => route.name)}
        deps={io}
        onDone={(saved) => {
          setRuleForm(null);
          if (saved) void reload();
        }}
      />
    );
  }

  if (budgetForm) {
    return (
      <BudgetForm
        {...budgetForm}
        deps={io}
        onDone={(saved) => {
          setBudgetForm(null);
          if (saved) void budgetChanged();
        }}
      />
    );
  }

  if (view === "budgets") {
    return (
      <Chrome title="Routes" subtitle="Budgets" footer={footer} question={question} hints={hints}>
        {budgetRows.length === 0 ? (
          <Text color={color.muted}>No API profiles. Add one with clausona add {"<name>"} --api ….</Text>
        ) : (
          <Box flexDirection="column" borderStyle="round" borderColor={color.dim} paddingX={1}>
            <BudgetList rows={budgetRows} index={budgetIndex} />
          </Box>
        )}
        <Box flexDirection="column" marginTop={1}>
          <Text color={color.muted}>An API profile joins a route only with a spend limit:</Text>
          <Text color={color.muted}>a budget set here, which replaces its key's own, or that one.</Text>
          {budgetNotes.map((note) => (
            <Text key={note} color={color.warning}>
              {`⚠ ${note}`}
            </Text>
          ))}
        </Box>
      </Chrome>
    );
  }

  if (view === "rules") {
    return (
      <Chrome title="Routes" subtitle="Dir rules" footer={footer} question={question} hints={hints}>
        <Box flexDirection="column" borderStyle="round" borderColor={color.dim} paddingX={1}>
          <RuleList entries={rows} index={ruleIndex} file={loaded.file} broken={loaded.broken} />
        </Box>
        <Box flexDirection="column" marginTop={1}>
          {/* Short enough for one line in a narrow pane: wrapped, ink starts the next line with a space. */}
          <Text color={color.muted}>The deepest dir rule wins; then the default.</Text>
          {ruleNotes.map((note) => (
            <Text key={note} color={color.warning}>
              {`⚠ ${note}`}
            </Text>
          ))}
        </Box>
      </Chrome>
    );
  }

  if (form) {
    const registry = loaded.registry ?? NO_PROFILES;
    const quotas = shown?.quotas ?? extra;
    const held = budgets?.budgets ?? {};
    // An API profile is offered with a limit it can be read to have, and when the route names it.
    const named = new Set(form.mode === "edit" ? apiMembers(form.spec, registry).map((member) => member.id) : []);
    const offer = (id: string) =>
      named.has(id) || limitProblem(id, quotas[id], Object.hasOwn(held, id) ? held[id] : undefined) === null;
    return (
      <RouteForm
        {...form}
        accounts={formAccounts(registry, offer)}
        quotas={quotas}
        lastPicked={reading?.lastPicked ?? {}}
        registry={registry}
        budgets={held}
        deps={io}
        now={reading?.now ?? io.clock()}
        onDone={(saved, note) => void closeForm(saved, note)}
      />
    );
  }

  if (entries.length === 0) {
    return (
      <Chrome title="Routes" footer={footer} hints={hints}>
        <NoRoutes accounts={newRouteAccounts(loaded.registry)} />
      </Chrome>
    );
  }

  const wide = columns >= WIDE_AT;
  return (
    <Chrome title="Routes" footer={footer} question={question} hints={hints}>
      <Box flexDirection={wide ? "row" : "column"} gap={wide ? 2 : 1} width="100%">
        <Box
          flexDirection="column"
          width={wide ? LIST_WIDTH : "100%"}
          flexShrink={0}
          borderStyle="round"
          borderColor={color.dim}
          paddingX={1}
        >
          <RouteList entries={entries} index={index} pending={reading === null} />
        </Box>
        <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={1}>
          {selected ? <RouteDetail entry={selected} pending={reading === null} /> : null}
        </Box>
      </Box>
    </Chrome>
  );
}

/** Why routes.json (or the registry) cannot be read, in the words `csn route list` would print. */
function FileProblem({ error }: { error: unknown }) {
  const headline = error instanceof RoutesFileError ? `${error.filePath} cannot be used:` : errorText(error);
  return (
    <Box flexDirection="column">
      <Box gap={1}>
        <Box flexShrink={0}>
          <Text color={color.error}>{symbol.cross}</Text>
        </Box>
        <Text color={color.text}>{headline}</Text>
      </Box>
      {error instanceof RoutesFileError ? (
        <>
          <Box paddingLeft={4}>
            <Text color={color.text}>{error.problems.join("\n")}</Text>
          </Box>
          {/* A file from a newer clausona is fixed by updating, which its problem says. */}
          {error.newer ? null : (
            <Box marginTop={1}>
              <Text color={color.secondary}>Fix it with clausona route edit.</Text>
            </Box>
          )}
        </>
      ) : null}
    </Box>
  );
}

/** How many accounts the route `n` makes takes as it opens: `*` over the Claude accounts. */
function newRouteAccounts(registry: Registry | null): number {
  const route = withDefaults({ tool: "claude" });
  return registry ? expandPatterns(route.from, membersOf(registry, route.tool)).members.length : 0;
}

function accountsText(count: number): string {
  if (count === 0) return "every Claude account (none yet)";
  return count === 1 ? "your one Claude account" : `all ${count} Claude accounts`;
}

/**
 * What a route is and what `n` would make, in one column: an empty list box beside it read as a
 * disabled field. Lines are broken here, not left to wrap, so that none begins with a space.
 */
function NoRoutes({ accounts }: { accounts: number }) {
  return (
    <Box flexDirection="column">
      <Text color={color.text} bold>
        No routes yet
      </Text>
      <Box flexDirection="column" marginTop={1}>
        <Text color={color.text}>A route picks an account for each run, so</Text>
        <Text color={color.text}>you don't have to. Run on one with:</Text>
      </Box>
      <Box marginTop={1} paddingLeft={2}>
        <Text color={color.brandLight}>clausona run --route {"<name>"}</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <Text color={color.secondary}>A new route, unless you change it:</Text>
        <Box flexDirection="column" paddingLeft={2}>
          <Setting label="Accounts" value={accountsText(accounts)} />
          <Setting label="Order" value="the next one in turn" />
          <Setting label="Skip at" value={`${DEFAULT_MAX_USAGE}% of the 5-hour or weekly limit`} />
        </Box>
      </Box>
      <Box marginTop={1}>
        <Text color={color.text}>
          Press{" "}
          <Text color={color.active} bold>
            n
          </Text>{" "}
          to create one.
        </Text>
      </Box>
    </Box>
  );
}

/**
 * `<free>/<members>`, as `route list` counts them; `…` for free until the quota is read, and `—`
 * when none of it could be (offline), which says nothing about who is free.
 */
function countText(ranking: Ranking, pending: boolean): string {
  const { free, members } = freeNow(ranking);
  return `${pending ? "…" : nothingRead(ranking.rows) ? "—" : free}/${members}`;
}

function RouteList({ entries, index, pending }: { entries: Entry[]; index: number; pending: boolean }) {
  const [list, width] = useWidth();
  const counts = entries.map((entry) => countText(entry.ranking, pending));
  const toolWidth = Math.max(...entries.map((entry) => entry.route.tool.length));
  const countWidth = Math.max(...counts.map((count) => count.length));
  const longest = Math.max(...entries.map((entry) => entry.name.length));
  const nameWidth = Math.max(1, Math.min(longest, width - MARK - GAP - toolWidth - GAP - countWidth));
  return (
    <Box ref={list} flexDirection="column">
      {entries.map((entry, i) => {
        const focused = i === index;
        // Muted, not a warning, when nothing was read: that is not nobody free.
        const unread = pending || nothingRead(entry.ranking.rows);
        const nobody = !unread && freeNow(entry.ranking).free === 0;
        return (
          <Box key={entry.name} flexDirection="row">
            <Box width={MARK} flexShrink={0}>
              <Text color={focused ? color.cursor : color.dim}>{focused ? "▸" : " "}</Text>
            </Box>
            <Box width={nameWidth} flexShrink={0}>
              <Text color={focused ? color.text : color.secondary} bold={focused} wrap="truncate-end">
                {entry.name}
              </Text>
            </Box>
            <Box width={toolWidth} marginLeft={GAP} flexShrink={0}>
              <Text color={color.muted}>{entry.route.tool}</Text>
            </Box>
            <Box marginLeft={GAP} flexShrink={0}>
              <Text color={unread ? color.muted : nobody ? color.warning : color.text}>
                {counts[i].padStart(countWidth)}
              </Text>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

/** The usage column's width: `100%`, or a dash. */
const USAGE = 4;

/**
 * Every API profile, a row each: its usage, then its spend against its limit and whose limit it
 * is, or why it has none - as `clausona route budget` lists them.
 */
function BudgetList({ rows, index }: { rows: BudgetRow[]; index: number }) {
  const [list, width] = useWidth();
  const longest = Math.max("PROFILE".length, ...rows.map((row) => row.id.length));
  const idWidth = Math.max(1, Math.min(longest, width - MARK - GAP - USAGE - GAP - 8));
  return (
    <Box ref={list} flexDirection="column">
      <Box flexDirection="row">
        <Box width={MARK + idWidth} flexShrink={0}>
          <Text color={color.muted} wrap="truncate-end">
            {" ".repeat(MARK)}PROFILE
          </Text>
        </Box>
        <Box marginLeft={GAP} width={USAGE + 1} flexShrink={0}>
          <Text color={color.muted}>USAGE</Text>
        </Box>
      </Box>
      {rows.map((row, i) => {
        const focused = i === index;
        return (
          <Box key={row.id} flexDirection="row">
            <Box width={MARK} flexShrink={0}>
              <Text color={focused ? color.cursor : color.dim}>{focused ? "▸" : " "}</Text>
            </Box>
            <Box width={idWidth} flexShrink={0}>
              <Text color={focused ? color.text : color.secondary} bold={focused} wrap="truncate-end">
                {row.id}
              </Text>
            </Box>
            <Box marginLeft={GAP} width={USAGE + 1} flexShrink={0} justifyContent="flex-end">
              <QuotaCell window={row.window} live width={USAGE} />
            </Box>
            <Box marginLeft={GAP} flexGrow={1} flexShrink={1} minWidth={0}>
              <Text
                color={row.window ? color.secondary : row.spend === "unread" ? color.warning : color.muted}
                wrap="truncate-end"
              >
                {/* Here, `e` is how one is set. */}
                {row.spend === "no-limit" ? "no spend limit; e sets a budget" : budgetNote(row)}
              </Text>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

/** The directory column's header, which is also the narrowest that column gets. */
const DIRECTORY = "DIRECTORY";

/**
 * The dir rules and the defaults, a row each: the directory, and the route each tool's slot
 * names. A slot whose route cannot be used there is in the warning colour, `?` when it cannot be
 * read; `—` is none.
 */
function RuleList({
  entries,
  index,
  file,
  broken,
}: {
  entries: RuleEntry[];
  index: number;
  file: RoutesFile;
  broken: BrokenRoute[];
}) {
  const [list, width] = useWidth();
  const cell = (slots: Slots, tool: ToolName): { text: string; usable: boolean } => {
    const slot = slots[tool];
    if (!slot) return { text: "—", usable: true };
    if ("problem" in slot) return { text: "?", usable: false };
    return { text: slot.route, usable: routeProblem(file, broken, tool, slot.route) === null };
  };
  const cells = entries.map((entry) => SLOT_TOOLS.map((tool) => cell(entry.slots, tool)));
  const longest = Math.max(DIRECTORY.length, ...entries.map((entry) => entry.label.length));
  const longestSlot = Math.max("CLAUDE".length, ...cells.flat().map((each) => each.text.length));
  // The two route columns share what the directory's header leaves them: a long route name is cut
  // rather than pushing the row past the frame, or squeezing every directory down to a `…`.
  const slotWidth = Math.max(1, Math.min(longestSlot, Math.floor((width - MARK - DIRECTORY.length - 2 * GAP) / 2)));
  const labelWidth = Math.max(1, Math.min(longest, width - MARK - 2 * (GAP + slotWidth)));
  return (
    <Box ref={list} flexDirection="column">
      <Box flexDirection="row">
        <Box width={MARK + labelWidth} flexShrink={0}>
          <Text color={color.muted} wrap="truncate-end">
            {" ".repeat(MARK)}
            {DIRECTORY}
          </Text>
        </Box>
        {["CLAUDE", "CODEX"].map((label) => (
          <Box key={label} width={slotWidth} marginLeft={GAP} flexShrink={0}>
            <Text color={color.muted} wrap="truncate-end">
              {label}
            </Text>
          </Box>
        ))}
      </Box>
      {entries.map((entry, i) => {
        const focused = i === index;
        return (
          <Box key={entry.label} flexDirection="row">
            <Box width={MARK} flexShrink={0}>
              <Text color={focused ? color.cursor : color.dim}>{focused ? "▸" : " "}</Text>
            </Box>
            <Box width={labelWidth} flexShrink={0}>
              <Text
                color={entry.target.kind === "defaults" ? color.muted : focused ? color.text : color.secondary}
                bold={focused}
                wrap="truncate-start"
              >
                {entry.label}
              </Text>
            </Box>
            {cells[i].map((slot, n) => (
              <Box key={SLOT_TOOLS[n]} width={slotWidth} marginLeft={GAP} flexShrink={0}>
                <Text
                  color={slot.usable ? (slot.text === "—" ? color.dim : color.text) : color.warning}
                  wrap="truncate-end"
                >
                  {slot.text}
                </Text>
              </Box>
            ))}
          </Box>
        );
      })}
    </Box>
  );
}
