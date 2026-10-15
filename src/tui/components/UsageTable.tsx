import { Box, Text } from "ink";
import type { ReactNode } from "react";

import { formatCompactCount, formatCompactCurrency, formatCount, formatCurrency } from "../../lib/format.js";
import type { UsageSummary } from "../../types.js";
import { color } from "../theme.js";
import { useWidth } from "../use-width.js";
import { Divider } from "./Divider.js";
import { ScrollList } from "./ScrollList.js";

export type UsageRow = { name: string; isActive: boolean; usage: UsageSummary };

type Cells = [string, string, string];

const HEADERS: Cells = ["COST", "INPUT", "OUTPUT"];

/** Between two columns. With none, a value as wide as its column ran straight into the next. */
const GAP = 2;

/** What a profile name keeps before the numbers are shortened to make room for it. */
const NAME_FLOOR = 16;

const inFull = (usage: UsageSummary): Cells => [
  formatCurrency(usage.cost),
  formatCount(usage.inputTokens),
  formatCount(usage.outputTokens),
];

const inShort = (usage: UsageSummary): Cells => [
  formatCompactCurrency(usage.cost),
  formatCompactCount(usage.inputTokens),
  formatCompactCount(usage.outputTokens),
];

type Fit = { name: number; widths: number[]; cells: Cells[] };

/**
 * The table's columns in `space` columns: each as wide as its widest value, the name column
 * cut first - down to its floor - and then the numbers put in their short form, rather than
 * cut: a count missing its last digits reads as a different count. Only a terminal too narrow
 * for even the short form (about 33 columns) has the row clipped at its edge.
 *
 * `names` and `usages` include the total row.
 */
function fitUsageColumns(space: number, names: string[], usages: UsageSummary[]): Fit {
  const longest = Math.max("PROFILE".length, ...names.map((name) => name.length));
  let fit: Fit | undefined;
  for (const format of [inFull, inShort]) {
    const cells = usages.map(format);
    const widths = HEADERS.map((header, i) => Math.max(header.length, ...cells.map((row) => row[i].length)));
    const room = space - widths.reduce((sum, width) => sum + width, 0) - GAP * widths.length;
    fit = { name: Math.max(0, Math.min(longest, room)), widths, cells };
    if (room >= Math.min(longest, NAME_FLOOR)) break;
  }
  return fit as Fit;
}

/** The table's header, its two rules and its total. */
const FRAME_LINES = 4;

/**
 * How the table spaces its lines. `spaced`: a blank line between every two, as it always was.
 * `packed`: none between the profile rows. `dense`: none anywhere.
 */
export type UsageSpacing = "spaced" | "packed" | "dense";

export type UsageFit = {
  spacing: UsageSpacing;
  /** The lines the profile rows may take, when they scroll in them: see `ScrollList`. */
  window?: number;
};

/** The fewest lines of profile rows the screen scrolls before it gives up its blank lines. */
const MIN_WINDOW = 3;

/** The lines the table takes besides its profile rows, spaced as `spacing` says. */
function frameLines(spacing: UsageSpacing): number {
  return spacing === "dense" ? FRAME_LINES : 2 * FRAME_LINES;
}

/**
 * How the Usage screen fits `count` profile rows in `body` lines - what Chrome leaves, when the
 * terminal gives a height - where `around` is what the screen draws around the table, spaced
 * and dense. Spaced as it always was when that fits. Short of that the rows give up the blank lines
 * between them, and scroll in what is left while that is a few lines; then the screen gives up
 * every blank line and its padding, and the rows scroll in what that leaves.
 */
export function fitUsage(count: number, body: number | undefined, around: { spaced: number; dense: number }): UsageFit {
  if (body === undefined || around.spaced + 2 * count + 2 * FRAME_LINES - 1 <= body) return { spacing: "spaced" };
  const packed = body - around.spaced - frameLines("packed");
  if (packed >= Math.min(count, MIN_WINDOW)) return { spacing: "packed", window: packed };
  return { spacing: "dense", window: body - around.dense - frameLines("dense") };
}

/**
 * The usage of each profile and the total. `layout`, from `fitUsage`, says how it is spaced and the
 * lines its profile rows scroll in (`ScrollList`, ↑↓), the header and the total staying put.
 */
export function UsageTable({ rows, layout = { spacing: "spaced" } }: { rows: UsageRow[]; layout?: UsageFit }) {
  const [table, width] = useWidth();
  const total: UsageSummary = {
    cost: rows.reduce((sum, row) => sum + row.usage.cost, 0),
    inputTokens: rows.reduce((sum, row) => sum + row.usage.inputTokens, 0),
    outputTokens: rows.reduce((sum, row) => sum + row.usage.outputTokens, 0),
  };
  const fit = fitUsageColumns(
    width,
    [...rows.map((row) => row.name), "Total"],
    [...rows.map((row) => row.usage), total],
  );
  const totalCells = fit.cells[rows.length] as Cells;

  const line = (key: string, name: ReactNode, cells: ReactNode[]) => (
    <Box key={key} flexDirection="row" gap={GAP} width="100%" overflow="hidden" height={1}>
      <Box width={fit.name} flexShrink={0} overflow="hidden">
        {name}
      </Box>
      {cells.map((cell, i) => (
        <Box key={HEADERS[i]} width={fit.widths[i]} flexShrink={0}>
          {cell}
        </Box>
      ))}
    </Box>
  );

  const profileRows = rows.map((row, r) => {
    const values = [row.usage.cost, row.usage.inputTokens, row.usage.outputTokens];
    return line(
      row.name,
      <Text color={row.isActive ? color.brand : color.text} bold={row.isActive} wrap="truncate-end">
        {row.name}
      </Text>,
      (fit.cells[r] as Cells).map((cell, i) => (
        <Text key={HEADERS[i]} color={(values[i] ?? 0) > 0 ? color.text : color.muted}>
          {cell}
        </Text>
      )),
    );
  });

  return (
    <Box ref={table} flexDirection="column" gap={layout.spacing === "dense" ? 0 : 1}>
      {line(
        "header",
        <Text color={color.muted} wrap="truncate-end">
          PROFILE
        </Text>,
        HEADERS.map((header) => (
          <Text key={header} color={color.muted}>
            {header}
          </Text>
        )),
      )}
      <Divider />
      {layout.spacing === "spaced" ? profileRows : <ScrollList items={profileRows} rows={layout.window} />}
      <Divider />
      {line(
        "total",
        <Text color={color.text} bold>
          Total
        </Text>,
        [
          <Text key="cost" color={color.brand} bold>
            {totalCells[0]}
          </Text>,
          <Text key="input" color={color.secondary}>
            {totalCells[1]}
          </Text>,
          <Text key="output" color={color.secondary}>
            {totalCells[2]}
          </Text>,
        ],
      )}
    </Box>
  );
}
