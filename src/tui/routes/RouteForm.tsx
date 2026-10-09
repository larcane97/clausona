import { Box, type Key, Text, useInput } from "ink";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  holdsKey,
  ROUTE_TOOLS,
  type RouteSpec,
  STRATEGIES,
  type Strategy,
  withDefaults,
} from "../../core/route-config.js";
import { matchesMember } from "../../core/route-patterns.js";
import { type Ranking, rankRoute } from "../../core/routing.js";
import { toolLabel } from "../../lib/route-render.js";
import { checkRouteMembers, membersOf } from "../../lib/route-service.js";
import type { QuotaSnapshot, Registry } from "../../types.js";
import { Chrome } from "../components/Chrome.js";
import { FieldInput } from "../components/FieldInput.js";
import { color } from "../theme.js";
import {
  AccountRows,
  ErrorLines,
  FallbackEntries,
  FallbackPicker,
  Line,
  NowLine,
  Radio,
  SubLabel,
} from "./RouteFormRows.js";
import {
  accountsFor,
  type FormAccount,
  type FormAction,
  type FormField,
  formToSpec,
  initialFormState,
  type RouteFormState,
  reduceForm,
  splitList,
  TEXT_KEYS,
} from "./route-form-state.js";
import { errorText, type RoutesScreenDeps } from "./routes-deps.js";

/**
 * The Routes screen's form: a new route (`n`) or the selected one (`e`), with everything the CLI
 * can set. The state and its rules are route-form-state.ts and its lines RouteFormRows.tsx; this
 * holds the state, turns keys into its actions, previews who would be picked, and saves through
 * updateRoutes - and only over the routes.json it opened on.
 */

type Errors = RouteFormState["errors"];
type TextField = keyof typeof TEXT_KEYS;

export type RouteFormProps = {
  mode: "new" | "edit";
  /** edit: the route's name on disk. */
  name?: string;
  /** edit: the route as stored, its unset keys unset. */
  spec?: RouteSpec;
  accounts: FormAccount[];
  quotas: Record<string, QuotaSnapshot>;
  lastPicked: Record<string, string>;
  registry: Registry;
  deps: RoutesScreenDeps;
  now: number;
  /** The name the route was saved under, or null when the form was left without saving. */
  onDone: (saved: string | null) => void;
};

/** The accounts a route can take in this version: the subscription profiles of both tools. */
export function formAccounts(registry: Registry): FormAccount[] {
  return membersOf(registry, "all")
    .filter((member) => member.kind === "subscription")
    .map(({ id, tool, name, email }) => ({ id, tool, name, email }));
}

/** What a field holding something key-shaped shows instead: a constant, as the API form's key field. */
const MASK = "•".repeat(8);

const CHANGED = "routes.json changed since this form opened; it was reloaded. Review and save again.";

/** The name never changes the spec, so the preview runs on a stand-in until one is typed, or while it is refused. */
const PREVIEW_NAME = "preview";

const STRATEGY_TEXT: Record<Strategy, string> = {
  "round-robin": "takes accounts in turn",
  headroom: "picks the account with the most room",
  expiring: "uses weekly limits that reset within 24h first",
};

type Hint = { keys: string; action: string };

/**
 * The keys of the focused field, before the ones every field takes: all of them at once did not
 * fit 80 columns, and the second line began with a separator. The fallback leaves out `↑↓ move`,
 * the one its `▸` and the accounts' hints make plain, so the set fits too.
 */
const FIELD_HINTS: Partial<Record<FormField, Hint[]>> = {
  tool: [{ keys: "←→", action: "choose" }],
  accounts: [
    { keys: "↑↓", action: "move" },
    { keys: "space", action: "toggle" },
  ],
  strategy: [{ keys: "←→", action: "choose" }],
  fallback: [
    { keys: "a", action: "add" },
    { keys: "x", action: "remove" },
    { keys: "[ ]", action: "reorder" },
  ],
};
const EVERY_FIELD_HINTS: Hint[] = [
  { keys: "tab", action: "next field" },
  { keys: "enter", action: "save" },
  { keys: "esc", action: "cancel" },
];
const PICKER_HINTS = [
  { keys: "↑↓", action: "move" },
  { keys: "enter", action: "add" },
  { keys: "esc", action: "close" },
];
const CONFIRM_HINTS = [
  { keys: "y", action: "discard" },
  { keys: "n/esc", action: "keep editing" },
];

/**
 * Whether a field's value is drawn as the mask: what the save would refuse as a key, asked as the
 * save asks it. A pattern field is asked entry by entry, as checkPattern is given them: a list of
 * three emails is longer than one name can be, and is not a key.
 */
const keyShaped = (field: TextField, value: string) =>
  field === "from" || field === "exclude" ? splitList(value).some(holdsKey) : holdsKey(value);

/** The next of `options` to the left or right of `current`, round from one end to the other. */
function step<T>(options: readonly T[], current: T, delta: 1 | -1): T {
  const at = options.indexOf(current);
  return options[(at + delta + options.length) % options.length] ?? current;
}

const own = (routes: Record<string, RouteSpec>, name: string) =>
  Object.hasOwn(routes, name) ? routes[name] : undefined;

/** Two specs as routes.json writes them; key order counts, which can only call a match a change. */
const sameSpec = (a: RouteSpec | undefined, b: RouteSpec | undefined) => JSON.stringify(a) === JSON.stringify(b);

type Outcome = "saved" | "changed" | Errors;

export function RouteForm(props: RouteFormProps) {
  const { accounts, quotas, lastPicked, registry, deps, now, onDone } = props;
  const original = props.mode === "edit" ? props.name : undefined;
  const [state, setState] = useState(() =>
    initialFormState(
      original !== undefined && props.spec ? { mode: "edit", name: original, spec: props.spec } : { mode: "new" },
      accounts,
    ),
  );
  /** The text cursor of the field it was last moved in; any other field's is at its end. */
  const [caret, setCaret] = useState<{ field: TextField; at: number } | null>(null);
  /** The fallback picker's row, while it is open. */
  const [picking, setPicking] = useState<number | null>(null);
  const [asking, setAsking] = useState(false);
  const [saving, setSaving] = useState(false);
  /** routes.json as it was when the form opened (or last reloaded): a save compares the file with it. */
  const base = useRef<Promise<string | null>>(undefined);
  /** The route the edit started from: under the lock it must still be the one on disk. */
  const startSpec = useRef(props.spec);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    const read = deps.readRoutesText();
    // A failed read is a failed save, reported then.
    read.catch(() => {});
    base.current = read;
    return () => {
      alive.current = false;
    };
  }, [deps]);

  const listed = useMemo(() => accountsFor(state.tool, accounts), [state.tool, accounts]);
  const members = useMemo(() => new Map(membersOf(registry, "all").map((member) => [member.id, member])), [registry]);
  const preview = useMemo((): Ranking | null => {
    const { spec } = formToSpec({ ...state, name: PREVIEW_NAME }, accounts);
    if (!spec) return null;
    const route = withDefaults(spec);
    return rankRoute({ route, members: membersOf(registry, route.tool), quotas, lastPicked, now, resume: false });
  }, [state, accounts, registry, quotas, lastPicked, now]);
  const candidates = listed.filter((account) => !state.fallback.includes(account.id));

  /**
   * Unticked under every account, or matched by an exclude pattern: either way out of the route. A
   * pattern-excluded account stays ticked in the state, which saving it back needs.
   */
  const excluded = useMemo(() => {
    const patterns = splitList(state.excludeText);
    return new Set(
      listed
        .filter((account) => {
          if (state.every && !state.ticked.includes(account.id)) return true;
          const member = members.get(account.id);
          return member !== undefined && patterns.some((pattern) => matchesMember(pattern, member));
        })
        .map((account) => account.id),
    );
  }, [listed, members, state.every, state.ticked, state.excludeText]);

  const dispatch = (action: FormAction) => setState((current) => reduceForm(current, action, accounts));
  const showErrors = (errors: Errors) => setState((current) => ({ ...current, errors }));

  /**
   * routes.json as the form opened on it. If that read failed it is read once more, here, and
   * becomes what later saves compare with: a failed read at open no longer fails every save. A
   * change made before this read is then not seen by the compare, but an edited route is still
   * checked under the lock below.
   */
  async function openedText(): Promise<string | null | undefined> {
    try {
      return await base.current;
    } catch {
      const read = deps.readRoutesText();
      base.current = read;
      return read;
    }
  }

  /** Writes the route, unless routes.json is not what the form opened on. */
  async function write(name: string, spec: RouteSpec): Promise<Outcome> {
    const opened = await openedText();
    const current = await deps.readRoutesText();
    if (current !== opened) return "changed";
    let outcome: Outcome = "saved";
    await deps.updateRoutes((file) => {
      // The text compare above leaves a moment before the lock, and the spec came from the
      // screen's earlier read: the route on disk, under the lock, is the one that counts.
      if (original !== undefined && !sameSpec(own(file.routes, original), startSpec.current)) {
        outcome = "changed";
        return null;
      }
      if (name !== original && Object.hasOwn(file.routes, name)) {
        outcome = { name: `Route '${name}' already exists.` };
        return null;
      }
      if (original !== undefined && name !== original) delete file.routes[original];
      file.routes[name] = spec;
      return file;
    });
    return outcome;
  }

  /** Starts again from routes.json as it is now: an edit takes its route from it, a new route keeps its inputs. */
  async function reload() {
    const [text, file] = await Promise.all([deps.readRoutesText(), deps.readRoutes()]);
    base.current = Promise.resolve(text);
    const fresh = original === undefined ? undefined : own(file.routes, original);
    startSpec.current = fresh;
    if (!alive.current) return;
    if (original !== undefined && fresh) {
      const name = original;
      setState((current) => ({
        ...initialFormState({ mode: "edit", name, spec: fresh }, accounts),
        focus: current.focus,
        errors: { form: CHANGED },
      }));
    } else {
      showErrors({ form: CHANGED });
    }
  }

  async function save() {
    const { name, spec, errors } = formToSpec(state, accounts);
    if (!spec) {
      showErrors(errors);
      return;
    }
    try {
      checkRouteMembers(name, spec, registry);
    } catch (error) {
      showErrors({ form: errorText(error) });
      return;
    }
    setSaving(true);
    try {
      const outcome = await write(name, spec);
      if (!alive.current) return;
      if (outcome === "saved") {
        // Keys stay off: the screen takes over.
        onDone(name);
        return;
      }
      if (outcome === "changed") await reload();
      else showErrors(outcome);
    } catch (error) {
      if (alive.current) showErrors({ form: errorText(error) });
    }
    if (alive.current) setSaving(false);
  }

  function pick(key: Key) {
    if (key.escape) setPicking(null);
    else if (key.upArrow) setPicking((row) => Math.max(0, (row ?? 0) - 1));
    else if (key.downArrow) setPicking((row) => Math.max(0, Math.min(candidates.length - 1, (row ?? 0) + 1)));
    else if (key.return) {
      const chosen = candidates[picking ?? 0];
      if (chosen) dispatch({ type: "fallback-add", id: chosen.id });
      setPicking(null);
    }
  }

  const handle = (input: string, key: Key) => {
    if (saving) return;
    // The question takes the next key, whatever it is: only y discards.
    if (asking) {
      setAsking(false);
      if (input === "y" || input === "Y") onDone(null);
      return;
    }
    if (picking !== null) {
      pick(key);
      return;
    }
    if (key.escape) {
      if (state.dirty) setAsking(true);
      else onDone(null);
      return;
    }
    if (key.return) {
      void save();
      return;
    }
    if (key.tab) {
      dispatch({ type: "focus", delta: key.shift ? -1 : 1 });
      return;
    }
    const across = key.leftArrow ? -1 : key.rightArrow ? 1 : 0;
    const down = key.upArrow ? -1 : key.downArrow ? 1 : 0;
    if (across && state.focus === "tool") {
      dispatch({ type: "tool", tool: step(ROUTE_TOOLS, state.tool, across) });
    } else if (across && state.focus === "strategy") {
      dispatch({ type: "strategy", strategy: step(STRATEGIES, state.strategy, across) });
    } else if (down && (state.focus === "accounts" || state.focus === "fallback")) {
      dispatch({ type: "cursor", delta: down });
    } else if (state.focus === "accounts" && input === " ") {
      dispatch({ type: "toggle" });
    } else if (state.focus === "fallback") {
      if (input === "a") setPicking(0);
      else if (input === "x") dispatch({ type: "fallback-remove" });
      else if (input === "[") dispatch({ type: "fallback-move", delta: -1 });
      else if (input === "]") dispatch({ type: "fallback-move", delta: 1 });
    }
  };
  // Answered with the state on screen, as the screen's own keys are.
  const handler = useRef(handle);
  useLayoutEffect(() => {
    handler.current = handle;
  });
  const onInput = useCallback((input: string, key: Key) => handler.current(input, key), []);
  useInput(onInput);

  /** Keys go to the form's question or picker, or nowhere while it saves, rather than to a field. */
  const typing = !asking && picking === null && !saving;
  const focusOn = (field: FormField) => state.focus === field;

  function textField(field: TextField, placeholder?: string) {
    const value = state[TEXT_KEYS[field]];
    const focus = focusOn(field) && typing;
    const onChange = (next: string, at: number) => {
      dispatch({ type: "text", field, value: next });
      setCaret({ field, at });
    };
    const cursor = caret?.field === field ? caret.at : value.length;
    if (keyShaped(field, value)) {
      // The input takes the keystrokes and draws nothing, so the value can still be erased.
      return (
        <Box>
          <Text color={color.text}>{MASK}</Text>
          <FieldInput value={value} cursor={cursor} focus={focus} showCursor={false} conceal onChange={onChange} />
        </Box>
      );
    }
    return (
      <FieldInput
        value={value}
        cursor={cursor}
        focus={focus}
        placeholder={placeholder}
        showCursor={focusOn(field)}
        onChange={onChange}
      />
    );
  }

  const line = (field: FormField, label: string) => ({
    focused: focusOn(field),
    label,
    error: state.errors[field] !== undefined,
  });
  const subLabel = (field: FormField, text: string, width: number) => (
    <SubLabel text={text} width={width} focused={focusOn(field)} error={state.errors[field] !== undefined} />
  );
  // A blank limit is the route's default, shown in its place.
  const limits = preview?.route ?? withDefaults({ tool: state.tool });

  return (
    <Chrome
      title="Routes"
      subtitle={original === undefined ? "New route" : `Edit ${original}`}
      footer={asking ? "Discard changes? (y/N)" : saving ? "Saving…" : undefined}
      hints={
        asking
          ? CONFIRM_HINTS
          : picking !== null
            ? PICKER_HINTS
            : [...(FIELD_HINTS[state.focus] ?? []), ...EVERY_FIELD_HINTS]
      }
    >
      <Box flexDirection="column" borderStyle="round" borderColor={color.dim} paddingX={1}>
        <Line {...line("name", "Name")}>{textField("name")}</Line>
        <Line {...line("tool", "Tool")}>
          <Radio
            options={ROUTE_TOOLS.map((tool) => [tool, toolLabel(tool)])}
            selected={state.tool}
            focused={focusOn("tool")}
          />
        </Line>
        <Line {...line("accounts", "Accounts")}>
          <AccountRows
            state={state}
            listed={listed}
            quotas={quotas}
            excluded={excluded}
            focused={focusOn("accounts")}
          />
        </Line>
        <Line {...line("from", "Patterns")}>
          {subLabel("from", "from", 9)}
          {textField("from")}
        </Line>
        <Line {...line("exclude", "")}>
          {subLabel("exclude", "exclude", 9)}
          {textField("exclude")}
        </Line>
        <Line {...line("strategy", "Strategy")}>
          <Radio
            options={STRATEGIES.map((strategy) => [strategy, strategy])}
            selected={state.strategy}
            focused={focusOn("strategy")}
          />
        </Line>
        <Line label="">
          <Text color={color.muted}>{STRATEGY_TEXT[state.strategy]}</Text>
        </Line>
        <Line {...line("max", "Limits")}>
          {subLabel("max", "skip at", 15)}
          <Text color={color.muted}>[</Text>
          {textField("max", String(limits.maxUsage))}
          <Text color={color.muted}>]%</Text>
        </Line>
        <Line {...line("reserve", "")}>
          {subLabel("reserve", "reserve up to", 15)}
          <Text color={color.muted}>[</Text>
          {textField("reserve", String(limits.reserveUsage))}
          <Text color={color.muted}>]%</Text>
        </Line>
        <Line {...line("fallback", "Fallback")}>
          <FallbackEntries entries={state.fallback} cursor={focusOn("fallback") ? state.cursor : null} />
        </Line>
        {picking !== null ? <FallbackPicker ids={candidates.map((account) => account.id)} cursor={picking} /> : null}
      </Box>
      <NowLine ranking={preview} />
      <ErrorLines errors={state.errors} />
    </Chrome>
  );
}
