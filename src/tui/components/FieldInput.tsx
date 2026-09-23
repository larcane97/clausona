import chalk from "chalk";
import { Text, useInput } from "ink";

/**
 * One line of text input for the API form, whose cursor belongs to the form.
 *
 * ink-text-input keeps its cursor offset in state of its own, where nothing else can see it. A
 * bracketed paste into a field is read by the form's listener, not by the input (App.tsx,
 * `fieldPaste`), so it could only go in at the end of the field, wherever the arrows had put the
 * cursor. Here the offset comes in with the value and goes out with every edit, and a paste goes
 * in where the cursor is.
 *
 * Otherwise it is ink-text-input's behaviour and drawing, key for key: the same keys it ignores
 * (up, down, Tab, Enter, ctrl-c), the arrows that move the cursor only while it is shown, an
 * erase before the cursor, anything else inserted at it - and the offset kept inside the value,
 * where ink-text-input let a left arrow at the start take it below zero for a keystroke.
 */
export function FieldInput({
  value,
  cursor,
  focus,
  placeholder = "",
  showCursor,
  onChange,
}: {
  value: string;
  /** Where the cursor is, as an offset into `value`; clamped to it. */
  cursor: number;
  focus: boolean;
  placeholder?: string;
  showCursor: boolean;
  /** Every edit: the new value and where the cursor is in it - the value unchanged when only the cursor moved. */
  onChange: (value: string, cursor: number) => void;
}) {
  const at = Math.max(0, Math.min(cursor, value.length));

  useInput(
    (input, key) => {
      if (key.upArrow || key.downArrow || (key.ctrl && input === "c") || key.tab || key.return) return;
      let next = value;
      let nextAt = at;
      if (key.leftArrow) {
        if (showCursor) nextAt--;
      } else if (key.rightArrow) {
        if (showCursor) nextAt++;
      } else if (key.backspace || key.delete) {
        if (at > 0) {
          next = value.slice(0, at - 1) + value.slice(at);
          nextAt--;
        }
      } else {
        next = value.slice(0, at) + input + value.slice(at);
        nextAt += input.length;
      }
      nextAt = Math.max(0, Math.min(nextAt, next.length));
      if (next !== value || nextAt !== at) onChange(next, nextAt);
    },
    { isActive: focus },
  );

  if (!(showCursor && focus)) {
    return <Text>{placeholder && value.length === 0 ? chalk.grey(placeholder) : value}</Text>;
  }
  if (value.length === 0) {
    return (
      <Text>{placeholder ? chalk.inverse(placeholder[0]) + chalk.grey(placeholder.slice(1)) : chalk.inverse(" ")}</Text>
    );
  }
  const drawn = [...value].map((char, index) => (index === at ? chalk.inverse(char) : char)).join("");
  return <Text>{at === value.length ? drawn + chalk.inverse(" ") : drawn}</Text>;
}
