import { Box, Text } from "ink";
import type { PropsWithChildren } from "react";

import { type Ranking, usageOf } from "../../core/routing.js";
import { freeNow, nothingRead, skipReason } from "../../lib/route-render.js";
import type { QuotaSnapshot } from "../../types.js";
import { QuotaCell } from "../components/QuotaCell.js";
import { color, symbol } from "../theme.js";
import { GAP, MARK } from "./RouteDetail.js";
import { FORM_FIELDS, type FormAccount, type FormField, type RouteFormState } from "./route-form-state.js";

/**
 * The route form's lines (RouteForm.tsx), drawn from what they are given: no state, no keys.
 *
 * Every field has a line of its own with the focus mark (`✦`) at its start, so where the focus
 * is reads in the text itself, not only in its colour; a list marks its row with `▸`.
 */

const CURSOR = 2;
const LABEL = 11;
/** A quota cell's percentage, as the spec's form shows it: no gauge, no reset. */
const QUOTA = 4;

/** How an error names its field below the box. */
const FIELD_LABEL: Record<FormField, string> = {
  name: "Name",
  tool: "Tool",
  accounts: "Accounts",
  from: "From",
  exclude: "Exclude",
  strategy: "Strategy",
  max: "Skip at",
  reserve: "Reserve up to",
  fallback: "Fallback",
};

const labelColor = (focused: boolean, error: boolean) => (error ? color.error : focused ? color.text : color.secondary);

/** One line of the form: the focus mark, the field's label, and what it holds. */
export function Line({
  focused = false,
  label,
  error = false,
  children,
}: PropsWithChildren<{ focused?: boolean; label: string; error?: boolean }>) {
  return (
    <Box flexDirection="row">
      <Box width={CURSOR} flexShrink={0}>
        <Text color={color.cursor}>{focused ? symbol.cursor : " "}</Text>
      </Box>
      <Box width={LABEL} flexShrink={0}>
        <Text color={labelColor(focused, error)} bold={focused}>
          {label}
        </Text>
      </Box>
      <Box flexDirection="row" flexGrow={1} flexShrink={1} minWidth={0}>
        {children}
      </Box>
    </Box>
  );
}

/** The name of one of the two fields under a label: `from` and `exclude`, `skip at` and `reserve up to`. */
export function SubLabel({
  text,
  width,
  focused,
  error,
}: {
  text: string;
  width: number;
  focused: boolean;
  error: boolean;
}) {
  return (
    <Box width={width} flexShrink={0}>
      <Text color={error ? color.error : focused ? color.text : color.muted}>{text}</Text>
    </Box>
  );
}

export function Radio<T extends string>({
  options,
  selected,
  focused,
}: {
  options: Array<[T, string]>;
  selected: T;
  focused: boolean;
}) {
  return (
    <Box columnGap={3} flexWrap="wrap">
      {options.map(([value, label]) => {
        const on = value === selected;
        return (
          <Box key={value} flexShrink={0}>
            <Text color={on ? (focused ? color.cursor : color.text) : color.muted} bold={on && focused}>
              {`${on ? symbol.dot : symbol.circle} ${label}`}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

/**
 * Why an account has no quota to show, in the Routes screen's words: signed out or its sign-in
 * expired. Not a missing reading, which an account read as the form opens has for a moment.
 */
function noQuotaReason(id: string, snapshot: QuotaSnapshot | undefined, now: number): string {
  const { skip } = usageOf(snapshot, now);
  return skip === "signed-out" || skip === "expired" ? skipReason({ id, skip }) : "";
}

/**
 * Row 0, every account, then one row per account with its quota; out of the route reads
 * `excluded`, and an account with no quota says why.
 */
export function AccountRows({
  state,
  listed,
  quotas,
  excluded,
  focused,
  now,
}: {
  state: RouteFormState;
  listed: FormAccount[];
  quotas: Record<string, QuotaSnapshot>;
  excluded: ReadonlySet<string>;
  focused: boolean;
  now: number;
}) {
  const idWidth = Math.max(0, ...listed.map((account) => account.id.length));
  const mark = (row: number) => (
    <Box width={MARK} flexShrink={0}>
      <Text color={color.cursor}>{focused && state.cursor === row ? "▸" : " "}</Text>
    </Box>
  );
  return (
    <Box flexDirection="column" flexGrow={1} minWidth={0}>
      <Box flexDirection="row">
        {mark(0)}
        <Text color={color.text} wrap="truncate-end">
          {`[${state.every ? "x" : " "}] every account (*), new ones join`}
        </Text>
      </Box>
      {listed.map((account, index) => {
        const out = excluded.has(account.id);
        const ticked = state.ticked.includes(account.id) && !out;
        const snapshot = quotas[account.id];
        const live = snapshot?.state === "ok";
        const note = out ? "excluded" : noQuotaReason(account.id, snapshot, now);
        return (
          <Box key={account.id} flexDirection="row" paddingLeft={2}>
            {mark(index + 1)}
            <Box width={4 + idWidth} flexShrink={1} minWidth={0}>
              <Text color={out ? color.muted : color.text} wrap="truncate-end">
                {`[${ticked ? "x" : " "}] ${account.id}`}
              </Text>
            </Box>
            {/* Right-aligned: a percentage comes padded to the width, a dash does not. */}
            <Box marginLeft={GAP} width={QUOTA} flexShrink={0} justifyContent="flex-end">
              <QuotaCell window={snapshot?.session} live={live} width={QUOTA} />
            </Box>
            <Box marginLeft={GAP} width={QUOTA} flexShrink={0} justifyContent="flex-end">
              <QuotaCell window={snapshot?.weekly} live={live} width={QUOTA} />
            </Box>
            {note ? (
              <Box marginLeft={GAP} flexShrink={0}>
                <Text color={color.muted}>{note}</Text>
              </Box>
            ) : null}
          </Box>
        );
      })}
    </Box>
  );
}

/**
 * `1. <id>  2. <id>  (+ add)`, the entry at `cursor` marked while the field has the focus. An
 * entry the pool takes already (one written with the CLI) says so: it adds nothing.
 */
export function FallbackEntries({
  entries,
  cursor,
  pool,
}: {
  entries: string[];
  cursor: number | null;
  pool: ReadonlySet<string>;
}) {
  return (
    <Box columnGap={2} flexWrap="wrap">
      {entries.map((entry, index) => (
        <Box key={entry} flexShrink={0}>
          <Text color={index === cursor ? color.cursor : color.text}>
            {`${index === cursor ? "▸" : " "}${index + 1}. ${entry}`}
            {pool.has(entry) ? <Text color={color.muted}> in the pool</Text> : null}
          </Text>
        </Box>
      ))}
      <Box flexShrink={0}>
        {/* After the slot an entry's mark sits in, so the gaps match. */}
        <Text color={color.muted}> (+ add)</Text>
      </Box>
    </Box>
  );
}

/** Why the picker has nothing to offer: no accounts, none outside the pool, or those all added. */
export type NothingToAdd = "accounts" | "outside" | "left";

/**
 * The pool already takes every account it does not exclude, so a fallback could add none: said
 * on the picker's line, from the labels' column, so that it fits 80 columns in the form's frame.
 */
const POOL_TAKES_ALL = "The pool takes every account; untick every account (*) or narrow it.";

/**
 * The accounts that can still join the fallback, one at a time on a line under it, with `‹` and
 * `›` where there are more. A list of them all ran the form off a 34-row terminal once a
 * claude + codex route offered eight; one line fits whatever the number of accounts. `none` says
 * why there is nothing to offer, when there is not.
 */
export function FallbackPicker({ ids, cursor, none }: { ids: string[]; cursor: number; none: NothingToAdd }) {
  const id = ids[cursor];
  if (id === undefined && none === "outside") {
    return (
      <Box flexDirection="row" paddingLeft={CURSOR}>
        <Box flexShrink={1} minWidth={1}>
          <Text color={color.muted} wrap="truncate-end">
            {POOL_TAKES_ALL}
          </Text>
        </Box>
      </Box>
    );
  }
  return (
    <Box flexDirection="row" paddingLeft={CURSOR + LABEL} columnGap={2}>
      <Box flexShrink={0}>
        <Text color={color.secondary}>Add to fallback</Text>
      </Box>
      {id === undefined ? (
        <Text color={color.muted}>
          {none === "accounts" ? "there are no accounts to add" : "every account outside the pool is in it"}
        </Text>
      ) : (
        <>
          <Box flexShrink={1}>
            <Text wrap="truncate-end">
              <Text color={color.muted}>{cursor > 0 ? "‹ " : "  "}</Text>
              <Text color={color.cursor}>{id}</Text>
              <Text color={color.muted}>{cursor < ids.length - 1 ? " ›" : "  "}</Text>
            </Text>
          </Box>
          <Box flexShrink={0}>
            <Text color={color.muted}>{`${cursor + 1} of ${ids.length}`}</Text>
          </Box>
        </>
      )}
    </Box>
  );
}

/**
 * Who the route would pick now, from the quota already read: what `clausona route explain` would
 * say. Nothing read (offline) is said as such, as `route list` and the Routes screen say it.
 */
export function NowLine({ ranking }: { ranking: Ranking | null }) {
  if (!ranking) return <Text color={color.muted}>Now: —</Text>;
  const { outcome } = ranking;
  if (outcome.kind !== "picked" && nothingRead(ranking.rows)) {
    return <Text color={color.muted}>Now: no quota reading</Text>;
  }
  if (outcome.kind !== "picked") return <Text color={color.warning}>Now: nobody can be picked</Text>;
  const { free, members } = freeNow(ranking);
  return (
    <Text color={color.text}>
      {`Now: ${free} of ${members} accounts under ${ranking.route.maxUsage}% · next `}
      <Text color={color.accent}>{outcome.id}</Text>
    </Text>
  );
}

/** The form's own problem, then each field's, named by its field. */
export function ErrorLines({ errors }: { errors: RouteFormState["errors"] }) {
  const messages = [
    ...(errors.form ? [errors.form] : []),
    ...FORM_FIELDS.flatMap((field) => {
      const message = errors[field];
      return message ? [`${FIELD_LABEL[field]}: ${message}`] : [];
    }),
  ];
  return (
    <>
      {messages.map((message) => (
        <Box key={message} gap={1}>
          <Box flexShrink={0}>
            <Text color={color.error}>{symbol.cross}</Text>
          </Box>
          <Text color={color.error}>{message}</Text>
        </Box>
      ))}
    </>
  );
}
