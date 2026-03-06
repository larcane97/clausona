import { type PropsWithChildren } from "react";
import { Box, Text } from "ink";
import { color, symbol } from "../theme.js";
import { KeyHints } from "./KeyHint.js";

type KeyHint = { keys: string; action: string };

type ChromeProps = PropsWithChildren<{
  title: string;
  subtitle?: string;
  footer?: string;
  hints?: KeyHint[];
}>;

// Use fixed long width that flex container shrinks down gracefully 
// to prevent ink size recalculation bugs and nested redraws on resize
export function Chrome({ title, subtitle, footer, hints, children }: ChromeProps) {
  const lineWidth = 150;

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      {/* ── Header ── */}
      <Box flexDirection="column" marginBottom={1}>
        <Box gap={1} alignItems="center" width="100%">
          <Box backgroundColor={color.brand} paddingX={1} flexShrink={0}>
            <Text color="#ffffff" bold> CLAUSONA </Text>
          </Box>
          <Box flexShrink={0}><Text color={color.dim}>{symbol.sep}</Text></Box>
          <Box flexShrink={0}><Text color={color.text} bold>{title}</Text></Box>
          {subtitle ? (
            <>
              <Box flexShrink={0}><Text color={color.dim}>{symbol.sep}</Text></Box>
              <Box flexGrow={1} flexShrink={1} overflow="hidden">
                <Text color={color.secondary} wrap="truncate-end">{subtitle}</Text>
              </Box>
            </>
          ) : null}
        </Box>
        <Box marginTop={1} width="100%" flexDirection="row" overflow="hidden" height={1}>
          <Box flexGrow={1} flexShrink={1} minWidth={1}>
            <Text color={color.dim}>
              {symbol.lineH.repeat(lineWidth)}
            </Text>
          </Box>
        </Box>
      </Box>

      {/* ── Body ── */}
      <Box flexDirection="column" flexGrow={1}>
        {children}
      </Box>

      {/* ── Footer ── */}
      {(hints && hints.length > 0) || footer ? (
        <Box marginTop={1} flexDirection="column">
          <Box flexDirection="row" width="100%" overflow="hidden" height={1}>
            <Box flexGrow={1} flexShrink={1} minWidth={1}>
              <Text color={color.dim}>
                {symbol.lineH.repeat(lineWidth)}
              </Text>
            </Box>
          </Box>
          {footer ? (
            <Box marginTop={1}>
              <Text color={color.muted} wrap="truncate-end">{footer}</Text>
            </Box>
          ) : null}
          {hints && hints.length > 0 ? (
            <Box marginTop={footer ? 0 : 1}>
              <KeyHints hints={hints} />
            </Box>
          ) : null}
        </Box>
      ) : null}
    </Box>
  );
}
