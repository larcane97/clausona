import { Box, Text } from "ink";
import TextInput from "ink-text-input";

import {
  ADVANCED_ENTRIES,
  type ApiField,
  type ApiFormState,
  advancedFieldIndexes,
  fieldGroup,
  MODEL_KEY,
  plaintextSecretNote,
} from "../api-form.js";
import { color, symbol } from "../theme.js";
import { Divider } from "./Divider.js";

/**
 * What the key field shows instead of the key.
 *
 * `clausona add --api` prints nothing at all while a key is typed, on the grounds that
 * even a count of stars says how long it is. A form is not a one-shot prompt: with no
 * feedback at all the field reads as broken, and the frame is redrawn rather than left in
 * the scrollback. So it is masked rather than blank - and the value behind the mask is
 * never put in a Text node, an error, or anything this panel keeps.
 */
const KEY_MASK = "*";

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
  /** The typed key. Rendered masked and never read for anything else. */
  apiKey: string;
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

export function ApiForm({ form, fields, apiKey, mergeSessions, onChange }: ApiFormProps) {
  const cursor = Math.min(form.cursor, fields.length - 1);
  const advanced = advancedFieldIndexes(fields);
  // The window follows the cursor, and sits at the top of the list while the cursor is
  // still above it - which is where it is the moment the section unfolds.
  const active = advanced.indexOf(cursor);
  const start = Math.max(0, Math.min(active <= 0 ? 0 : active - 2, advanced.length - ADVANCED_WINDOW));
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
            {setCount > 0 ? `${setCount} set of ` : ""}
            {ADVANCED_ENTRIES.length} settings
          </Text>
          <Text color={color.muted}>{form.advancedOpen ? "· a to fold" : "· a to open"}</Text>
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
          : field.id === "key"
            ? "API key"
            : field.id === "customKey"
              ? "Setting"
              : field.id === "customValue"
                ? "Value"
                : (field.entry?.label ?? field.envKey ?? field.id);
    const value =
      field.kind === "secret"
        ? apiKey
        : field.kind === "env"
          ? (form.env[field.envKey ?? ""] ?? "")
          : field.id === "name"
            ? form.name
            : field.id === "baseUrl"
              ? form.baseUrl
              : field.id === "customKey"
                ? form.customKey
                : form.customValue;
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
            <TextInput
              value={value}
              onChange={(next) => onChange(field, next)}
              focus={focused}
              mask={field.kind === "secret" ? KEY_MASK : undefined}
              placeholder={placeholder}
              showCursor={focused}
            />
          </Box>
        </Box>
        {field.kind === "secret" ? (
          <Hint text="Stored in the credential store. profiles.json only records where to read it." />
        ) : (
          <Hint text={field.entry?.hint} />
        )}
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
