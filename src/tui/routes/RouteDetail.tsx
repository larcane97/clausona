import { Box, Text } from "ink";

import type { Route } from "../../core/route-config.js";
import type { Ranking, Row } from "../../core/routing.js";
import { fitQuotaValue } from "../../lib/format.js";
import { detailOrder, skipReason, toolLabel } from "../../lib/route-render.js";
import type { QuotaWindow } from "../../types.js";
import { QuotaCell } from "../components/QuotaCell.js";
import { color } from "../theme.js";
import { useWidth } from "../use-width.js";

/**
 * The Routes screen's detail pane: the selected route's settings, and its members ranked as
 * `csn route explain` ranks them, with their quota and status.
 */

/** A route as the screen lists it: its name, the route with its defaults, and its ranking. */
export type Entry = { name: string; route: Route; ranking: Ranking };

/** A row's mark (`▸`) and the space after it. */
export const MARK = 2;
export const GAP = 2;
/** The widths a quota cell is tried at, widest first: gauge and reset, percentage and reset, percentage. */
const QUOTA_WIDTHS = [19, 8, 4];

function Setting({ label, value }: { label: string; value: string }) {
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

export function RouteDetail({ entry, pending }: { entry: Entry; pending: boolean }) {
  const { name, route, ranking } = entry;
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
      <MemberTable ranking={ranking} pending={pending} width={width} />
    </Box>
  );
}

/** A member table line: a ranked row with its two quota cells, or a name whose status runs across them. */
type Line = { key: string; id: string; picked: boolean; fallback: boolean; row?: Row; status: string; tone: string };

function statusOf(row: Row, ranking: Ranking): string {
  const { outcome, route } = ranking;
  if (row.status === "picked")
    return outcome.kind === "picked" && outcome.stage === "overflow" ? "next (most room left)" : "next";
  if (row.status === "over-limit") return `over ${route.maxUsage}%`;
  return "";
}

function lineOf(row: Row, ranking: Ranking, pending: boolean): Line {
  const base = { key: `row:${row.id}`, id: row.id, picked: row.status === "picked", fallback: row.role === "fallback" };
  // Before the quota is read every member reads as unread; those are the ones still loading.
  if (pending && row.skip === "no-reading") return { ...base, status: "loading…", tone: color.muted };
  if (row.skip) return { ...base, status: skipReason(row), tone: color.muted };
  return { ...base, row, status: statusOf(row, ranking), tone: base.picked ? color.accent : color.warning };
}

/** The widest a column of cells is at `width`: fitQuotaValue drops what does not fit. */
function quotaColumn(windows: QuotaWindow[], width: number): number {
  return Math.max(2, ...windows.map((window) => fitQuotaValue(window, width).length));
}

/** Text after a gap that takes the rest of the line, cut rather than wrapped. */
function Rest({ text, tone }: { text: string; tone: string }) {
  return (
    <Box marginLeft={GAP} flexGrow={1} flexShrink={1} minWidth={0}>
      <Text color={tone} wrap="truncate-end">
        {text}
      </Text>
    </Box>
  );
}

function MemberLine({ line, idWidth, quota }: { line: Line; idWidth: number; quota: number }) {
  const { row } = line;
  // The window that sets the member's usage is bold, as in `csn route explain`.
  const cell = (window: QuotaWindow | undefined, which: "5H" | "7D") => (
    <Box marginLeft={GAP} width={quota} flexShrink={0}>
      <QuotaCell window={window} live={!row?.usage?.stale} width={quota} bold={row?.usage?.window === which} />
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
      {line.status ? <Rest text={line.status} tone={line.tone} /> : null}
    </Box>
  );
}

const FALLBACK_TAG = " (fallback)".length;

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
  ];
  const windows = lines.flatMap(({ row }) =>
    [row?.fiveHour, row?.sevenDay].filter((window): window is QuotaWindow => window !== undefined),
  );
  const status = Math.max(0, ...lines.filter((line) => line.row).map((line) => line.status.length));
  const longest = Math.max(
    "ACCOUNT".length,
    ...lines.map((line) => line.id.length + (line.fallback ? FALLBACK_TAG : 0)),
  );
  /** A line's width but for its id: the mark, the two quota cells and the status, each after a gap. */
  const around = (quota: number) => MARK + 2 * (GAP + quota) + (status ? GAP + status : 0);
  // The most detailed cells that fit beside whole ids; failing that, percentages only and the ids cut.
  const fitting = QUOTA_WIDTHS.map((at) => quotaColumn(windows, at)).find((quota) => around(quota) + longest <= width);
  const quota = fitting ?? quotaColumn(windows, QUOTA_WIDTHS[QUOTA_WIDTHS.length - 1]);
  const idWidth = fitting === undefined ? Math.max("ACCOUNT".length, width - around(quota)) : longest;

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
        </Box>
      ) : null}
      {lines.map((line) => (
        <MemberLine key={line.key} line={line} idWidth={idWidth} quota={quota} />
      ))}
      {ranking.excluded.map((entry) => (
        <Box key={`excluded:${entry.id}`} paddingLeft={MARK}>
          <Text color={color.muted} wrap="truncate-end">{`excluded  ${entry.id} (${entry.pattern})`}</Text>
        </Box>
      ))}
    </Box>
  );
}
