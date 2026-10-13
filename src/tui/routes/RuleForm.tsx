import { Box, type Key, Text, useInput } from "ink";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { carriesCredentialToken } from "../../core/credential-token.js";
import type { RouteTool } from "../../core/route-config.js";
import {
  clearDefaultRoute,
  clearDirRoute,
  SLOT_TOOLS,
  type Slots,
  sameDir,
  setDefaultRoute,
  setDirRoute,
  storedDir,
} from "../../core/route-rules.js";
import type { ToolName } from "../../types.js";
import { Chrome } from "../components/Chrome.js";
import { FieldInput } from "../components/FieldInput.js";
import { color } from "../theme.js";
import { useTerminalSize } from "../use-width.js";
import { ErrorLines, Line, Radio, radioWindow, valueWidth } from "./RouteFormRows.js";
import { errorText, type RoutesListDeps } from "./routes-deps.js";

/**
 * The Routes screen's form for a dir rule (`n`, or `e` on one) or the defaults (`e` on their
 * row): the directory, and the route each tool's run takes there. It saves through updateRoutes,
 * as `clausona route dir` and `clausona route default` do.
 */

/** A new dir rule, a dir rule as stored, or the defaults. */
export type RuleTarget = { kind: "new" } | { kind: "dir"; dir: string } | { kind: "defaults" };

export type RuleFormProps = {
  target: RuleTarget;
  /** The rule's slots as read; none for a new rule. */
  slots: Slots;
  /** Every route there is that can be used, by name, with its tool. */
  routes: Array<{ name: string; tool: RouteTool }>;
  /** The routes routes.json holds that cannot be used, by name. */
  broken: string[];
  deps: RoutesListDeps;
  /** Whether the form saved. */
  onDone: (saved: boolean) => void;
};

type Field = "dir" | ToolName;

const NONE = "";
/** A slot routes.json holds that cannot be read: no route's name can be this. */
const UNREADABLE = "\u0000";

/** The columns the chrome's padding, and the frame's borders and padding, take from the terminal's width. */
const CHROME_PADDING = 4;
const FRAME_PADDING = 4;

const HINTS = [
  { keys: "tab", action: "next field" },
  { keys: "←→", action: "choose" },
  { keys: "enter", action: "save" },
  { keys: "esc", action: "cancel" },
];
const CONFIRM_HINTS = [
  { keys: "y", action: "discard" },
  { keys: "n/esc", action: "keep editing" },
];

/** What a directory holding something key-shaped shows instead, as the route form masks a key. */
const MASK = "•".repeat(8);

/** What a slot holds as the form starts: its route, none, or one that cannot be read. */
const heldIn = (slots: Slots, tool: ToolName) => {
  const slot = slots[tool];
  return slot === undefined ? NONE : "route" in slot ? slot.route : UNREADABLE;
};

/**
 * The routes a tool's slot can take: its own tool's, and the ones over both. A slot that holds
 * something else - a route gone, broken or for the other tool, or what cannot be read - keeps it
 * as one more choice, said as what it is, so that leaving the slot alone keeps it.
 */
function choicesFor(props: Pick<RuleFormProps, "routes" | "broken" | "slots">, tool: ToolName) {
  const { routes, broken, slots } = props;
  const options: Array<[string, string]> = [
    [NONE, "none"],
    ...routes
      .filter((route) => route.tool === tool || route.tool === "all")
      .map((route): [string, string] => [route.name, route.name]),
  ];
  const held = heldIn(slots, tool);
  if (options.some(([value]) => value === held)) return { options, odd: [] };
  const other = routes.find((route) => route.name === held);
  const label =
    held === UNREADABLE
      ? "? (cannot be read)"
      : other
        ? `${held} (for ${other.tool})`
        : broken.includes(held)
          ? `${held} (cannot be used)`
          : `${held} (missing)`;
  return { options: [...options, [held, label] as [string, string]], odd: [held] };
}

function step(options: Array<[string, string]>, current: string, delta: 1 | -1): string {
  const at = options.findIndex(([value]) => value === current);
  return options[(at + delta + options.length) % options.length]?.[0] ?? current;
}

export function RuleForm(props: RuleFormProps) {
  const { target, slots: initial, deps, onDone } = props;
  const fields: Field[] = target.kind === "defaults" ? ["claude", "codex"] : ["dir", "claude", "codex"];
  const [focus, setFocus] = useState<Field>(fields[0]);
  const [dirText, setDirText] = useState(target.kind === "dir" ? target.dir : "");
  const [caret, setCaret] = useState(dirText.length);
  const [slots, setSlots] = useState<Record<ToolName, string>>({
    claude: heldIn(initial, "claude"),
    codex: heldIn(initial, "codex"),
  });
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [saving, setSaving] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /** The slots the user changed: only those are written, and only those need their route to be there. */
  const changed = SLOT_TOOLS.filter((tool) => slots[tool] !== heldIn(initial, tool));
  const dirty = (target.kind === "dir" ? dirText !== target.dir : dirText !== "") || changed.length > 0;

  /**
   * Writes the rule into routes.json as it is under the lock, slot by slot as `clausona route dir`
   * does: a slot left alone stays as it is, and so does the other tool's slot of a rule the
   * directory already has. A new rule sets only the tools given a route. A rule moved to another
   * directory leaves the one it was for and is set there with the routes it has.
   */
  async function save() {
    const typed = dirText.trim();
    const problem =
      target.kind === "defaults"
        ? null
        : typed === ""
          ? "Type a directory, such as ~/work."
          : carriesCredentialToken(typed)
            ? "That looks like an API key, not a directory."
            : target.kind === "new" && SLOT_TOOLS.every((tool) => slots[tool] === NONE)
              ? "Choose a route for claude or codex."
              : null;
    if (problem) {
      setError(problem);
      return;
    }
    const dir = target.kind === "defaults" ? undefined : storedDir(typed, deps.cwd, deps.system);
    const isDir = (stored: string) => dir !== undefined && sameDir(stored, dir, deps.cwd, deps.system);
    const moved = target.kind === "dir" && !isDir(target.dir);
    if (!moved && changed.length === 0) {
      onDone(false);
      return;
    }
    setSaving(true);
    try {
      await deps.updateRoutes((file) => {
        for (const tool of changed) {
          const route = slots[tool];
          if (route !== NONE && !Object.hasOwn(file.routes, route)) {
            throw new Error(`Route ${route} was removed in another window.`);
          }
        }
        const set = (tool: ToolName) => {
          const route = slots[tool];
          if (dir === undefined) {
            if (route === NONE) clearDefaultRoute(file, [tool]);
            else setDefaultRoute(file, [tool], route);
          } else if (route === NONE) clearDirRoute(file, [tool], isDir);
          else setDirRoute(file, dir, [tool], route, isDir);
        };
        if (moved) {
          // A slot that cannot be read is not carried over: it leaves with the old directory.
          clearDirRoute(file, undefined, (stored) => stored === target.dir);
          for (const tool of SLOT_TOOLS) if (slots[tool] !== NONE && slots[tool] !== UNREADABLE) set(tool);
        } else {
          for (const tool of changed) set(tool);
        }
        return file;
      });
      // Keys stay off: the screen takes over.
      if (alive.current) onDone(true);
    } catch (failure) {
      if (!alive.current) return;
      setError(errorText(failure));
      setSaving(false);
    }
  }

  const handle = (input: string, key: Key) => {
    if (saving) return;
    // The question takes the next key, whatever it is: only y discards.
    if (asking) {
      setAsking(false);
      if (input === "y" || input === "Y") onDone(false);
      return;
    }
    if (key.escape) {
      if (dirty) setAsking(true);
      else onDone(false);
      return;
    }
    if (key.return) {
      void save();
      return;
    }
    if (key.tab) {
      const at = fields.indexOf(focus);
      setFocus(fields[(at + (key.shift ? -1 : 1) + fields.length) % fields.length]);
      return;
    }
    const across = key.leftArrow ? -1 : key.rightArrow ? 1 : 0;
    if (across && focus !== "dir") {
      const tool = focus;
      const { options } = choicesFor(props, tool);
      setSlots((current) => ({ ...current, [tool]: step(options, current[tool], across) }));
      setError(null);
    }
  };
  // Answered with the state on screen, as the screen's own keys are.
  const handler = useRef(handle);
  useLayoutEffect(() => {
    handler.current = handle;
  });
  const onInput = useCallback((input: string, key: Key) => handler.current(input, key), []);
  useInput(onInput);

  const typing = !asking && !saving;
  const { columns = 80 } = useTerminalSize();
  /** A Radio's line, which shows the routes around the chosen one rather than wrap: the form keeps its height. */
  const room = valueWidth(columns - CHROME_PADDING - FRAME_PADDING);
  const masked = carriesCredentialToken(dirText);
  const shown = target.kind === "defaults" ? "" : storedDir(dirText.trim() || ".", deps.cwd, deps.system);
  const explain =
    target.kind === "defaults"
      ? "Where no dir rule holds, clausona run claude or codex takes these. none: the active profile."
      : dirText.trim() === "" || masked
        ? "In this directory and below, clausona run claude or codex takes these."
        : `In ${shown} and below, clausona run claude or codex takes these.`;

  return (
    <Chrome
      title="Routes"
      subtitle={target.kind === "new" ? "New dir rule" : target.kind === "dir" ? `Edit ${target.dir}` : "Defaults"}
      question={asking ? "Discard changes? (y/N)" : undefined}
      footer={saving ? "Saving…" : undefined}
      hints={asking ? CONFIRM_HINTS : HINTS}
    >
      <Box flexDirection="column" borderStyle="round" borderColor={color.dim} paddingX={1}>
        {target.kind === "defaults" ? (
          <Line label="Directory">
            <Text color={color.muted}>default (where no dir rule holds)</Text>
          </Line>
        ) : (
          <Line focused={focus === "dir"} label="Directory">
            {masked ? <Text color={color.text}>{MASK}</Text> : null}
            <FieldInput
              value={dirText}
              cursor={caret}
              focus={focus === "dir" && typing}
              placeholder="~/work"
              showCursor={focus === "dir"}
              conceal={masked}
              onChange={(next, at) => {
                setDirText(next);
                setCaret(at);
                setError(null);
              }}
            />
          </Line>
        )}
        {SLOT_TOOLS.map((tool) => {
          const { options, odd } = choicesFor(props, tool);
          const { shown, before, after } = radioWindow(options, slots[tool], room);
          return (
            <Line key={tool} focused={focus === tool} label={tool === "claude" ? "Claude" : "Codex"}>
              {before ? <Text color={color.muted}>… </Text> : null}
              <Radio options={shown} selected={slots[tool]} focused={focus === tool} warn={odd} />
              {after ? <Text color={color.muted}> …</Text> : null}
            </Line>
          );
        })}
      </Box>
      <Text color={color.muted}>{explain}</Text>
      <ErrorLines errors={error ? { form: error } : {}} />
    </Chrome>
  );
}
