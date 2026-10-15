import { Spinner } from "@inkjs/ui";
import { Box, Text } from "ink";

import { STAR_REPO, type StarOutcome } from "../../core/star.js";
import { color, symbol } from "../theme.js";

/**
 * The dashboard's one-time question about a star: asked, under way, or answered. A question is
 * `ready` once it has been on screen for `STAR_POPUP_GRACE_MS`; until then it takes no answer.
 */
export type StarPopupState =
  | { phase: "ask"; choice: "star" | "later"; ready: boolean }
  | { phase: "starring" }
  | { phase: "done"; outcome: StarOutcome };

export const STAR_POPUP_GRACE_MS = 700;

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
  if (outcome.kind === "manual") {
    return (
      <>
        <Text color={color.text}>Star clausona at</Text>
        <Text color={color.brandLight}>{outcome.url}</Text>
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
          {outcome.kind === "starred" ? `Starred ${STAR_REPO}` : "Opened the page in your browser"}
        </Text>
      </Box>
      <Text color={color.secondary}>
        {outcome.kind === "opened"
          ? "Press Star at the top of the page. Thank you!"
          : outcome.login
            ? `as @${outcome.login}. Thank you!`
            : "Thank you!"}
      </Text>
    </>
  );
}

/**
 * Drawn over the dashboard: it is positioned absolutely, and its background covers what is
 * under it. The width is a ceiling - in a narrow terminal it shrinks and its text wraps. Four
 * rows down sits it about the middle of the dashboard's list, which is never shorter than
 * eighteen rows. Under the title, the question, the spinner and the answer get the same
 * three rows at least, so the popup does not jump between them.
 */
export function StarPopup({ state }: { state: StarPopupState }) {
  return (
    <Box position="absolute" width="100%" marginTop={4} justifyContent="center">
      <Box
        flexDirection="column"
        width={52}
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
            Enjoying clausona?
          </Text>
        </Box>
        <Box flexDirection="column" marginTop={1} minHeight={3}>
          {state.phase === "ask" && (
            <>
              <Text color={color.secondary}>A star on GitHub helps other people find it.</Text>
              <Box marginTop={1} gap={2} justifyContent="center">
                <Button label="★ Star" focused={state.choice === "star"} />
                <Button label="Not now" focused={state.choice === "later"} />
              </Box>
            </>
          )}
          {state.phase === "starring" && <Spinner label="Starring clausona on GitHub…" />}
          {state.phase === "done" && <Outcome outcome={state.outcome} />}
        </Box>
      </Box>
    </Box>
  );
}
