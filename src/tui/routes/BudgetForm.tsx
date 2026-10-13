import { Box, type Key, Text, useInput } from "ink";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  BUDGET_PERIODS,
  type Budget,
  type BudgetPeriod,
  isBudgetUsd,
  setBudget,
  usdText,
} from "../../core/route-budgets.js";
import { Chrome } from "../components/Chrome.js";
import { FieldInput } from "../components/FieldInput.js";
import { color } from "../theme.js";
import { ErrorLines, Line, Radio } from "./RouteFormRows.js";
import { errorText, type RoutesScreenDeps } from "./routes-deps.js";

/**
 * The Routes screen's budget editor (`e` on an API profile in its budgets view): what the profile
 * may spend in a day, a week or a month before routes stop taking it. It saves through
 * updateRoutes, as `clausona route budget <profile> --usd <n> --per <period>` does; `d` on the
 * list clears one.
 */

export type BudgetFormProps = {
  /** The API profile's id. */
  id: string;
  /** Its budget as routes.json holds it; none for one without. */
  budget?: Budget;
  deps: Pick<RoutesScreenDeps, "updateRoutes">;
  /** Whether the form saved. */
  onDone: (saved: boolean) => void;
};

type Field = "usd" | "per";

const FIELDS: readonly Field[] = ["usd", "per"];

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

const PERIOD_OPTIONS = BUDGET_PERIODS.map((per): [BudgetPeriod, string] => [per, per]);

const PERIOD_WORDS: Record<BudgetPeriod, string> = { day: "a UTC day", week: "a week from Monday", month: "a month" };

/** Dollars as the field shows them: as stored, so `12.5` reads back as typed. */
const usdField = (budget: Budget | undefined) => (budget ? String(budget.usd) : "");

export function BudgetForm({ id, budget, deps, onDone }: BudgetFormProps) {
  const [focus, setFocus] = useState<Field>("usd");
  const [amount, setAmount] = useState(usdField(budget));
  const [caret, setCaret] = useState(amount.length);
  const [per, setPer] = useState<BudgetPeriod>(budget?.per ?? "month");
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

  const dirty = amount !== usdField(budget) || per !== (budget?.per ?? "month");

  async function save() {
    const usd = Number(amount.trim());
    if (amount.trim() === "" || !isBudgetUsd(usd)) {
      setError("Type a number of dollars above 0, such as 20 or 12.50.");
      return;
    }
    if (!dirty) {
      onDone(false);
      return;
    }
    setSaving(true);
    try {
      await deps.updateRoutes((file) => {
        setBudget(file, id, { usd, per });
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
      const at = FIELDS.indexOf(focus);
      setFocus(FIELDS[(at + (key.shift ? -1 : 1) + FIELDS.length) % FIELDS.length]);
      return;
    }
    const across = key.leftArrow ? -1 : key.rightArrow ? 1 : 0;
    if (across && focus === "per") {
      const at = BUDGET_PERIODS.indexOf(per);
      setPer(BUDGET_PERIODS[(at + across + BUDGET_PERIODS.length) % BUDGET_PERIODS.length]);
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
  const typed = Number(amount.trim());
  // A route skips the profile at its limit, as it skips an account at its plan's: by this share.
  const explain = `Its usage is its spend in ${PERIOD_WORDS[per]} as a share of ${
    amount.trim() !== "" && isBudgetUsd(typed) ? usdText(typed) : "the budget"
  }.`;

  return (
    <Chrome
      title="Routes"
      subtitle={`Budget for ${id}`}
      question={asking ? "Discard changes? (y/N)" : undefined}
      footer={saving ? "Saving…" : undefined}
      hints={asking ? CONFIRM_HINTS : HINTS}
    >
      <Box flexDirection="column" borderStyle="round" borderColor={color.dim} paddingX={1}>
        <Line focused={focus === "usd"} label="Budget">
          <Box flexShrink={0}>
            <Text color={color.muted}>$</Text>
          </Box>
          <FieldInput
            value={amount}
            cursor={caret}
            focus={focus === "usd" && typing}
            placeholder="20"
            showCursor={focus === "usd"}
            onChange={(next, at) => {
              setAmount(next);
              setCaret(at);
              setError(null);
            }}
          />
        </Line>
        <Line focused={focus === "per"} label="Per">
          <Radio options={PERIOD_OPTIONS} selected={per} focused={focus === "per"} />
        </Line>
      </Box>
      <Text color={color.muted}>{explain}</Text>
      <Text color={color.muted}>It replaces the limit on the provider key; spend is read from the provider.</Text>
      <ErrorLines errors={error ? { form: error } : {}} />
    </Chrome>
  );
}
