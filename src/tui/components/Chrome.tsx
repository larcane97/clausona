import { Box, Text } from "ink";
import type { PropsWithChildren } from "react";
import { color, symbol } from "../theme.js";
import { KeyHints } from "./KeyHint.js";

type KeyHint = { keys: string; action: string };

type ChromeProps = PropsWithChildren<{
  title: string;
  subtitle?: string;
  /** Something to act on, after the title: the dashboard's "update available". */
  notice?: string;
  /** A line under the rule, or lines: each one cut at the edge, never wrapped. */
  footer?: string | string[];
  hints?: KeyHint[];
}>;

// Use fixed long width that flex container shrinks down gracefully
// to prevent ink size recalculation bugs and nested redraws on resize
export function Chrome({ title, subtitle, notice, footer: given, hints, children }: ChromeProps) {
  const lineWidth = 150;
  const footer = given === undefined ? [] : (Array.isArray(given) ? given : [given]).filter((text) => text !== "");

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
      {(hints && hints.length > 0) || footer.length > 0 ? (
        <Box marginTop={1} flexDirection="column">
          <Box flexDirection="row" width="100%" overflow="hidden" height={1}>
            <Box flexGrow={1} flexShrink={1} minWidth={1}>
              <Text color={color.dim}>{symbol.lineH.repeat(lineWidth)}</Text>
            </Box>
          </Box>
          {footer.length > 0 ? (
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
            <Box marginTop={footer.length > 0 ? 0 : 1}>
              <KeyHints hints={hints} />
            </Box>
          ) : null}
        </Box>
      ) : null}
    </Box>
  );
}
