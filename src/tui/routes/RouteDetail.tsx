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
import { listWindow } from "../fit.js";
import { color } from "../theme.js";
import { textLines, useWidth } from "../use-width.js";

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
const NARROWEST = QUOTA_WIDTHS[QUOTA_WIDTHS.length - 1];

/**
 * The layouts a member table is tried at, the most detailed first. The gauges go first, the model's
 * name kept whole; then the name is cut to its cells before the reset times go, as the Model
 * setting spells it out.
 */
const LAYOUTS = [
  { at: QUOTA_WIDTHS[0], whole: true },
  ...QUOTA_WIDTHS.slice(1).flatMap((at) => [
    { at, whole: true },
    { at, whole: false },
  ]),
];

/** A Setting's label column. */
const LABEL = 10;

/** A muted label and its value, the label column 10 wide. */
export function Setting({ label, value }: { label: string; value: string }) {
  return (
    <Box flexDirection="row">
      <Box width={LABEL} flexShrink={0}>
        <Text color={color.muted}>{label}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1} minWidth={0}>
        <Text color={color.text}>{value}</Text>
      </Box>
    </Box>
  );
}

/** `↑ 3 more` or `↓ 12 more`, where a list leaves rows out: past the rows' marks, under their names. */
export function MoreRows({ arrow, count }: { arrow: "↑" | "↓"; count: number }) {
  return (
    <Box paddingLeft={MARK}>
      <Text color={color.muted}>{`${arrow} ${count} more`}</Text>
    </Box>
  );
}

/** The line under the route's name. */
const summaryOf = (route: Route) => `${toolLabel(route.tool)} · ${route.strategy} · skip at ${route.maxUsage}%`;

/** The route's settings, each a label and its value. */
function settingsOf({ route, ranking, onlyTool }: Entry): Array<[string, string]> {
  const settings: Array<[string, string]> = [
    ["Accounts", `${route.from.join(", ")}${route.exclude.length ? ` except ${route.exclude.join(", ")}` : ""}`],
    ["Fallback", route.fallback.length ? route.fallback.join(", ") : "none"],
  ];
  // The options that rank the same on the command line.
  if (ranking.model) {
    settings.push(["Model", `ranked as ${onlyTool ? `--tool ${onlyTool} ` : ""}--model ${modelWord(ranking.model)}`]);
  }
  return settings;
}

/**
 * The lines RouteDetail takes `width` columns wide besides its member table's rows: the name, the
 * line under it and the settings as they wrap, the table's header after a blank line, and the
 * line naming the models' limits after another. `brief`, the name and, after the blank line, the
 * table's header. Worked out rather than measured, for the screen to fit the detail to the
 * terminal's height before ink draws it (see fit.ts).
 */
export function detailLines(entry: Entry, models: string[], width: number, brief: boolean): number {
  const { route, ranking } = entry;
  const header = tableOf(ranking, false).lines.length > 0 ? 1 : 0;
  if (brief) return 1 + 1 + header;
  const settings = settingsOf(entry).reduce((sum, [, value]) => sum + textLines(value, width - LABEL), 0);
  const limits = ranking.model || models.length === 0 ? 0 : 2;
  return 1 + textLines(summaryOf(route), width) + settings + 1 + header + limits;
}

/** The member table's rows: the members, the patterns that name nobody, and the accounts excluded. */
export function memberRows(ranking: Ranking): number {
  return tableOf(ranking, false).lines.length + ranking.excluded.length;
}

/**
 * `models` are the names of the limits the route's accounts report on one model (`Opus`), which `m`
 * ranks by in turn. Until one is chosen, a line under the table names them. Once one is, `views`
 * are the route ranked as each of them: the cells take the most detailed form every one of those
 * fits, so moving from one model to another never trades gauges for percentages.
 *
 * `tableLines` is the most lines the member table's rows may take, a line counting those left
 * out included: the table shows the rows that fit, in the ranking's order. `brief` leaves out
 * the line under the name, the settings and the line naming the models' limits, for a pane too
 * short for those and the ranking both: the ranking is what the detail is there for. In a pane
 * shorter even than that, the detail keeps its height and is cut at the foot: let shrink, ink
 * drew its lines over one another.
 */
export function RouteDetail({
  entry,
  pending,
  models,
  views = [],
  tableLines = Number.POSITIVE_INFINITY,
  brief = false,
}: {
  entry: Entry;
  pending: boolean;
  models: string[];
  views?: Ranking[];
  tableLines?: number;
  brief?: boolean;
}) {
  const { name, route, ranking } = entry;
  const [detail, width] = useWidth();
  return (
    <Box ref={detail} flexDirection="column" flexShrink={0}>
      <Text color={color.text} bold wrap="truncate-end">
        {name}
      </Text>
      {brief ? null : (
        <>
          <Text color={color.muted}>{summaryOf(route)}</Text>
          {settingsOf(entry).map(([label, value]) => (
            <Setting key={label} label={label} value={value} />
          ))}
        </>
      )}
      <MemberTable ranking={ranking} views={views} pending={pending} width={width} room={tableLines} />
      {brief || ranking.model || models.length === 0 ? null : <ModelLimits models={models} />}
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
          {/* Which of a Codex limit's windows is the higher, as explain says it: `7D`. Without a
              limit, the dash starts the column as the others' do. */}
          {model.kinds && scoped ? (
            <Box width={KIND} flexShrink={0}>
              <Text color={color.muted}>{scopedWindowKind(scoped) ?? ""}</Text>
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

/** A member table's lines, and what sets the widths of its columns but for the quota cells. */
type Table = {
  lines: Line[];
  /** Every window a quota cell shows. */
  windows: QuotaWindow[];
  /** The model column's header; none when no account reports a limit on the model. */
  header?: string;
  /** Whether the model column's cells start with a window's kind. */
  kinds: boolean;
  hasBudget: boolean;
  /** The status column's width: the longest status of a ranked line. */
  status: number;
  /** The longest id, with its fallback tag. */
  longest: number;
  cut: number;
};

function tableOf(ranking: Ranking, pending: boolean): Table {
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
  // The limit on the model the route is ranked as, named as explain names it; none when no
  // account reports one.
  const header = modelHeader(ranked);
  return {
    lines,
    windows: ranked.flatMap((row) =>
      [row.fiveHour, row.sevenDay, row.scoped, row.budget].filter(
        (window): window is QuotaWindow => window !== undefined,
      ),
    ),
    ...(header ? { header } : {}),
    kinds: ranked.some((row) => row.scoped && scopedWindowKind(row.scoped)),
    hasBudget: lines.some(({ row }) => row?.budget !== undefined),
    status: Math.max(0, ...lines.filter((line) => line.row).map((line) => line.status.length)),
    longest: Math.max("ACCOUNT".length, ...lines.map((line) => line.id.length + (line.fallback ? FALLBACK_TAG : 0))),
    cut: ranking.route.maxUsage,
  };
}

/** The model column is as wide as its header, `whole`, or else as its cells, with the header cut to them. */
const modelWidth = (table: Table, quota: number, whole: boolean) =>
  Math.max(quota + (table.kinds ? KIND : 0), whole && table.header ? table.header.length : 0);

/** The budget column is as wide as its header at least. */
const budgetWidth = (quota: number) => Math.max(quota, BUDGET.length);

/** A line's width but for its id: the mark, the quota cells and the status, each after a gap. */
const around = (table: Table, quota: number, whole: boolean) =>
  MARK +
  2 * (GAP + quota) +
  (table.header ? GAP + modelWidth(table, quota, whole) : 0) +
  (table.hasBudget ? GAP + budgetWidth(quota) : 0) +
  (table.status ? GAP + table.status : 0);

/** The first of `layouts` whose cells fit beside whole ids at `width`, with its quota column's width. */
function firstFit(table: Table, width: number, layouts: typeof LAYOUTS) {
  return layouts
    .map(({ at, whole }) => ({ at, quota: quotaColumn(table.windows, at, table.cut), whole }))
    .find(({ quota, whole }) => around(table, quota, whole) + table.longest <= width);
}

/**
 * `views` are the route ranked as each model `m` offers, when it is ranked as one: the cells take
 * the most detailed form that this table and every one of those fit beside whole ids, so that `m`
 * never trades gauges for percentages from one model to the next; the model's name is then kept
 * whole where it fits. Failing that, percentages only and the ids cut. With no `views`, as for a
 * route ranked as a run that names no model, the table is fitted on its own.
 *
 * `room` is the most lines the rows may take. The table has no cursor to scroll them by, so it
 * shows the rows that fit from the top, the next pick first, and a line counting the rest. The
 * columns are fitted to every row, shown or not.
 */
function MemberTable({
  ranking,
  views,
  pending,
  width,
  room,
}: {
  ranking: Ranking;
  views: Ranking[];
  pending: boolean;
  width: number;
  room: number;
}) {
  const table = tableOf(ranking, pending);
  const { lines, header, kinds, hasBudget, cut } = table;
  const shown = listWindow(lines.length + ranking.excluded.length, room, null, 0);
  const at = Math.min(
    ...[table, ...views.map((view) => tableOf(view, pending))].map(
      (each) => firstFit(each, width, LAYOUTS)?.at ?? NARROWEST,
    ),
  );
  const fitting = firstFit(
    table,
    width,
    LAYOUTS.filter((layout) => layout.at === at),
  );
  const { quota, whole } = fitting ?? { quota: quotaColumn(table.windows, at, cut), whole: false };
  const idWidth =
    fitting === undefined ? Math.max("ACCOUNT".length, width - around(table, quota, whole)) : table.longest;
  const model = header ? { width: modelWidth(table, quota, whole), kinds } : undefined;

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
            <Box marginLeft={GAP} width={budgetWidth(quota)} flexShrink={0}>
              <Text color={color.muted}>{BUDGET}</Text>
            </Box>
          ) : null}
        </Box>
      ) : null}
      {lines.slice(0, shown.end).map((line) => (
        <MemberLine
          key={line.key}
          line={line}
          idWidth={idWidth}
          quota={quota}
          cut={cut}
          {...(model ? { model } : {})}
          {...(hasBudget ? { budget: budgetWidth(quota) } : {})}
        />
      ))}
      {ranking.excluded.slice(0, Math.max(0, shown.end - lines.length)).map((entry) => (
        <Box key={`excluded:${entry.id}`} paddingLeft={MARK}>
          <Text color={color.muted} wrap="truncate-end">{`excluded  ${entry.id} (${entry.pattern})`}</Text>
        </Box>
      ))}
      {shown.below > 0 ? <MoreRows arrow="↓" count={shown.below} /> : null}
    </Box>
  );
}
