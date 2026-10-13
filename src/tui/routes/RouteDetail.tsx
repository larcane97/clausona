import { Box, Text } from "ink";

import type { Route } from "../../core/route-config.js";
import { isUnread, type Ranking, type Row, scopedWindowKind, scopedWindowName } from "../../core/routing.js";
import { fitQuotaValue } from "../../lib/format.js";
import {
  detailOrder,
  modelHeader,
  modelWord,
  overLimitText,
  skipReason,
  spendText,
  toolLabel,
} from "../../lib/route-render.js";
import type { QuotaWindow, ToolName } from "../../types.js";
import { QuotaCell } from "../components/QuotaCell.js";
import { color } from "../theme.js";
import { useWidth } from "../use-width.js";

/**
 * The Routes screen's detail pane: the selected route's settings, and its members ranked as
 * `csn route explain` ranks them, with their quota and status. Ranked as a run of a model would
 * be, it shows each member's limit on that model too, as `csn route explain --model` does.
 */

/**
 * A route as the screen lists it: its name, the route with its defaults, and its ranking.
 * `onlyTool` is the tool an `all` route is ranked for, as a run naming it would be.
 */
export type Entry = { name: string; route: Route; ranking: Ranking; onlyTool?: ToolName };

/** A row's mark (`▸`) and the space after it. */
export const MARK = 2;
export const GAP = 2;
/** The widths a quota cell is tried at, widest first: gauge and reset, percentage and reset, percentage. */
const QUOTA_WIDTHS = [19, 8, 4];

/** A muted label and its value, the label column 10 wide. */
export function Setting({ label, value }: { label: string; value: string }) {
  return (
    <Box flexDirection="row">
      <Box width={10} flexShrink={0}>
        <Text color={color.muted}>{label}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1} minWidth={0}>
        <Text color={color.text}>{value}</Text>
      </Box>
    </Box>
  );
}

/**
 * `models` are the names of the limits the route's accounts report on one model (`Opus`), which `m`
 * ranks by in turn. Until one is chosen, a line under the table names them.
 */
export function RouteDetail({ entry, pending, models }: { entry: Entry; pending: boolean; models: string[] }) {
  const { name, route, ranking, onlyTool } = entry;
  const [detail, width] = useWidth();
  return (
    <Box ref={detail} flexDirection="column">
      <Text color={color.text} bold wrap="truncate-end">
        {name}
      </Text>
      <Text color={color.muted}>{`${toolLabel(route.tool)} · ${route.strategy} · skip at ${route.maxUsage}%`}</Text>
      <Setting
        label="Accounts"
        value={`${route.from.join(", ")}${route.exclude.length ? ` except ${route.exclude.join(", ")}` : ""}`}
      />
      <Setting label="Fallback" value={route.fallback.length ? route.fallback.join(", ") : "none"} />
      {/* The options that rank the same on the command line. */}
      {ranking.model ? (
        <Setting
          label="Model"
          value={`ranked as ${onlyTool ? `--tool ${onlyTool} ` : ""}--model ${modelWord(ranking.model)}`}
        />
      ) : null}
      <MemberTable ranking={ranking} pending={pending} width={width} />
      {ranking.model || models.length === 0 ? null : <ModelLimits models={models} />}
    </Box>
  );
}

/** The models the accounts have a limit on, and the key that ranks by one: the names are cut before the key is. */
function ModelLimits({ models }: { models: string[] }) {
  return (
    <Box flexDirection="row" marginTop={1}>
      <Box flexShrink={1} minWidth={0}>
        <Text color={color.muted} wrap="truncate-end">{`Model limits: ${models.join(", ")}`}</Text>
      </Box>
      <Box flexShrink={0}>
        <Text color={color.muted}> · m to rank by one</Text>
      </Box>
    </Box>
  );
}

/**
 * A member table line: a ranked row with its quota cells, or a name whose status runs across them.
 * `spend` is an API profile's, after its status: cut to the line rather than given room of its own.
 */
type Line = {
  key: string;
  id: string;
  picked: boolean;
  fallback: boolean;
  row?: Row;
  status: string;
  spend?: string;
  tone: string;
};

function statusOf(row: Row, ranking: Ranking): string {
  const { outcome, route } = ranking;
  if (row.status === "picked")
    return outcome.kind === "picked" && outcome.stage === "overflow" ? "next (most room left)" : "next";
  if (row.status === "over-limit") return overLimitText(row, route);
  return "";
}

function lineOf(row: Row, ranking: Ranking, pending: boolean): Line {
  const base = { key: `row:${row.id}`, id: row.id, picked: row.status === "picked", fallback: row.role === "fallback" };
  // Before the quota is read every member reads as unread; those are the ones still loading.
  if (pending && isUnread(row.skip)) return { ...base, status: "loading…", tone: color.muted };
  if (row.skip) return { ...base, status: skipReason(row), tone: color.muted };
  const status = statusOf(row, ranking);
  return {
    ...base,
    row,
    status,
    // An API profile's spend, and whose limit counts it, as `csn route explain` says them.
    ...(row.budget ? { spend: spendText(row.budget) } : {}),
    tone: base.picked ? color.accent : color.warning,
  };
}

/** The widest a column of cells is at `width`: fitQuotaValue drops what does not fit. */
function quotaColumn(windows: QuotaWindow[], width: number, cut: number): number {
  return Math.max(2, ...windows.map((window) => fitQuotaValue(window, width, new Date(), cut).length));
}

/** Text after a gap that takes the rest of the line, cut rather than wrapped; `after` follows it, muted. */
function Rest({ text, tone, after }: { text: string; tone: string; after?: string }) {
  return (
    <Box marginLeft={GAP} flexGrow={1} flexShrink={1} minWidth={0}>
      <Text color={tone} wrap="truncate-end">
        {text}
        {after ? <Text color={color.secondary}>{`${text ? " · " : ""}${after}`}</Text> : null}
      </Text>
    </Box>
  );
}

/** A Codex limit's window, `5H` or `7D`, and the space after it. */
const KIND = 3;

/** The model column, when the table has one: its width, and whether its cells start with a window's kind. */
type ModelColumn = { width: number; kinds: boolean };

function MemberLine({
  line,
  idWidth,
  quota,
  cut,
  model,
  budget,
}: {
  line: Line;
  idWidth: number;
  quota: number;
  cut: number;
  model?: ModelColumn;
  /** The budget column's width, when the table has one: an API profile's spend against its limit. */
  budget?: number;
}) {
  const { row } = line;
  const scoped = row?.scoped;
  // The window that sets the member's usage is bold, as in `csn route explain`.
  const cell = (window: QuotaWindow | undefined, which: "5H" | "7D" | "budget") => (
    <Box marginLeft={GAP} width={which === "budget" ? budget : quota} flexShrink={0}>
      <QuotaCell
        window={window}
        live={!row?.usage?.stale}
        width={which === "budget" ? (budget ?? quota) : quota}
        bold={row?.usage?.window === which}
        cut={cut}
      />
    </Box>
  );
  return (
    <Box flexDirection="row">
      <Box width={MARK} flexShrink={0}>
        <Text color={color.accent}>{line.picked ? "▸" : " "}</Text>
      </Box>
      <Box width={idWidth} flexShrink={0}>
        <Text color={line.picked ? color.accent : color.text} wrap="truncate-end">
          {line.id}
          {line.fallback ? <Text color={color.muted}> (fallback)</Text> : null}
        </Text>
      </Box>
      {row ? cell(row.fiveHour, "5H") : null}
      {row ? cell(row.sevenDay, "7D") : null}
      {row && model ? (
        <Box marginLeft={GAP} width={model.width} flexShrink={0}>
          {/* Which of a Codex limit's windows is the higher, as explain says it: `7D`. */}
          {model.kinds ? (
            <Box width={KIND} flexShrink={0}>
              <Text color={color.muted}>{scoped ? (scopedWindowKind(scoped) ?? "") : ""}</Text>
            </Box>
          ) : null}
          <QuotaCell
            window={scoped}
            live={!row.usage?.stale}
            width={quota}
            bold={scoped !== undefined && row.usage?.window === scopedWindowName(scoped)}
            cut={cut}
          />
        </Box>
      ) : null}
      {row && budget !== undefined ? cell(row.budget, "budget") : null}
      {line.status || line.spend ? <Rest text={line.status} tone={line.tone} after={line.spend} /> : null}
    </Box>
  );
}

const FALLBACK_TAG = " (fallback)".length;
const BUDGET = "BUDGET";

function MemberTable({ ranking, pending, width }: { ranking: Ranking; pending: boolean; width: number }) {
  const members = detailOrder(ranking.rows.filter((row) => row.skip !== "not-registered"));
  const unknown = ranking.rows.filter((row) => row.skip === "not-registered");
  const lines: Line[] = [
    ...[...members, ...unknown].map((row) => lineOf(row, ranking, pending)),
    ...[...new Set(ranking.emptyPatterns)].map(
      (pattern): Line => ({
        key: `pattern:${pattern}`,
        id: pattern,
        picked: false,
        fallback: false,
        status: "matches nobody",
        tone: color.muted,
      }),
    ),
    ...ranking.emptyExcludes.map(
      (pattern): Line => ({
        key: `exclude:${pattern}`,
        id: pattern,
        picked: false,
        fallback: false,
        status: "excludes nobody",
        tone: color.muted,
      }),
    ),
  ];
  const ranked = lines.flatMap(({ row }) => (row ? [row] : []));
  const windows = ranked.flatMap((row) =>
    [row.fiveHour, row.sevenDay, row.scoped, row.budget].filter(
      (window): window is QuotaWindow => window !== undefined,
    ),
  );
  const hasBudget = lines.some(({ row }) => row?.budget !== undefined);
  // The limit on the model the route is ranked as, named as explain names it; none when no
  // account reports one.
  const header = modelHeader(ranked);
  const kinds = ranked.some((row) => row.scoped && scopedWindowKind(row.scoped));
  /** The model column is as wide as its header, `whole`, or else as its cells, with the header cut to them. */
  const modelOf = (quota: number, whole: boolean) =>
    Math.max(quota + (kinds ? KIND : 0), whole && header ? header.length : 0);
  const status = Math.max(0, ...lines.filter((line) => line.row).map((line) => line.status.length));
  const longest = Math.max(
    "ACCOUNT".length,
    ...lines.map((line) => line.id.length + (line.fallback ? FALLBACK_TAG : 0)),
  );
  /** The budget column is as wide as its header at least. */
  const budgetOf = (quota: number) => Math.max(quota, BUDGET.length);
  /** A line's width but for its id: the mark, the quota cells and the status, each after a gap. */
  const around = (quota: number, whole: boolean) =>
    MARK +
    2 * (GAP + quota) +
    (header ? GAP + modelOf(quota, whole) : 0) +
    (hasBudget ? GAP + budgetOf(quota) : 0) +
    (status ? GAP + status : 0);
  // The most detailed cells that fit beside whole ids and the model's whole name; then that name
  // cut to the cells; failing that, percentages only and the ids cut.
  const cut = ranking.route.maxUsage;
  const narrowest = QUOTA_WIDTHS[QUOTA_WIDTHS.length - 1];
  const fitting = [...QUOTA_WIDTHS.map((at) => ({ at, whole: true })), { at: narrowest, whole: false }]
    .map(({ at, whole }) => ({ quota: quotaColumn(windows, at, cut), whole }))
    .find(({ quota, whole }) => around(quota, whole) + longest <= width);
  const { quota, whole } = fitting ?? { quota: quotaColumn(windows, narrowest, cut), whole: false };
  const idWidth = fitting === undefined ? Math.max("ACCOUNT".length, width - around(quota, whole)) : longest;
  const model = header ? { width: modelOf(quota, whole), kinds } : undefined;

  return (
    <Box flexDirection="column" marginTop={1}>
      {lines.length > 0 ? (
        <Box flexDirection="row">
          <Box width={MARK + idWidth} flexShrink={0}>
            <Text color={color.muted}>{" ".repeat(MARK)}ACCOUNT</Text>
          </Box>
          <Box marginLeft={GAP} width={quota} flexShrink={0}>
            <Text color={color.muted}>5H</Text>
          </Box>
          <Box marginLeft={GAP} width={quota} flexShrink={0}>
            <Text color={color.muted}>7D</Text>
          </Box>
          {model ? (
            <Box marginLeft={GAP} width={model.width} flexShrink={0}>
              <Text color={color.muted} wrap="truncate-end">
                {header}
              </Text>
            </Box>
          ) : null}
          {hasBudget ? (
            <Box marginLeft={GAP} width={budgetOf(quota)} flexShrink={0}>
              <Text color={color.muted}>{BUDGET}</Text>
            </Box>
          ) : null}
        </Box>
      ) : null}
      {lines.map((line) => (
        <MemberLine
          key={line.key}
          line={line}
          idWidth={idWidth}
          quota={quota}
          cut={cut}
          {...(model ? { model } : {})}
          {...(hasBudget ? { budget: budgetOf(quota) } : {})}
        />
      ))}
      {ranking.excluded.map((entry) => (
        <Box key={`excluded:${entry.id}`} paddingLeft={MARK}>
          <Text color={color.muted} wrap="truncate-end">{`excluded  ${entry.id} (${entry.pattern})`}</Text>
        </Box>
      ))}
    </Box>
  );
}
