import { Box, type Key, Text, useInput } from "ink";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  holdsKey,
  ROUTE_TOOLS,
  type RouteSpec,
  STRATEGIES,
  type Strategy,
  storedRoute,
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
import { useTerminalSize } from "../use-width.js";
import {
  AccountRows,
  ErrorLines,
  errorLineCount,
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
 * updateRoutes - never over a change another window made to the route it edits.
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

/**
 * The form's lines besides its accounts, when nothing wraps: the chrome's header (5 with its
 * padding) and footer (5), the frame's borders and its other fields' lines (11, the strategy's
 * and the limits' descriptions among them), the every-account row, the Now line, and one more,
 * since ink redraws the whole screen once its output is as tall as the terminal. A question, the
 * saving note, the picker and each error take one or more besides.
 */
const FORM_LINES = 24;

/** The fewest account lines the form shows, however short the terminal. */
const MIN_ACCOUNT_LINES = 3;

/** What a field holding something key-shaped shows instead: a constant, as the API form's key field. */
const MASK = "•".repeat(8);

const changedText = (name: string) =>
  `Route ${name} was changed in another window; it was reloaded. Review and save again.`;
const removedText = (name: string) => `Route ${name} was removed in another window.`;

/** The name never changes the spec, so the preview runs on a stand-in until one is typed, or while it is refused. */
const PREVIEW_NAME = "preview";

/**
 * What a pattern field does, with an example: drawn where its text goes as long as it is empty, so
 * the form says what goes in it before it is reached. While it has the focus, its first character
 * is the cursor, as the limit's default is, so focusing it moves nothing.
 */
const PATTERN_PLACEHOLDER = {
  from: "adds matches, e.g. *@work.example, team-*",
  exclude: "leaves matches out, e.g. *-share, old",
} as const;

const STRATEGY_TEXT: Record<Strategy, string> = {
  "round-robin": "takes accounts in turn",
  headroom: "picks the account with the most room",
  expiring: "uses weekly limits that reset within 24h first",
};

/**
 * What the limit does, in its number, as routing's decide() takes it: an account under the cut
 * (by the strategy, then the fallback), and when there is none, the one with the most left.
 */
const limitsText = (max: number, strategy: Strategy) =>
  `under ${max}% ${strategy === "round-robin" ? "in turn" : "first"}; if none, the one with the most left`;

/** A limit as typed, when it is a number; a blank one is left to its default. */
function typedLimit(text: string): number | undefined {
  const trimmed = text.trim();
  return trimmed === "" || !Number.isFinite(Number(trimmed)) ? undefined : Number(trimmed);
}

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
/** Once the form said its route was removed in another window: enter writes it back. */
const RECREATE_HINTS: Hint[] = [
  { keys: "tab", action: "next field" },
  { keys: "enter", action: "save it again" },
  { keys: "esc", action: "cancel" },
];
const PICKER_HINTS = [
  { keys: "←→", action: "choose" },
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

/** Two specs as routes.json writes them; key order counts, which can only call a match a change. */
const sameSpec = (a: RouteSpec | undefined, b: RouteSpec | undefined) => JSON.stringify(a) === JSON.stringify(b);

type Outcome = "saved" | "changed" | "removed" | Errors;

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
  /**
   * The edited route was removed in another window, and the form said so: the next save writes it
   * again, which the user asks for by pressing enter once more.
   */
  const [recreate, setRecreate] = useState(false);
  /** The route the edit started from: under the lock it must still be the one on disk. */
  const startSpec = useRef(props.spec);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const listed = useMemo(() => accountsFor(state.tool, accounts), [state.tool, accounts]);
  const members = useMemo(() => new Map(membersOf(registry, "all").map((member) => [member.id, member])), [registry]);
  const preview = useMemo((): Ranking | null => {
    const { spec } = formToSpec({ ...state, name: PREVIEW_NAME }, accounts);
    if (!spec) return null;
    const route = withDefaults(spec);
    return rankRoute({ route, members: membersOf(registry, route.tool), quotas, lastPicked, now, resume: false });
  }, [state, accounts, registry, quotas, lastPicked, now]);

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

  /**
   * The pool's accounts, as the preview ranks them; while the form holds a problem there is no
   * preview, and the ticks say it.
   */
  const pool = useMemo(
    () =>
      new Set(
        preview
          ? preview.rows.filter((row) => row.role === "pool").map((row) => row.id)
          : state.every
            ? listed.map((account) => account.id)
            : state.ticked,
      ),
    [preview, listed, state.every, state.ticked],
  );
  /**
   * What a fallback entry can add: an account outside the pool, which ranking already tries
   * first, and outside the excludes, which leave a fallback account out as well.
   */
  const outside = listed.filter((account) => !pool.has(account.id) && !excluded.has(account.id));
  const candidates = outside.filter((account) => !state.fallback.includes(account.id));

  const dispatch = (action: FormAction) => setState((current) => reduceForm(current, action, accounts));
  const showErrors = (errors: Errors) => setState((current) => ({ ...current, errors }));

  /**
   * Writes the route into routes.json as it is under the lock: what another window changed in
   * the other routes stays, and the inputs are saved over it. The edited route itself is checked
   * there, against the one the edit started from (the screen's earlier read): one changed
   * meanwhile is not written over, and one removed meanwhile is written again only once the
   * user, told so, saves again.
   */
  async function write(name: string, spec: RouteSpec): Promise<Outcome> {
    let outcome: Outcome = "saved";
    await deps.updateRoutes((file) => {
      if (original !== undefined) {
        const onDisk = storedRoute(file, original);
        if (onDisk === undefined ? !recreate : !sameSpec(onDisk, startSpec.current)) {
          outcome = onDisk === undefined ? "removed" : "changed";
          return null;
        }
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

  /** Starts the edit again from its route as it is on disk now, which another window changed. */
  async function reload(name: string) {
    const fresh = storedRoute(await deps.readRoutes(), name);
    startSpec.current = fresh;
    if (!alive.current) return;
    if (fresh) {
      setState((current) => ({
        ...initialFormState({ mode: "edit", name, spec: fresh }, accounts),
        focus: current.focus,
        errors: { form: changedText(name) },
      }));
    } else removed(name);
  }

  /** The inputs stay, and nothing is written until enter is pressed again. */
  function removed(name: string) {
    setRecreate(true);
    showErrors({ form: removedText(name) });
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
      if (outcome === "changed" && original !== undefined) await reload(original);
      else if (outcome === "removed" && original !== undefined) removed(original);
      else if (typeof outcome === "object") showErrors(outcome);
    } catch (error) {
      if (alive.current) showErrors({ form: errorText(error) });
    }
    if (alive.current) setSaving(false);
  }

  /** The picker is one line: ←→ step through it, and ↑↓ as well, as they did when it was a list. */
  function pick(key: Key) {
    if (key.escape) setPicking(null);
    else if (key.leftArrow || key.upArrow) setPicking((row) => Math.max(0, (row ?? 0) - 1));
    else if (key.rightArrow || key.downArrow) {
      setPicking((row) => Math.max(0, Math.min(candidates.length - 1, (row ?? 0) + 1)));
    } else if (key.return) {
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

  const { columns = 80, rows } = useTerminalSize();
  /** Lines in the frame and under it that come and go; the errors as they wrap inside the chrome. */
  const extra = (asking || saving ? 1 : 0) + (picking !== null ? 1 : 0) + errorLineCount(state.errors, columns - 4);
  const accountLines = rows === undefined ? undefined : Math.max(MIN_ACCOUNT_LINES, rows - FORM_LINES - extra);
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
    if (value === "" && (field === "from" || field === "exclude")) {
      // The input takes the keys and draws nothing; the example is drawn here, its first character
      // the cursor while focused, where the first one typed goes. It takes the room it is given
      // rather than shrink to fit, which ran it a column past the frame in a narrow terminal.
      const example = PATTERN_PLACEHOLDER[field];
      return (
        <>
          <FieldInput
            value={value}
            cursor={cursor}
            focus={focus}
            showCursor={focusOn(field)}
            conceal
            onChange={onChange}
          />
          <Box flexGrow={1} flexBasis={0} minWidth={1}>
            <Text wrap="truncate-end">
              <Text color={focus ? undefined : color.muted} inverse={focus}>
                {example.slice(0, 1)}
              </Text>
              <Text color={color.muted}>{example.slice(1)}</Text>
            </Text>
          </Box>
        </>
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
  // The limit as typed, a blank one the route's default, shown in its place: what the save takes,
  // and not the preview's, which a problem in another field leaves out.
  const limits = withDefaults({ tool: state.tool, maxUsage: typedLimit(state.maxText) });

  return (
    <Chrome
      title="Routes"
      subtitle={original === undefined ? "New route" : `Edit ${original}`}
      question={asking ? "Discard changes? (y/N)" : undefined}
      footer={saving ? "Saving…" : undefined}
      hints={
        asking
          ? CONFIRM_HINTS
          : picking !== null
            ? PICKER_HINTS
            : [...(FIELD_HINTS[state.focus] ?? []), ...(recreate ? RECREATE_HINTS : EVERY_FIELD_HINTS)]
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
        <Line {...line("accounts", "Accounts")} rowMark={focusOn("accounts") && state.cursor === 0}>
          <AccountRows
            state={state}
            listed={listed}
            quotas={quotas}
            excluded={excluded}
            focused={focusOn("accounts")}
            now={now}
            lines={accountLines}
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
          {subLabel("max", "skip at", 9)}
          <Text color={color.muted}>[</Text>
          {textField("max", String(limits.maxUsage))}
          <Text color={color.muted}>]%</Text>
        </Line>
        <Line label="">
          <Text color={color.muted}>{limitsText(limits.maxUsage, state.strategy)}</Text>
        </Line>
        <Line
          {...line("fallback", "Fallback")}
          rowMark={focusOn("fallback") && state.fallback.length > 0 && state.cursor === 0}
        >
          <FallbackEntries entries={state.fallback} cursor={focusOn("fallback") ? state.cursor : null} pool={pool} />
        </Line>
        {picking !== null ? (
          <FallbackPicker
            ids={candidates.map((account) => account.id)}
            cursor={picking}
            none={listed.length === 0 ? "accounts" : outside.length === 0 ? "outside" : "left"}
          />
        ) : null}
      </Box>
      <NowLine ranking={preview} />
      <ErrorLines errors={state.errors} />
    </Chrome>
  );
}
