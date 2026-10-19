import { Spinner } from "@inkjs/ui";
import { Box, Text } from "ink";

import { STAR_REPO, type StarOutcome } from "../../core/star.js";
import { color, symbol } from "../theme.js";
import { textLines } from "../use-width.js";

/**
 * The dashboard's one-time question about a star: asked, under way, or answered. A question is
 * `ready` once it has been on screen for `STAR_POPUP_GRACE_MS`; until then it takes no answer.
 */
export type StarPopupState =
  | { phase: "ask"; choice: "star" | "later"; ready: boolean }
  | { phase: "starring" }
  | { phase: "done"; outcome: StarOutcome };

// Kept in star.ts, which the shell's questions read without loading React.
export { STAR_POPUP_GRACE_MS } from "../../core/star.js";

/** The popup's keys, by what it shows: none while it starts, or while it waits to be answered. */
export function starPopupHints(state: StarPopupState): { keys: string; action: string }[] {
  if (state.phase === "starring" || (state.phase === "ask" && !state.ready)) return [];
  if (state.phase === "done") return [{ keys: "any key", action: "close" }];
  return [
    { keys: "←→", action: "choose" },
    { keys: "enter", action: "select" },
    { keys: "esc", action: "not now" },
  ];
}

/** The footer's one line for a star given from the dashboard's list. */
export function starMessage(outcome: StarOutcome): string {
  switch (outcome.kind) {
    case "starred":
      return `★ Starred ${STAR_REPO}${outcome.login ? ` as @${outcome.login}` : ""}. Thank you!`;
    case "opened":
      return `★ Opened github.com/${STAR_REPO}. Press Star there. Thank you!`;
    case "manual":
      return `★ Star clausona at ${outcome.url}`;
  }
}

/** How far down the dashboard's body the popup sits when there is room: about the middle of its list. */
export const STAR_POPUP_TOP = 4;

/** The popup's widest, and what its border and padding take of that. */
const POPUP_WIDTH = 52;
const POPUP_INSET = 8;

const ASK = "A star on GitHub helps others find it.";
const STARRING = "Starring clausona on GitHub…";

/** What an answer says: the first line, which has a ✔ before it unless it is a link to follow, and the second. */
function outcomeTexts(outcome: StarOutcome): { first: string; second: string; checked: boolean } {
  if (outcome.kind === "manual") return { first: "Star clausona at", second: outcome.url, checked: false };
  return {
    first: outcome.kind === "starred" ? `Starred ${STAR_REPO}` : "Opened the page in your browser",
    second:
      outcome.kind === "opened"
        ? "Press Star at the top of the page. Thank you!"
        : outcome.login
          ? `as @${outcome.login}. Thank you!`
          : "Thank you!",
    checked: true,
  };
}

/**
 * The lines the popup takes `columns` wide - the terminal's - for the dashboard to keep it clear of
 * the key hints: its border and padding, the title and the blank line under it, and what is under
 * that as it wraps, never fewer than three lines.
 */
export function starPopupRows(state: StarPopupState, columns: number): number {
  const inner = Math.min(POPUP_WIDTH, columns - 4) - POPUP_INSET;
  let content: number;
  if (state.phase === "ask") content = textLines(ASK, inner) + 2;
  else if (state.phase === "starring") content = textLines(STARRING, inner - 2);
  else {
    const { first, second, checked } = outcomeTexts(state.outcome);
    content = textLines(first, checked ? inner - 2 : inner) + textLines(second, inner);
  }
  return 2 + 2 + 2 + Math.max(3, content);
}

/** Bracketed when focused as well as filled, so a terminal without colour still shows which. */
function Button({ label, focused }: { label: string; focused: boolean }) {
  return (
    <Box flexShrink={0} backgroundColor={focused ? color.brand : undefined}>
      <Text color={focused ? "#ffffff" : color.secondary} bold={focused}>
        {focused ? `[ ${label} ]` : `  ${label}  `}
      </Text>
    </Box>
  );
}

function Outcome({ outcome }: { outcome: StarOutcome }) {
  const { first, second, checked } = outcomeTexts(outcome);
  if (!checked) {
    return (
      <>
        <Text color={color.text}>{first}</Text>
        <Text color={color.brandLight}>{second}</Text>
      </>
    );
  }
  return (
    <>
      <Box gap={1}>
        <Box flexShrink={0}>
          <Text color={color.healthy}>{symbol.check}</Text>
        </Box>
        <Text color={color.healthy} bold>
          {first}
        </Text>
      </Box>
      <Text color={color.secondary}>{second}</Text>
    </>
  );
}

/**
 * Drawn over the dashboard: it is positioned absolutely, and its background covers what is
 * under it. The width is a ceiling - in a narrow terminal it shrinks and its text wraps. `top`
 * rows down the body: `STAR_POPUP_TOP` sits it about the middle of the dashboard's list, and in
 * a terminal too short for that the dashboard gives less (see `starPopupRows`), so that the popup
 * stays above the key hints. Under the title, the question, the spinner and the answer get the
 * same three rows at least, so the popup does not jump between them.
 */
export function StarPopup({ state, top = STAR_POPUP_TOP }: { state: StarPopupState; top?: number }) {
  return (
    <Box position="absolute" width="100%" marginTop={top} justifyContent="center">
      <Box
        flexDirection="column"
        width={POPUP_WIDTH}
        flexShrink={1}
        borderStyle="round"
        borderColor={color.brand}
        backgroundColor={color.surface}
        paddingX={3}
        paddingY={1}
      >
        <Box gap={1}>
          <Box flexShrink={0}>
            <Text color={color.warning}>★</Text>
          </Box>
          <Text color={color.text} bold>
            Was clausona helpful?
          </Text>
        </Box>
        <Box flexDirection="column" marginTop={1} minHeight={3}>
          {state.phase === "ask" && (
            <>
              <Text color={color.secondary}>{ASK}</Text>
              <Box marginTop={1} gap={2} justifyContent="center">
                <Button label="★ Star" focused={state.choice === "star"} />
                <Button label="Not now" focused={state.choice === "later"} />
              </Box>
            </>
          )}
          {state.phase === "starring" && <Spinner label={STARRING} />}
          {state.phase === "done" && <Outcome outcome={state.outcome} />}
        </Box>
      </Box>
    </Box>
  );
}
