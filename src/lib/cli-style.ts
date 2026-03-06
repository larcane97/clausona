import chalk from "chalk";

import { color, symbol } from "../tui/theme.js";

// ─── Semantic prefixes ──────────────────────────────────────────────
export const ok = chalk.hex(color.healthy)(symbol.check);
export const fail = chalk.hex(color.error)(symbol.cross);
export const warnIcon = chalk.hex(color.warning)("⚠");

// ─── Text styles ────────────────────────────────────────────────────
export const bold = chalk.bold;
export const dim = chalk.hex(color.muted);
export const dimmer = chalk.hex(color.dim);
export const accent = chalk.hex(color.brandLight);
export const secondary = chalk.hex(color.secondary);
export const green = chalk.hex(color.healthy);
export const red = chalk.hex(color.error);
export const yellow = chalk.hex(color.warning);
export const brand = chalk.hex(color.brand);

// ─── Helpers ────────────────────────────────────────────────────────

export function success(msg: string) {
  return `  ${ok} ${msg}`;
}

export function heading(title: string, width = 42) {
  const rest = Math.max(0, width - title.length - 5);
  return `  ${dim(symbol.lineH.repeat(3))} ${bold(title)} ${dim(symbol.lineH.repeat(rest))}`;
}

export function styledCost(value: number) {
  if (value <= 0) return dim("—");
  if (value >= 5) return yellow(`$${value.toFixed(2)}`);
  return `$${value.toFixed(2)}`;
}

export function styledCount(value: number) {
  if (value <= 0) return dim("—");
  return value.toLocaleString("en-US");
}

export function box(title: string, lines: string[]) {
  const minWidth = 42;
  const maxContentWidth = Math.max(0, ...lines.map((l) => stripAnsi(l).length));
  const width = Math.max(minWidth, maxContentWidth + 4);
  const border = dim;
  const tl = border(symbol.cornerTL);
  const tr = border(symbol.cornerTR);
  const bl = border(symbol.cornerBL);
  const br = border(symbol.cornerBR);
  const h = border(symbol.lineH);
  const v = border(symbol.lineV);

  const titleLine = `${tl}${h} ${accent(title)} ${h.repeat(Math.max(0, width - title.length - 3))}${tr}`;
  const emptyLine = `${v}${" ".repeat(width)}${v}`;
  const bottomLine = `${bl}${h.repeat(width)}${br}`;

  const contentLines = lines.map((line) => {
    const stripped = stripAnsi(line);
    const pad = Math.max(0, width - 2 - stripped.length);
    return `${v}  ${line}${" ".repeat(pad)}${v}`;
  });

  return ["  " + titleLine, "  " + emptyLine, ...contentLines.map((l) => "  " + l), "  " + emptyLine, "  " + bottomLine].join("\n");
}

export function helpSection(title: string, items: [string, string][]) {
  const maxCmd = Math.max(...items.map(([cmd]) => cmd.length));
  const rows = items.map(([cmd, desc]) => `    ${accent(cmd.padEnd(maxCmd + 2))}${dim(desc)}`);
  return [`  ${bold(title)}`, ...rows].join("\n");
}

export function helpUsage(text: string) {
  return `    ${text.replace(/<([^>]+)>/g, (_m, p1: string) => accent(`<${p1}>`))}`;
}

/** Strip ANSI escape codes to get visible length */
export function stripAnsi(str: string) {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Pad a string that may contain ANSI codes to a visible width */
export function padEnd(str: string, width: number) {
  const visible = stripAnsi(str).length;
  const needed = Math.max(0, width - visible);
  return str + " ".repeat(needed);
}
