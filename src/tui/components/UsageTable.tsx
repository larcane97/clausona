import { Box, Text } from "ink";
import type { ReactNode } from "react";

import { formatCompactCount, formatCompactCurrency, formatCount, formatCurrency } from "../../lib/format.js";
import type { UsageSummary } from "../../types.js";
import { color } from "../theme.js";
import { useWidth } from "../use-width.js";
import { Divider } from "./Divider.js";

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
 * cut first - down to its floor - and then the numbers put in their short form. A number is
 * never cut: a count missing its last digits reads as a different count.
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

export function UsageTable({ rows }: { rows: UsageRow[] }) {
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

  return (
    <Box ref={table} flexDirection="column" gap={1}>
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
      {rows.map((row, r) => {
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
      })}
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
