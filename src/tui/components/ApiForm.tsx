import { Box, Text } from "ink";
import TextInput from "ink-text-input";

import {
  ADVANCED_ENTRIES,
  type ApiField,
  type ApiFormState,
  advancedFieldIndexes,
  concealsValue,
  fieldGroup,
  fieldValue,
  MODEL_KEY,
  plaintextSecretNote,
} from "../api-form.js";
import { color, symbol } from "../theme.js";
import { Divider } from "./Divider.js";

/**
 * What the key field shows instead of the key: a constant, the same width for every key.
 *
 * `clausona add --api` prints nothing at all while a key is typed, on the grounds that
 * even a count of stars says how long it is - and length is a real signal, since it
 * narrows down which provider and which key format is in use. That reasoning holds here,
 * so the mask is not one character per character typed.
 *
 * It is not blank either, which is where this differs from the prompt: a form field that
 * never changes reads as broken, and this one has to show that a paste landed and that
 * clearing it worked. A one-line prompt that vanishes on Enter does not have that problem.
 *
 * So: nothing while the field is empty, and this the moment it is not, whatever is behind
 * it. The value itself is never put in a Text node, in an error, or in anything this panel
 * keeps - the panel is handed `keySet`, a boolean, and never the key.
 */
const KEY_MASK = "•".repeat(8);
const KEY_EMPTY_FOCUSED = "type or paste the key";
const KEY_EMPTY = "not set";

/** How many advanced fields are on screen at once, centred on the cursor. */
const ADVANCED_WINDOW = 5;

const GROUP_TITLE: Record<string, string> = {
  model: "Model",
  context: "Context",
  limits: "Limits",
  timeouts: "Timeouts & retries",
  compat: "Compatibility",
  transport: "Transport",
  custom: "Custom",
};

const LABEL_WIDTH = 16;

type ApiFormProps = {
  form: ApiFormState;
  fields: ApiField[];
  /**
   * Whether the key field holds anything - not what it holds. That includes input still being
   * read: bytes parked behind a sequence introducer, or a paste that has not finished. A field
   * holding those is not empty, and saying "type or paste the key" over them invites a second
   * paste on top of the first.
   *
   * A boolean rather than the key, so that the panel's discipline is not what keeps the
   * key off screen: there is nothing here to render.
   */
  keySet: boolean;
  mergeSessions: boolean;
  onChange: (field: ApiField, value: string) => void;
};

function Cursor({ focused }: { focused: boolean }) {
  return (
    <Box width={2} flexShrink={0}>
      <Text color={focused ? color.cursor : color.dim}>{focused ? symbol.cursor : " "}</Text>
    </Box>
  );
}

function Label({ text, focused }: { text: string; focused: boolean }) {
  return (
    <Box width={LABEL_WIDTH} flexShrink={0}>
      <Text color={focused ? color.text : color.secondary} bold={focused} wrap="truncate-end">
        {text}
      </Text>
    </Box>
  );
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <Box gap={1} paddingLeft={2}>
      <Text color={color.error}>{symbol.cross}</Text>
      <Text color={color.error} wrap="truncate-end">
        {message}
      </Text>
    </Box>
  );
}

function Hint({ text, tone }: { text?: string; tone?: "warning" }) {
  if (!text) return null;
  return (
    <Box paddingLeft={2 + LABEL_WIDTH}>
      <Text color={tone === "warning" ? color.warning : color.muted} wrap="truncate-end">
        {text}
      </Text>
    </Box>
  );
}

export function ApiForm({ form, fields, keySet, mergeSessions, onChange }: ApiFormProps) {
  const cursor = Math.min(form.cursor, fields.length - 1);
  const advanced = advancedFieldIndexes(fields);
  // The window follows the cursor, and sits at the top of the list while the cursor is
  // still above it - which is where it is the moment the section unfolds.
  // With the cursor outside the advanced run the window has nothing to centre on, so it
  // stays at the end the cursor left by: stepping down onto Create profile should not
  // throw the list back to the top.
  const active = advanced.indexOf(cursor);
  const anchor = active >= 0 ? active - 2 : cursor > (advanced.at(-1) ?? -1) ? advanced.length : 0;
  const start = Math.max(0, Math.min(anchor, advanced.length - ADVANCED_WINDOW));
  const visible = new Set(advanced.slice(start, start + ADVANCED_WINDOW));
  const setCount = Object.entries(form.env).filter(([key, value]) => key !== MODEL_KEY && value.trim() !== "").length;

  function renderField(field: ApiField, index: number) {
    const focused = index === cursor;
    const error = form.errors[field.id];

    if (field.kind === "auth") {
      return (
        <Box key={field.id} flexDirection="column">
          <Box gap={1}>
            <Cursor focused={focused} />
            <Label text="Auth" focused={focused} />
            <Text color={color.text}>{form.authScheme}</Text>
            {focused && <Text color={color.muted}>(space to change)</Text>}
          </Box>
          <Hint
            text={
              form.authScheme === "bearer"
                ? "Authorization: Bearer - gateways and self-hosted servers"
                : "x-api-key - Anthropic's own API"
            }
          />
          <FieldError message={error} />
        </Box>
      );
    }

    if (field.kind === "sessions") {
      return (
        <Box key={field.id} gap={1}>
          <Cursor focused={focused} />
          <Label text="Sessions" focused={focused} />
          <Text color={mergeSessions ? color.warning : color.text}>{mergeSessions ? "merged" : "separated"}</Text>
          {focused && <Text color={color.muted}>(space to toggle)</Text>}
        </Box>
      );
    }

    if (field.kind === "advanced") {
      return (
        <Box key={field.id} gap={1}>
          <Cursor focused={focused} />
          <Label text={`${form.advancedOpen ? "▾" : "▸"} Advanced`} focused={focused} />
          <Text color={color.muted}>
            {/* Two counts rather than "n of m": a committed free-form setting is set, and
                is not one of the catalog's. */}
            {setCount > 0 ? `${setCount} set · ` : ""}
            {ADVANCED_ENTRIES.length} settings
          </Text>
          <Text color={color.muted}>{form.advancedOpen ? "· a to fold" : "· a to open"}</Text>
        </Box>
      );
    }

    if (field.kind === "secret") {
      // Not a TextInput: every text input renders one glyph per character it holds, which
      // is the length this field must not show. App.tsx takes the keystrokes instead, and
      // the value never reaches this component at all - only whether there is one.
      return (
        <Box key={field.id} flexDirection="column">
          <Box gap={1}>
            <Cursor focused={focused} />
            <Label text="API key" focused={focused} />
            <Text color={keySet ? color.text : color.muted}>
              {keySet ? KEY_MASK : focused ? KEY_EMPTY_FOCUSED : KEY_EMPTY}
            </Text>
          </Box>
          <Hint text="Stored in the credential store. profiles.json only records where to read it." />
          <FieldError message={form.errors[field.id]} />
        </Box>
      );
    }

    if (field.kind === "submit") {
      return (
        <Box key={field.id} gap={1} marginTop={1}>
          <Cursor focused={focused} />
          <Text color={focused ? color.brandLight : color.secondary} bold={focused}>
            {symbol.arrow} Create profile
          </Text>
        </Box>
      );
    }

    // Everything below is a text field, so its keystrokes belong to the input.
    const label =
      field.id === "name"
        ? "Name"
        : field.id === "baseUrl"
          ? "Endpoint"
          : field.id === "customKey"
            ? "Setting"
            : field.id === "customValue"
              ? "Value"
              : (field.entry?.label ?? field.envKey ?? field.id);
    const value = fieldValue(field, form);
    const placeholder =
      field.id === "baseUrl"
        ? "https://api.example.com"
        : field.id === "customKey"
          ? "VARIABLE_NAME"
          : field.kind === "env" && field.envKey && !field.entry
            ? ""
            : undefined;

    return (
      <Box key={field.id} flexDirection="column">
        <Box gap={1}>
          <Cursor focused={focused} />
          <Label text={label} focused={focused} />
          <Box flexGrow={1} minWidth={0}>
            {concealsValue(field, form) ? (
              // Drawn as the key field's constant, whatever it holds. A mask glyph per character
              // cut to eight showed the length of anything shorter - `abc` under a header name
              // drew three - and a value under a hidden name can be any length. The input is
              // still here, drawn at no width, so the value can still be typed into and erased:
              // App.tsx clears a masked value on the first erase.
              <Box>
                <Text color={color.text}>{KEY_MASK}</Text>
                <Box width={0} height={1} overflow="hidden">
                  <TextInput
                    value={value}
                    onChange={(next) => onChange(field, next)}
                    focus={focused}
                    showCursor={false}
                  />
                </Box>
              </Box>
            ) : (
              <TextInput
                value={value}
                onChange={(next) => onChange(field, next)}
                focus={focused}
                placeholder={placeholder}
                showCursor={focused}
              />
            )}
          </Box>
        </Box>
        <Hint text={field.entry?.hint} />
        {field.kind === "env" && field.envKey && (
          <Hint text={plaintextSecretNote(field.envKey, value)} tone="warning" />
        )}
        <FieldError message={error} />
      </Box>
    );
  }

  let lastGroup: string | undefined;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color.dim} paddingX={2} paddingY={1}>
      {fields.map((field, index) => {
        const isAdvanced = advanced.includes(index);
        if (isAdvanced && !visible.has(index)) return null;

        const group = isAdvanced ? (fieldGroup(field) ?? "custom") : undefined;
        const heading = group && group !== lastGroup ? group : undefined;
        if (group) lastGroup = group;

        const above = isAdvanced && index === advanced[start] && start > 0 ? start : 0;
        const below =
          isAdvanced && index === advanced[Math.min(start + ADVANCED_WINDOW, advanced.length) - 1]
            ? advanced.length - (start + ADVANCED_WINDOW)
            : 0;

        return (
          <Box key={field.id} flexDirection="column">
            {above > 0 && <Text color={color.dim}>{`   ▲ ${above} more above`}</Text>}
            {heading && <Divider title={GROUP_TITLE[heading] ?? heading} />}
            {renderField(field, index)}
            {below > 0 && <Text color={color.dim}>{`   ▼ ${below} more below`}</Text>}
          </Box>
        );
      })}
    </Box>
  );
}
