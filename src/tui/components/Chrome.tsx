import { Box, Text } from "ink";
import type { PropsWithChildren } from "react";
import { SPARE_ROWS } from "../fit.js";
import { color, symbol } from "../theme.js";
import { KeyHints, keyHintLines } from "./KeyHint.js";

type KeyHint = { keys: string; action: string };

type ChromeProps = PropsWithChildren<{
  title: string;
  subtitle?: string;
  /** Something to act on, after the title: the dashboard's "update available". */
  notice?: string;
  /** A line under the rule, or lines: each one cut at the edge, never wrapped. */
  footer?: string | string[];
  /**
   * A question waiting for a key, such as `Remove route main? (y/N)`: drawn where the footer
   * goes, in place of it, as text and bold - not muted as a message is, so it is not missed.
   */
  question?: string;
  hints?: KeyHint[];
}>;

/** The footer's lines: one for a string, none for an empty one. */
function footerLines(given: ChromeProps["footer"]): string[] {
  return given === undefined ? [] : (Array.isArray(given) ? given : [given]).filter((text) => text !== "");
}

/** What Chrome's height depends on, besides the terminal's width. */
export type ChromeFit = Pick<ChromeProps, "footer" | "question" | "hints">;

/** The lines above the body: the top padding, the title, and the rule with a blank line either side. */
const HEAD_ROWS = 5;
/** The bottom padding. */
const FOOT_PADDING = 1;
/** The columns the padding takes, two a side: what the hints are laid out in. */
const PADDING_COLUMNS = 4;

/**
 * The lines Chrome draws around its body `columns` wide, worked out as it lays them out: the
 * footer's lines and the question are cut at the edge, never wrapped, and the key hints wrap a
 * whole hint at a time.
 */
export function chromeRows({ footer, question, hints }: ChromeFit, columns: number): number {
  const lines = footerLines(footer);
  const hinted = hints !== undefined && hints.length > 0;
  if (!hinted && lines.length === 0 && !question) return HEAD_ROWS + FOOT_PADDING;
  // The rule and the blank line above it; then the question, or the message, after a blank line.
  const above = question ? 2 : lines.length > 0 ? 1 + lines.length : 0;
  const keys = hinted ? (above > 0 ? 0 : 1) + keyHintLines(hints, columns - PADDING_COLUMNS) : 0;
  return HEAD_ROWS + 2 + above + keys + FOOT_PADDING;
}

/**
 * The lines a screen's body may take in a terminal of `size`, so that the frame stays
 * `SPARE_ROWS` short of its height (see fit.ts). Undefined when the terminal gives no height, as
 * a pipe's and a test's stdout do: the body is then drawn whole.
 */
export function bodyRows(size: { columns?: number; rows?: number }, chrome: ChromeFit): number | undefined {
  if (size.rows === undefined) return undefined;
  return size.rows - SPARE_ROWS - chromeRows(chrome, size.columns ?? 80);
}

// Use fixed long width that flex container shrinks down gracefully
// to prevent ink size recalculation bugs and nested redraws on resize
export function Chrome({ title, subtitle, notice, footer: given, question, hints, children }: ChromeProps) {
  const lineWidth = 150;
  const footer = footerLines(given);

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      {/* ── Header ── */}
      <Box flexDirection="column" marginBottom={1}>
        <Box gap={1} alignItems="center" width="100%">
          <Box backgroundColor={color.brand} paddingX={1} flexShrink={0}>
            <Text color="#ffffff" bold>
              {" "}
              CLAUSONA{" "}
            </Text>
          </Box>
          <Box flexShrink={0}>
            <Text color={color.dim}>{symbol.sep}</Text>
          </Box>
          <Box flexShrink={0}>
            <Text color={color.text} bold>
              {title}
            </Text>
          </Box>
          {subtitle ? (
            <>
              <Box flexShrink={0}>
                <Text color={color.dim}>{symbol.sep}</Text>
              </Box>
              <Box flexGrow={1} flexShrink={1} overflow="hidden">
                <Text color={color.secondary} wrap="truncate-end">
                  {subtitle}
                </Text>
              </Box>
            </>
          ) : null}
          {notice ? (
            <>
              <Box flexShrink={0}>
                <Text color={color.dim}>{symbol.sep}</Text>
              </Box>
              <Box flexShrink={0}>
                <Text color={color.accent} bold>
                  {notice}
                </Text>
              </Box>
            </>
          ) : null}
        </Box>
        <Box marginTop={1} width="100%" flexDirection="row" overflow="hidden" height={1}>
          <Box flexGrow={1} flexShrink={1} minWidth={1}>
            <Text color={color.dim}>{symbol.lineH.repeat(lineWidth)}</Text>
          </Box>
        </Box>
      </Box>

      {/* ── Body ── */}
      <Box flexDirection="column" flexGrow={1}>
        {children}
      </Box>

      {/* ── Footer ── */}
      {(hints && hints.length > 0) || footer.length > 0 || question ? (
        <Box marginTop={1} flexDirection="column">
          <Box flexDirection="row" width="100%" overflow="hidden" height={1}>
            <Box flexGrow={1} flexShrink={1} minWidth={1}>
              <Text color={color.dim}>{symbol.lineH.repeat(lineWidth)}</Text>
            </Box>
          </Box>
          {question ? (
            <Box marginTop={1}>
              <Text color={color.text} bold wrap="truncate-end">
                {question}
              </Text>
            </Box>
          ) : footer.length > 0 ? (
            <Box marginTop={1} flexDirection="column">
              {footer.map((text, at) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: the lines are in a fixed order, and two may read the same.
                <Text key={at} color={color.muted} wrap="truncate-end">
                  {text}
                </Text>
              ))}
            </Box>
          ) : null}
          {hints && hints.length > 0 ? (
            <Box marginTop={footer.length > 0 || question ? 0 : 1}>
              <KeyHints hints={hints} />
            </Box>
          ) : null}
        </Box>
      ) : null}
    </Box>
  );
}
