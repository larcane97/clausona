import { homedir } from "node:os";

import { Spinner } from "@inkjs/ui";
import { Box, type Key, Text, useApp, useInput, useStdin, useStdout } from "ink";
import TextInput from "ink-text-input";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { bootstrapInitFromCurrentState } from "../commands.js";
import {
  doctorSeverity,
  doctorSummary,
  formatCount,
  formatCurrency,
  formatQuotaInline,
  localTimezoneLabel,
  quotaSeverity,
} from "../lib/format.js";
import { displayName } from "../lib/profile-env.js";
import { defaultProfileName, profileId } from "../lib/profile-ref.js";
import {
  EMPTY_SECRET_INPUT,
  PASTE_END,
  PASTE_START,
  readSecretChunk,
  type SecretInputState,
  settleSecretInput,
} from "../lib/prompt-secret.js";
import {
  addApiProfile,
  addProfile,
  discoverAccounts,
  doctorProfiles,
  fetchProfileQuotas,
  initializeRegistry,
  listProfiles,
  loginProfile,
  removeProfile,
  repairProfile,
  setActiveProfileByName,
  updateProfileConfig,
  validateConfigDir,
} from "../lib/service.js";
import type { DiscoveredAccount, DoctorProfileResult, ProfileListItem, QuotaSnapshot, ToolName } from "../types.js";
import {
  type ApiField,
  type ApiFormState,
  apiFormEnv,
  apiFormFields,
  apiFormHost,
  concealsValue,
  customEntryError,
  defaultAuthScheme,
  emptyApiForm,
  fieldValue,
  isTypingField,
  keyInputRefusal,
  keyReadRefusal,
  liveApiFieldError,
  NO_RAW_KEY_INPUT,
  PASTE_SKIPPED,
  scrubSecret,
  UNFINISHED_PASTE,
  validateApiForm,
  withoutKeys,
  withoutMisplacedKeys,
} from "./api-form.js";
import { ApiForm } from "./components/ApiForm.js";
import { Chrome } from "./components/Chrome.js";
import { Divider } from "./components/Divider.js";
import { ProfilePreview } from "./components/ProfilePreview.js";
import { SelectList, type SelectListItem } from "./components/SelectList.js";
import { StepIndicator } from "./components/StepIndicator.js";
import { color, symbol } from "./theme.js";

type Screen = "dashboard" | "use" | "doctor" | "init" | "usage";
type InitStep = "loading" | "select" | "name" | "default" | "review" | "applying" | "done" | "error";

type AppProps = {
  initialScreen?: Screen;
};

type InitState = {
  step: InitStep;
  accounts: DiscoveredAccount[];
  selected: string[];
  profileNames: Record<string, string>;
  cursor: number;
  nameIndex: number;
  nameDraft: string;
  defaultProfile: string;
  mergeSessionsMap: Record<string, boolean>;
  nameField: 0 | 1;
  message?: string;
};

// ── Add / Overlay types ──

type AddStep =
  | "loading"
  | "method"
  | "discover-select"
  | "discover-name"
  | "login-tool"
  | "login-name"
  | "import-path"
  | "import-name"
  | "api-form"
  | "applying"
  | "done"
  | "error";

/**
 * The ways to add a profile, and the only list the method step reads - both for the rows
 * it draws and for what Enter on one of them means.
 *
 * Exported so that a test can assert the set without first driving the key sequence that
 * reaches the step: a binding moving should not silently take an option with it.
 */
export const ADD_METHODS = [
  { value: "discover", label: "Discover accounts", hint: "Scan for unregistered ~/.claude-* accounts" },
  { value: "login", label: "Login as new account", hint: "Authenticate via browser OAuth" },
  { value: "import", label: "Import from path", hint: "Register an existing config directory manually" },
  { value: "api", label: "API endpoint", hint: "Anthropic API, a gateway, or a self-hosted server" },
] as const;

type AddState = {
  step: AddStep;
  discoveredAccounts: DiscoveredAccount[];
  selectedAccounts: string[];
  profileNames: Record<string, string>;
  nameDraft: string;
  nameIndex: number;
  importPath: string;
  importError: string | null;
  importAccount: { configDir: string; email: string; orgName?: string; tool: ToolName } | null;
  cursor: number;
  mergeSessions: boolean;
  mergeSessionsMap: Record<string, boolean>;
  nameField: 0 | 1;
  selectedTool: import("../types.js").ToolName;
  /** The API form's fields. The key it collects is deliberately not among them. */
  api: ApiFormState;
  message?: string;
};

type OverlayState =
  | null
  | { kind: "remove"; profileName: string; email: string; isPrimary: boolean }
  | { kind: "login"; profileName: string; email: string }
  | { kind: "sessions"; profileName: string; currentMerge: boolean };

const INIT_STEPS = [{ label: "Select" }, { label: "Name" }, { label: "Default" }, { label: "Review" }];

// ── Hint sets ──

const dashboardHints = [
  { keys: "↑↓", action: "navigate" },
  { keys: "enter", action: "open" },
  { keys: "esc", action: "quit" },
];

const doctorHintsBase = [
  { keys: "↑↓", action: "navigate" },
  { keys: "esc", action: "back" },
];

const initSelectHints = [
  { keys: "↑↓", action: "navigate" },
  { keys: "space", action: "toggle" },
  { keys: "enter", action: "confirm" },
  { keys: "esc", action: "back" },
];

const selectHints = [
  { keys: "↑↓", action: "navigate" },
  { keys: "enter", action: "select" },
  { keys: "esc", action: "back" },
];

const initReviewHints = [
  { keys: "enter", action: "apply" },
  { keys: "esc", action: "back" },
];

const addDiscoverHints = [
  { keys: "↑↓", action: "navigate" },
  { keys: "space", action: "toggle" },
  { keys: "enter", action: "register" },
  { keys: "esc", action: "back" },
];

const addInputHints = [
  { keys: "enter", action: "confirm" },
  { keys: "esc", action: "back" },
];

const initNameHints = [
  { keys: "enter", action: "confirm" },
  { keys: "↑↓", action: "switch field" },
  { keys: "esc", action: "back" },
];

/**
 * The field under the API form's cursor, or undefined when the form is not what is on screen.
 *
 * It decides two things, and both off the rendered state: which field's input handlers are
 * subscribed, and - through `inputTarget` in the App - which field typed input may land in.
 */
function apiFieldUnderCursor(screen: Screen, state: AddState | null): ApiField | undefined {
  if (screen !== "use" || state === null || state.step !== "api-form") return undefined;
  const fields = apiFormFields(state.api);
  return fields[Math.min(state.api.cursor, fields.length - 1)];
}

/** The key field's id: the one field whose input comes from the reader rather than a TextInput. */
const KEY_FIELD = "key";

/**
 * The keystrokes the App's own keys answer on the key field when ink hands one over as a whole
 * event, named: Enter, Tab, Backspace (DEL or BS) and Ctrl-U. The key field's reader leaves those
 * to them. A line feed is not among them - ink names it, but `useInput` carries no flag for it -
 * so the reader answers it, as an Enter.
 */
const APP_KEYS = new Set(["\r", "\t", "\u007f", "\u0008", "\u0015"]);

/** Whether the key field's reader holds part of something - a sequence or a paste - rather than nothing. */
function holdsPartialInput(state: SecretInputState): boolean {
  return state.pending !== "" || state.pasting;
}

/**
 * The key field's errors after a chunk of input, and the same object when nothing changed so
 * that an event which adds nothing redraws nothing.
 *
 * Text arriving answers whatever the field said before. So does the reader letting go of what
 * a refusal was about: a paste that closed with nothing after its last character still closed,
 * and "the paste never finished" under a field holding the whole key is a message that lies.
 */
function keyErrorsAfter(
  errors: Record<string, string>,
  edited: boolean,
  input: SecretInputState,
): Record<string, string> {
  const stale = edited || (errors.key === UNFINISHED_PASTE && !input.pasting);
  return stale && errors.key !== undefined ? withoutKeys(errors, KEY_FIELD) : errors;
}

const apiFormHints = [
  { keys: "↑↓/tab", action: "field" },
  { keys: "enter", action: "next" },
  { keys: "space", action: "toggle" },
  { keys: "a", action: "advanced" },
  { keys: "esc", action: "back" },
];

const overlayHints = [
  { keys: "y", action: "confirm" },
  { keys: "esc", action: "cancel" },
];

/**
 * `handler` as of the last frame React committed, behind one function that never changes -
 * for `useInput`, so the App's keys are answered with the state on screen.
 *
 * ink subscribes a `useInput` handler in an effect and subscribes it again whenever the
 * handler changes, which an inline one does every render. React runs that effect a turn of
 * the event loop after the commit that drew the frame, and a read can land in between: it was
 * answered by the handler of the frame before, with that frame's state. An Enter pressed the
 * moment "Create profile" was drawn saved the key as the frame before had it - the head of a
 * paste whose tail came in the read that brought the cursor down. Here the one function is
 * subscribed once, and what it calls is swapped in the commit itself.
 */
function useCommittedHandler<Args extends unknown[]>(handler: (...args: Args) => void): (...args: Args) => void {
  const committed = useRef(handler);
  useLayoutEffect(() => {
    committed.current = handler;
  });
  return useCallback((...args: Args) => committed.current(...args), []);
}

// ── App ──

export function App({ initialScreen = "dashboard" }: AppProps) {
  const { exit } = useApp();
  const { stdout, write } = useStdout();
  const { internal_eventEmitter: inputEvents } = useStdin();

  const [screen, setScreen] = useState<Screen>(initialScreen);
  // Force clear the console state to prevent output duplication on terminal resize.
  useEffect(() => {
    if (stdout && typeof stdout.on === "function") {
      let resizeTimer: NodeJS.Timeout;
      const onResize = () => {
        clearTimeout(resizeTimer);
        // Clear immediately to avoid partial layouts
        write("\x1b[2J\x1b[3J\x1b[H");
        resizeTimer = setTimeout(() => {
          // Tell ink to re-render
          setScreen((s) => s);
        }, 10);
      };
      stdout.on("resize", onResize);
      return () => {
        clearTimeout(resizeTimer);
        stdout.off("resize", onResize);
      };
    }
  }, [stdout, write]);
  const [profiles, setProfiles] = useState<ProfileListItem[]>([]);
  /** Registered ids, for the name check the API form runs while a name is being typed. */
  const existingProfileIds = profiles.map((profile) => profile.name);
  const [doctor, setDoctor] = useState<DoctorProfileResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [cursor, setCursor] = useState(0);
  const [message, setMessage] = useState<string>("");
  const [suspended, setSuspended] = useState(false);
  const [usagePeriod, setUsagePeriod] = useState<"today" | "week" | "month" | "all">("today");
  const [initState, setInitState] = useState<InitState>({
    step: "loading",
    accounts: [],
    selected: [],
    profileNames: {},
    cursor: 0,
    nameIndex: 0,
    nameDraft: "",
    defaultProfile: "default",
    mergeSessionsMap: {},
    nameField: 0,
  });

  const [addState, setAddState] = useState<AddState | null>(null);
  /**
   * The API key being typed, held apart from `addState` and dropped on every way out of
   * the form: submitting it, leaving the step, closing the flow, or leaving the screen.
   *
   * Apart, because `addState` is the flow's memory - it survives a step change, and the
   * form is reachable again from the method step - and a credential should not be a thing
   * this component remembers for longer than the save it was typed for. Leaving the form
   * clears it, so coming back shows an empty field rather than a mask over a value the
   * user can no longer see, check, or be sure is still the one they meant.
   */
  const [apiKey, setApiKey] = useState("");
  /**
   * How far through a terminal escape sequence the key field is. A ref, because it decides
   * what the next chunk of input means and a handler has to read it the moment it changes.
   */
  const secretInput = useRef<SecretInputState>({ ...EMPTY_SECRET_INPUT });
  /**
   * Whether that reader holds part of something: bytes parked behind a sequence introducer, or
   * a paste still open. The one thing about it the screen shows - a field holding parked bytes
   * is not empty, and saying "type or paste the key" over them invited a second paste on top.
   */
  const [keyPartial, setKeyPartial] = useState(false);
  /**
   * The API form field typed input may land in right now: the one under the cursor, or none.
   *
   * ink emits every event of a read synchronously, and every handler subscribed when the read
   * began hears all of them - including the handler of a field the cursor left earlier in the
   * same read, since handlers are only re-subscribed after the render that follows it. So an
   * arrow and a paste arriving together sent the paste to the field being left: a key drawn
   * in the Endpoint row, then stored as part of the base URL.
   *
   * Every edit path asks this first - the key's reader, every TextInput in the form, the
   * form's own keys - and an edit for any other field is dropped. Dropped, not re-routed:
   * typeahead that went nowhere is an empty field the user can see, and typeahead sent to the
   * field it was not meant for is a corrupted key, or a key on screen. A handler that moves
   * the cursor or closes the form empties it first (`releaseApiInput`), in the same call; the
   * commit that draws the new position sets it again, below.
   */
  const inputTarget = useRef<string | undefined>(undefined);
  /**
   * A bracketed paste that began while input had nowhere to go - in the read that moved the
   * cursor - is being dropped, and so is the rest of it.
   *
   * A paste is one thing, and dropping its first read is not dropping it: the tail arrives a
   * read later, when the cursor is somewhere and that field's handler is listening. Delivered
   * there it was the back half of a key, drawn in the Model row, or kept as the whole key by a
   * key field that never saw the paste begin. So everything until its closing bracket goes the
   * same way the head did. A real keystroke that moves the cursor ends it too, so a bracket
   * that never arrives does not leave every field refusing what is typed into it.
   */
  const droppingPaste = useRef(false);
  const [overlay, setOverlay] = useState<OverlayState>(null);
  const lastEscRef = useRef(0);

  const enteredDirectly = initialScreen !== "dashboard";

  function goBack() {
    if (enteredDirectly) {
      exit();
    } else {
      setMessage("");
      setCursor(0);
      setAddState(null);
      leaveApiForm();
      setOverlay(null);
      setScreen("dashboard");
    }
  }

  function resetAddState() {
    setAddState(null);
    leaveApiForm();
    setCursor(0);
  }

  async function startAddFlow() {
    leaveApiForm();
    setAddState({
      step: "loading",
      discoveredAccounts: [],
      selectedAccounts: [],
      profileNames: {},
      nameDraft: "",
      nameIndex: 0,
      importPath: "",
      importError: null,
      importAccount: null,
      cursor: 0,
      mergeSessions: false,
      mergeSessionsMap: {},
      nameField: 0,
      selectedTool: "claude",
      api: emptyApiForm(),
    });
    try {
      const discovered = await discoverAccounts();
      const registered = new Set(profiles.map((p) => p.configDir));
      const unregistered = discovered.filter((a) => !registered.has(a.configDir));
      setAddState((prev) =>
        prev
          ? {
              ...prev,
              step: "method",
              discoveredAccounts: unregistered,
              cursor: 0,
            }
          : null,
      );
    } catch {
      setAddState((prev) => (prev ? { ...prev, step: "method", discoveredAccounts: [], cursor: 0 } : null));
    }
  }

  // ── API form ──

  function updateApiForm(update: (form: ApiFormState) => ApiFormState) {
    setAddState((prev) => (prev ? { ...prev, api: update(prev.api) } : null));
  }

  /** Moves the cursor by `delta`, wrapping, over whatever fields are currently shown. */
  function moveApiCursor(delta: number) {
    releaseApiInput();
    updateApiForm((form) => {
      const length = apiFormFields(form).length;
      return { ...form, cursor: (Math.min(form.cursor, length - 1) + delta + length) % length };
    });
  }

  function toggleApiAdvanced() {
    releaseApiInput();
    updateApiForm((form) => {
      const before = apiFormFields(form);
      const currentId = before[Math.min(form.cursor, before.length - 1)]?.id;
      const next = { ...form, advancedOpen: !form.advancedOpen };
      const after = apiFormFields(next);
      // Folding takes the field under the cursor away with it, so the cursor comes back to
      // the row that folds the section rather than to whatever now sits at that index.
      const moved = after.findIndex((field) => field.id === currentId);
      next.cursor = moved === -1 ? after.findIndex((field) => field.id === "advanced") : moved;
      return next;
    });
  }

  /**
   * The key field's only writer. It is a `useState` of its own rather than part of the
   * form, so the key is never written into `addState` - it cannot be re-rendered from it,
   * saved with it, or reported in an error built from it.
   */
  function editApiKey(update: (previous: string) => string) {
    setApiKey(update);
    updateApiForm((form) => ({ ...form, errors: withoutKeys(form.errors, "key") }));
  }

  /** Drops the key and the half-read terminal input behind it, on every way out. */
  function clearApiKey() {
    setApiKey("");
    secretInput.current = { ...EMPTY_SECRET_INPUT };
    setKeyPartial(false);
  }

  /**
   * Called by every handler that moves the form's cursor, before it does: from here until the
   * render that draws the new position, typed input has nowhere it may go.
   *
   * Leaving the key field also settles its reader. Leaving is an arrow, a tab or an Enter, and
   * each interrupts a sequence still open - but the same keystroke reaches this handler and the
   * reader's, in an order that is ink's to choose (today this one first). Whichever comes first,
   * the parked bytes come out as the keystroke would have made them: the reader's version when
   * it heard it, this one when it is about to be told the input is no longer the key field's.
   */
  function releaseApiInput() {
    if (inputTarget.current === KEY_FIELD) {
      const settled = settleSecretInput(secretInput.current);
      secretInput.current = settled.state;
      setKeyPartial(holdsPartialInput(settled.state));
      if (settled.text !== "") setApiKey((previous) => previous + settled.text);
    }
    inputTarget.current = undefined;
    droppingPaste.current = false;
    clearPasteSkipped();
  }

  /**
   * Says, under the field with the cursor, that what is typed there is going nowhere because a
   * paste is being dropped, and that an arrow key ends it. Dropping everything until the paste's
   * end is safe; doing it without a word looked like a form that had stopped working.
   */
  function showPasteSkipped() {
    const field = inputTarget.current;
    if (field === undefined) return;
    setAddState((prev) =>
      !prev || prev.api.errors[field] === PASTE_SKIPPED
        ? prev
        : { ...prev, api: { ...prev.api, errors: { ...prev.api.errors, [field]: PASTE_SKIPPED } } },
    );
  }

  function clearPasteSkipped() {
    setAddState((prev) => {
      if (!prev) return null;
      const kept = Object.entries(prev.api.errors).filter(([, message]) => message !== PASTE_SKIPPED);
      if (kept.length === Object.keys(prev.api.errors).length) return prev;
      return { ...prev, api: { ...prev.api, errors: Object.fromEntries(kept) } };
    });
  }

  /** Every way out of the form: nothing typed may land in it, and the key goes with it. */
  function leaveApiForm() {
    inputTarget.current = undefined;
    droppingPaste.current = false;
    clearApiKey();
  }

  /**
   * The key field's text comes from ink's input events, not from `useInput`.
   *
   * They are the same events, one step earlier. ink's App parses a read into input events
   * and emits each one on `internal_eventEmitter`; `useInput` subscribes to that emitter and
   * *then* runs `parseKeypress`, which strips one leading ESC and hands over no flag saying
   * it did - no `code`, and `meta` false for an unnamed CSI exactly as for a typed bracket.
   * So through `useInput` a focus report `ESC [ I` and a key containing `[I` are the same
   * three characters, and both of this field's silent corruptions came from guessing which:
   * the first round appended `[I` to the key, the second reconstructed an ESC in front of
   * every `[` and `O` and ate the characters after them. `O` is an ordinary base64
   * character; there is no third guess. On the emitter the ESC is still there.
   *
   * The emitter rather than the stdin stream, which was the other way to get at the bytes
   * and is a trap: ink holds that stream in pull mode - `addListener('readable')` and
   * `while ((chunk = stdin.read()) !== null)` - so a second reader there either steals the
   * bytes ink is waiting for or depends on emit ordering that is not ours to rely on. This
   * touches no stream and no raw mode, so there is no refcount to get wrong either.
   *
   * ink also measures the sequences: an event is a run of plain text or one whole CSI or SS3,
   * with one that is still arriving held until a `setImmediate` passes with nothing more. So
   * an event's end is authoritative for those - an unfinished `ESC [` handed over on its own
   * is a keypress, and the reader is told as much (`"event"`, in prompt-secret.ts, which also
   * says what that costs). What ink does not measure is the string family - `ESC ]`, `ESC P`,
   * `ESC X`, `ESC ^`, `ESC _` arrive as a two-character event with the payload following as
   * text - and joining those across events is what `pending` is for.
   *
   * `useInput` keeps the named keys below - erase, ctrl-u, return, esc, the arrows - and
   * appends nothing, so there is exactly one writer.
   *
   * Subscribed while the form is open, or the step whose Enter opens it - not while the key
   * field has the cursor. React
   * runs passive effects a turn of the event loop after the commit that drew their frame, so a
   * listener subscribed on focus was missing for any read that landed in between: the cursor
   * was drawn on the key field and `inputTarget` said so, and nothing took the text. A paste's
   * head went nowhere, its tail was stored as the key, and the mask showed the same eight
   * bullets. Now no cursor move changes anything about the listener: `inputTarget` decides, in
   * the same call, whether an event is the key field's - the cursor can also leave in the
   * middle of a read, and this listener hears the rest of that read. A layout effect, for the
   * same reason: it is subscribed in the commit that draws the step, not a turn after it.
   *
   * It keeps `droppingPaste` too, which needs every input event while the form is open,
   * whichever field has the cursor, since a dropped paste's tail can reach any of them - and
   * the read that opens the form, whose Enter is heard on the method step. The end is taken
   * after the rest of the read, so the handlers still to hear the closing bracket - a TextInput
   * would type it as `[201~` - hear it as part of what is dropped.
   *
   * `useInput`'s handler hears an event before this listener - it is subscribed for the App's
   * whole life, this one from when the method step is drawn - and nothing depends on that. The one place
   * the two disagree, a keystroke that both ends a parked sequence and moves the cursor, is
   * settled by `releaseApiInput` whichever comes first.
   *
   * The seam is pinned in src/tui/App.test.tsx: `internal_` is a name that can change, and
   * what it would change into is a credential stored wrong and reported as success.
   */
  const fieldUnderCursor = apiFieldUnderCursor(screen, addState)?.id;
  const apiFormInReach = screen === "use" && (addState?.step === "api-form" || addState?.step === "method");
  const canReadKeyInput = typeof inputEvents?.on === "function" && typeof inputEvents?.off === "function";
  // biome-ignore lint/correctness/useExhaustiveDependencies: moveApiCursor and the paste-skipped message's functions touch only refs and state setters, so the first render's are as good as any; re-subscribing every render is the per-frame gap this listener closes
  useLayoutEffect(() => {
    if (!apiFormInReach || !canReadKeyInput) return;
    let ending: NodeJS.Immediate | undefined;
    /** The front of the end marker, handed over on its own because a slow read split it. */
    let endSoFar = "";
    function hearApiFormInput(input: string) {
      if (input === PASTE_START && inputTarget.current === undefined) {
        // A paste starting with input nowhere to go is dropped to its end - including one in the
        // rest of the read that ended a paste being dropped: that end is only taken after the
        // read, and the new paste would outlive it and land where the cursor did.
        droppingPaste.current = true;
        endSoFar = "";
        if (ending) clearImmediate(ending);
        ending = undefined;
      } else if (droppingPaste.current) {
        // ink hands over a marker a read split as pieces: the ESC alone, or `ESC [20` and then
        // text. Neither is the marker, and missing it left the drop eating everything typed.
        const marker = endSoFar + input;
        if (marker.startsWith(PASTE_END)) {
          endSoFar = "";
          ending = setImmediate(() => {
            ending = undefined;
            droppingPaste.current = false;
            clearPasteSkipped();
          });
        } else if (PASTE_END.startsWith(marker)) {
          endSoFar = marker;
        } else {
          endSoFar = "";
          showPasteSkipped();
        }
      }
      if (inputTarget.current !== KEY_FIELD || droppingPaste.current) return;
      // The writes `editApiKey` makes, inlined so that this listener depends on nothing that
      // changes every render - it is subscribed once a visit to the form, not per frame.
      //
      // A keystroke is acted on where it falls in the event. ink names Tab, Enter, Backspace or
      // Ctrl-U only when the byte is a whole event, and then the App's own keys answer it; inside
      // a run of text it is a control character nothing else sees, and dropping it appended the
      // text after it to the key - a Tab's model id, a Ctrl-U's junk still in front.
      const answeredByApp = APP_KEYS.has(input);
      let rest = input;
      let edited = false;
      for (;;) {
        const read = readSecretChunk(secretInput.current, rest, "event");
        secretInput.current = read.state;
        if (read.problem) {
          // What the field holds is not a key - where input stopped is a guess, or a paste ended
          // whose start went somewhere else - so it goes, and the message says to paste again.
          const refusal = keyReadRefusal(read.problem);
          setKeyPartial(false);
          setApiKey("");
          setAddState((prev) =>
            prev ? { ...prev, api: { ...prev.api, errors: { ...prev.api.errors, key: refusal } } } : null,
          );
          return;
        }
        if (read.text !== "") {
          setApiKey((previous) => previous + read.text);
          edited = true;
        }
        if (!read.keystroke || answeredByApp) break;
        rest = read.keystroke.rest;
        const key = read.keystroke.key;
        if (key === "erase") {
          setApiKey((previous) => previous.slice(0, -1));
          edited = true;
        } else if (key === "clear") {
          setApiKey("");
          edited = true;
        } else if (key === "enter" || key === "tab") {
          // What the named key does here: the cursor moves on. The rest of the event came after
          // the move, and is routed the way the rest of a read after an arrow is - nowhere, until
          // a frame draws where the cursor landed.
          moveApiCursor(1);
          break;
        } else if (key === "interrupt" && !read.state.pasting) {
          // Alone, ink takes it as the quit key. Inside text it quits nothing, and what comes
          // after it is not the key's either. Between a paste's brackets it is pasted data, and
          // the paste reads on - the prompt's way out of a paste that never ends is not needed
          // here, where ctrl-u alone is one.
          break;
        }
        // "end", Ctrl-D: nothing in this form is bound to it, alone or not.
      }
      setKeyPartial(holdsPartialInput(secretInput.current));
      setAddState((prev) => {
        if (!prev) return null;
        const errors = keyErrorsAfter(prev.api.errors, edited, secretInput.current);
        return errors === prev.api.errors ? prev : { ...prev, api: { ...prev.api, errors } };
      });
    }
    inputEvents.on("input", hearApiFormInput);
    return () => {
      inputEvents.off("input", hearApiFormInput);
      if (ending) clearImmediate(ending);
    };
  }, [apiFormInReach, canReadKeyInput, inputEvents]);

  // No reader at all rather than a guessing one, and the refusal is shown where the key would
  // have been typed instead of at the save, which is too late to retype anything.
  const keyFieldFocused = fieldUnderCursor === KEY_FIELD;
  useEffect(() => {
    if (!keyFieldFocused || canReadKeyInput) return;
    setAddState((prev) =>
      prev ? { ...prev, api: { ...prev.api, errors: { ...prev.api.errors, key: NO_RAW_KEY_INPUT } } } : null,
    );
  }, [keyFieldFocused, canReadKeyInput]);

  // What `inputTarget` says between handlers: the field the rendered cursor is on. A layout
  // effect, so it is set in the same commit that draws the cursor there - before any handler
  // can hear another event.
  useLayoutEffect(() => {
    inputTarget.current = fieldUnderCursor;
  });

  function editApiField(field: ApiField, edited: string) {
    // A TextInput of a field the cursor has left is still subscribed until the next render,
    // and hears the rest of the read that moved the cursor. See `inputTarget`, and
    // `droppingPaste` for the rest of a paste that read began.
    if (inputTarget.current !== field.id || droppingPaste.current) return;
    updateApiForm((form) => {
      // A masked value is not shown shrinking back into view: the first erase clears it.
      // Otherwise erasing a key from the end would draw its head once it stopped looking
      // like one.
      const value = concealsValue(field, form) && edited.length < fieldValue(field, form).length ? "" : edited;
      let next: ApiFormState = form;
      if (field.kind === "env" && field.envKey) {
        next = { ...form, env: { ...form.env, [field.envKey]: value } };
      } else if (field.id === "name") {
        next = { ...form, name: value };
      } else if (field.id === "baseUrl") {
        // The scheme follows the host until the user picks one, which is the same default
        // `clausona add --api` offers - one rule, so the two cannot disagree about a URL.
        next = { ...form, baseUrl: value, authScheme: form.authTouched ? form.authScheme : defaultAuthScheme(value) };
      } else if (field.id === "customKey") {
        next = { ...form, customKey: value };
      } else if (field.id === "customValue") {
        next = { ...form, customValue: value };
      }
      // The free-form row is one setting spread over two fields, and what is wrong with it
      // is not always wrong at the field being typed in - a name with no value belongs
      // under the value. So the row is judged as a whole and the message goes where the
      // row says. Every other field answers for itself.
      if (field.id === "customKey" || field.id === "customValue") {
        const row = customEntryError(next);
        const cleared = withoutKeys(next.errors, "customKey", "customValue");
        return { ...next, errors: row ? { ...cleared, [row.field]: row.message } : cleared };
      }
      const problem = liveApiFieldError(field, next, existingProfileIds);
      const cleared = withoutKeys(next.errors, field.id);
      return { ...next, errors: problem ? { ...cleared, [field.id]: problem } : cleared };
    });
  }

  /** Enter on the free-form row: its pair joins the env map and the row clears for another. */
  function commitCustomEntry() {
    releaseApiInput();
    updateApiForm((form) => {
      const problem = customEntryError(form);
      if (problem) return { ...form, errors: { ...form.errors, [problem.field]: problem.message } };
      const key = form.customKey.trim();
      const next: ApiFormState = {
        ...form,
        env: { ...form.env, [key]: form.customValue },
        customKey: "",
        customValue: "",
        errors: withoutKeys(form.errors, "customKey", "customValue"),
      };
      // Committing inserts a row above the free-form pair, so holding the index would
      // slide the cursor onto whatever moved into it. It goes back to the name half,
      // ready for another - chosen rather than wherever the shift happened to leave it.
      next.cursor = apiFormFields(next).findIndex((field) => field.id === "customKey");
      return next;
    });
  }

  function submitApiForm(state: AddState) {
    const form = state.api;
    const errors = validateApiForm(form, { existingIds: existingProfileIds, hasKey: apiKey.trim() !== "" });
    // The reader behind the key field still holding part of something - an open paste, a
    // sequence still arriving - or the field never having had a reader. The first two cannot
    // be reached through the keyboard now (see `keyInputRefusal`); they stay because what they
    // guard is a credential stored wrong.
    const refusal = keyInputRefusal(secretInput.current, canReadKeyInput);
    if (refusal) errors.key = refusal;
    releaseApiInput();
    if (Object.keys(errors).length > 0) {
      // A setting that is wrong while the section is folded has nowhere to be shown, so
      // the section opens rather than the form refusing to submit for an invisible reason.
      const needsAdvanced = Object.keys(errors).some((id) => id.startsWith("env:") || id.startsWith("custom"));
      const advancedOpen = form.advancedOpen || needsAdvanced;
      const fields = apiFormFields({ ...form, advancedOpen });
      const firstBad = fields.findIndex((field) => errors[field.id] !== undefined);
      updateApiForm((current) => ({
        ...current,
        errors,
        advancedOpen,
        cursor: firstBad === -1 ? current.cursor : firstBad,
      }));
      return;
    }

    const host = apiFormHost(form);
    const env = apiFormEnv(form);
    const name = form.name.trim();
    // Taken out of state before the save begins: from here the key exists only as this
    // local, for as long as the call and its failure message need it.
    const secretValue = apiKey;
    clearApiKey();
    setAddState((prev) => (prev ? { ...prev, step: "applying", api: { ...prev.api, errors: {} } } : null));
    void (async () => {
      try {
        const result = await addApiProfile({
          tool: "claude",
          name,
          baseUrl: form.baseUrl.trim(),
          authScheme: form.authScheme,
          secret: { source: "keychain" },
          secretValue,
          env,
          mergeSessions: state.mergeSessions || undefined,
        });
        setAddState((prev) =>
          prev ? { ...prev, step: "done", message: `Added ${profileId("claude", result.name)} (${host})` } : null,
        );
        await refreshDashboard();
      } catch (error) {
        setAddState((prev) =>
          prev
            ? {
                ...prev,
                step: "error",
                // Scrubbed on the way to the screen. Nothing below `addApiProfile` puts a
                // key into what it throws today, and this is what keeps that true from
                // here regardless of what changes down there.
                message: scrubSecret(error instanceof Error ? error.message : String(error), secretValue),
              }
            : null,
        );
      }
    })();
  }

  async function suspendTuiAndRun<T>(fn: () => Promise<T>): Promise<T> {
    setSuspended(true);
    // Wait a tick for Ink to render empty output before we hand over stdout
    await new Promise((r) => setTimeout(r, 50));
    process.stdin.setRawMode?.(false);
    process.stdout.write("\x1B[2J\x1B[0;0H"); // clear screen
    const result = await fn();
    process.stdout.write("\x1B[2J\x1B[0;0H"); // clear screen
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    setSuspended(false);
    return result;
  }

  async function refreshDashboard() {
    setLoading(true);
    // `detail` because the preview panel says what an API profile is - its endpoint, its
    // model, and where its key is read from. `list --json` does not ask for it.
    const [nextProfiles, nextDoctor] = await Promise.all([listProfiles({ detail: true }), doctorProfiles()]);
    setProfiles(nextProfiles);
    setDoctor(nextDoctor);
    setLoading(false);
    // No registry yet — redirect to init flow
    if (nextProfiles.length === 0 && screen !== "init") {
      setScreen("init");
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: run once on mount; refreshDashboard is recreated each render
  useEffect(() => {
    void refreshDashboard();
  }, []);

  // Quota comes from the network, so it is fetched after the dashboard paints and
  // merged in. Keyed on the profile set, not the array, so merging does not re-trigger.
  const profileKey = profiles.map((p) => p.name).join("\u0000");
  // biome-ignore lint/correctness/useExhaustiveDependencies: profiles is read via profileKey to avoid a merge loop
  useEffect(() => {
    if (profiles.length === 0) return;
    let cancelled = false;
    void (async () => {
      const quotas = await fetchProfileQuotas(profiles).catch((): Record<string, QuotaSnapshot> => ({}));
      if (cancelled) return;
      setProfiles((prev) => prev.map((p) => (quotas[p.name] ? { ...p, quota: quotas[p.name] } : p)));
    })();
    return () => {
      cancelled = true;
    };
  }, [profileKey]);

  useEffect(() => {
    if (screen === "init") {
      void (async () => {
        setInitState((prev) => ({ ...prev, step: "loading" }));
        try {
          const state = await bootstrapInitFromCurrentState();
          const selected = state.accounts.map((account) => account.configDir);
          const firstSelected = selected[0];
          setInitState({
            step: "select",
            accounts: state.accounts,
            selected,
            profileNames: state.profileNames,
            cursor: 0,
            nameIndex: 0,
            nameDraft: firstSelected ? (state.profileNames[firstSelected] ?? "") : "",
            defaultProfile: state.defaultProfile,
            mergeSessionsMap: {},
            nameField: 0,
          });
        } catch (error) {
          setInitState({
            step: "error",
            accounts: [],
            selected: [],
            profileNames: {},
            cursor: 0,
            nameIndex: 0,
            nameDraft: "",
            defaultProfile: "default",
            mergeSessionsMap: {},
            nameField: 0,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      })();
    }
  }, [screen]);

  const actions = [
    { id: "use", label: "Profiles", detail: "Switch, add, or remove accounts" },
    { id: "usage", label: "Usage", detail: "View cost and token usage" },
    { id: "init", label: "Initialize", detail: "Register discovered Claude accounts" },
    { id: "doctor", label: "Health check", detail: "Inspect profile integrity" },
    { id: "quit", label: "Quit", detail: "Exit clausona" },
  ];

  // Every key the App answers itself, as of the frame on screen: see `useCommittedHandler`.
  const handleInput = useCommittedHandler((input: string, key: Key) => {
    if (screen === "dashboard") {
      if (key.escape) {
        const now = Date.now();
        if (now - lastEscRef.current < 1500) {
          exit();
        } else {
          lastEscRef.current = now;
          setMessage("Press ESC again to quit");
        }
      } else if (key.upArrow) {
        setCursor((prev) => (prev - 1 + actions.length) % actions.length);
      } else if (key.downArrow) {
        setCursor((prev) => (prev + 1) % actions.length);
      } else if (key.return) {
        const selectedAction = actions[cursor]?.id;
        if (selectedAction === "quit") {
          exit();
        } else if (
          selectedAction === "use" ||
          selectedAction === "doctor" ||
          selectedAction === "init" ||
          selectedAction === "usage"
        ) {
          setCursor(0);
          setScreen(selectedAction);
        }
      }
      return;
    }

    if (key.escape) {
      // 1. Use screen — Add flow back-navigation
      if (screen === "use" && addState) {
        if (addState.step === "method" || addState.step === "done" || addState.step === "error") {
          resetAddState();
        } else if (addState.step === "login-tool") {
          setAddState((prev) => (prev ? { ...prev, step: "method", cursor: 0 } : null));
        } else if (addState.step === "discover-select" || addState.step === "import-path") {
          setAddState((prev) => (prev ? { ...prev, step: "method", cursor: 0 } : null));
        } else if (addState.step === "api-form") {
          // An Esc while a paste is open is held, as the arrows are below. The terminal has
          // said every byte until the closing bracket is pasted data, and the likeliest Esc
          // here is the front of that bracket, split from the rest by a slow read: acting on
          // it would leave the form and throw the key away with half of it still arriving.
          // The reader joins it to the rest of the bracket; ctrl-u is the way out of a paste
          // that really is stuck, and the message says so.
          if (inputTarget.current === KEY_FIELD && secretInput.current.pasting) {
            updateApiForm((prev) => ({ ...prev, errors: { ...prev.errors, key: UNFINISHED_PASTE } }));
            return;
          }
          // The same for a paste being dropped: its end marker split after the ESC is the same
          // Esc, and it left the form. The message says what does end the drop.
          if (droppingPaste.current) {
            showPasteSkipped();
            return;
          }
          // The key goes with the step; everything else stays, so a stray esc costs a URL
          // nobody has to retype. Coming back to a mask over a value the user can no
          // longer read is a value they cannot check, and one this component would then
          // have held for the rest of the session - so the field comes back empty, on a
          // form that is otherwise as they left it.
          //
          // So does a key anywhere else in the form. Those fields are masked while it sits in
          // them, and it does not outlive the step either.
          leaveApiForm();
          setAddState((prev) =>
            prev
              ? {
                  ...prev,
                  step: "method",
                  cursor: 0,
                  api: { ...withoutMisplacedKeys(prev.api), cursor: 0 },
                }
              : null,
          );
        } else if (addState.step === "login-name") {
          setAddState((prev) => (prev ? { ...prev, step: "login-tool", cursor: 0 } : null));
        } else if (addState.step === "discover-name") {
          setAddState((prev) => (prev ? { ...prev, step: "discover-select", cursor: 0 } : null));
        } else if (addState.step === "import-name") {
          setAddState((prev) => (prev ? { ...prev, step: "import-path", importError: null } : null));
        } else if (addState.step === "loading" || addState.step === "applying") {
          // No-op: async 작업 완료 대기
        }
        return;
      }

      // 2. Use screen — Overlay dismissal
      if (screen === "use" && overlay) {
        setOverlay(null);
        return;
      }

      // 3. Init screen — Step back
      if (screen === "init") {
        if (initState.step === "name") {
          setInitState((prev) => ({ ...prev, step: "select" }));
          return;
        } else if (initState.step === "default") {
          setInitState((prev) => ({ ...prev, step: "name", nameIndex: prev.selected.length - 1 }));
          return;
        } else if (initState.step === "review") {
          setInitState((prev) => ({ ...prev, step: "default", cursor: 0 }));
          return;
        } else if (initState.step === "loading" || initState.step === "applying") {
          return; // No-op: async 작업 완료 대기
        }
        // select/done/error → goBack() fall-through
      }

      // 4. Default (dashboard → exit, 기타 → dashboard)
      goBack();
      return;
    }

    if (screen === "use") {
      // ── Overlay handlers (remove / login confirm) ──
      if (overlay) {
        if (input === "n") {
          setOverlay(null);
          return;
        }
        if (input === "y") {
          if (overlay.kind === "remove") {
            void (async () => {
              try {
                await removeProfile(overlay.profileName);
                setOverlay(null);
                setMessage(`${symbol.check} Removed ${overlay.profileName}`);
                await refreshDashboard();
                setCursor(0);
              } catch (error) {
                setOverlay(null);
                setMessage(`${symbol.cross} ${error instanceof Error ? error.message : String(error)}`);
              }
            })();
          } else if (overlay.kind === "login") {
            void (async () => {
              try {
                setOverlay(null);
                await suspendTuiAndRun(() => loginProfile(overlay.profileName));
                setMessage(`${symbol.check} Re-login completed for ${overlay.profileName}`);
                await refreshDashboard();
              } catch (error) {
                setMessage(`${symbol.cross} ${error instanceof Error ? error.message : String(error)}`);
              }
            })();
          } else if (overlay.kind === "sessions") {
            void (async () => {
              try {
                const newMerge = !overlay.currentMerge;
                await updateProfileConfig(overlay.profileName, { mergeSessions: newMerge });
                setOverlay(null);
                setMessage(
                  `${symbol.check} ${overlay.profileName} sessions set to ${newMerge ? "merged" : "separated"}`,
                );
                await refreshDashboard();
              } catch (error) {
                setOverlay(null);
                setMessage(`${symbol.cross} ${error instanceof Error ? error.message : String(error)}`);
              }
            })();
          }
        }
        return;
      }

      // ── Add flow handlers ──
      if (addState) {
        // Method chooser
        if (addState.step === "method") {
          const methods = ADD_METHODS.map((method) => method.value);
          if (key.upArrow) {
            setAddState((prev) =>
              prev ? { ...prev, cursor: (prev.cursor - 1 + methods.length) % methods.length } : null,
            );
          } else if (key.downArrow) {
            setAddState((prev) => (prev ? { ...prev, cursor: (prev.cursor + 1) % methods.length } : null));
          } else if (key.return) {
            const selected = methods[addState.cursor];
            if (selected === "discover") {
              if (addState.discoveredAccounts.length === 0) {
                setAddState((prev) =>
                  prev ? { ...prev, step: "error", message: "No unregistered accounts found." } : null,
                );
              } else {
                const allDirs = addState.discoveredAccounts.map((a) => a.configDir);
                setAddState((prev) =>
                  prev ? { ...prev, step: "discover-select", selectedAccounts: allDirs, cursor: 0 } : null,
                );
              }
            } else if (selected === "login") {
              setAddState((prev) => (prev ? { ...prev, step: "login-tool", cursor: 0 } : null));
            } else if (selected === "import") {
              setAddState((prev) =>
                prev ? { ...prev, step: "import-path", importPath: "", importError: null } : null,
              );
            } else if (selected === "api") {
              setAddState((prev) => (prev ? { ...prev, step: "api-form", api: { ...prev.api, cursor: 0 } } : null));
            }
          }
          return;
        }

        // API endpoint form. One step with many fields rather than a step per field: the
        // cursor walks them, and nothing but Submit leaves.
        if (addState.step === "api-form") {
          const form = addState.api;
          // A paste being dropped is dropped to its end, however ink split it: an Enter or a Tab
          // it handed over alone is pasted text, and acting on it moved the cursor, which ended
          // the drop and let the rest of the paste into the next field. Only an arrow is taken as
          // a person's - a paste does not carry one - and it is what ends the drop.
          if (droppingPaste.current && !key.upArrow && !key.downArrow) {
            showPasteSkipped();
            return;
          }
          // The field under the cursor now, which is not the one in this handler's render if
          // an earlier event in the same read moved it: until a render has drawn where it
          // landed there is no field to act on - see `inputTarget`. An arrow can still move
          // on from there; anything that depends on which field this is waits for a frame.
          const current = apiFormFields(form).find((field) => field.id === inputTarget.current);
          if (current === undefined) {
            if (key.upArrow) moveApiCursor(-1);
            else if (key.downArrow || key.tab) moveApiCursor(1);
            return;
          }
          const typing = isTypingField(current);
          /**
           * A paste is open on the key field: its opening bracket arrived and its closing
           * one has not, so the terminal has said every byte until then is pasted data.
           *
           * Which means an Enter or an arrow among those bytes is data too, and whether ink
           * names one depends only on where a read happened to be split. Acting on it would
           * move the cursor off the field mid-paste, detach the reader, and type the rest of
           * the key into the next row - a plain text field that draws what it holds. So the
           * cursor stays, and the refusal that would otherwise wait until Submit is shown
           * now, because holding the cursor has to come with a way out: ctrl-u.
           */
          const openPaste = current.kind === "secret" && secretInput.current.pasting;
          if (openPaste && (key.upArrow || key.downArrow || key.tab || key.return)) {
            updateApiForm((prev) => ({ ...prev, errors: { ...prev.errors, key: UNFINISHED_PASTE } }));
            return;
          }

          if (key.upArrow) {
            moveApiCursor(-1);
            return;
          }
          if (key.downArrow || key.tab) {
            moveApiCursor(1);
            return;
          }
          // Bare letters are shortcuts only where no input has the keystrokes: on a text
          // field, `a` is the letter a.
          if (!typing && input === "a") {
            toggleApiAdvanced();
            return;
          }
          if (current.kind === "auth" && (input === " " || key.leftArrow || key.rightArrow)) {
            updateApiForm((prev) => ({
              ...prev,
              authScheme: prev.authScheme === "bearer" ? "api-key" : "bearer",
              authTouched: true,
            }));
            return;
          }
          if (current.kind === "sessions" && input === " ") {
            setAddState((prev) => (prev ? { ...prev, mergeSessions: !prev.mergeSessions } : null));
            return;
          }
          if (current.kind === "advanced" && (input === " " || key.return)) {
            toggleApiAdvanced();
            return;
          }
          // The key field is the one field with no text input behind it, because a text
          // input draws one glyph per character it holds and the length of a key is
          // something this form does not show. So the editing keys are handled here:
          // erase and kill-line. The characters themselves are not: they come from the
          // input-event listener above, which reads them before ink has edited them.
          if (current.kind === "secret" && !key.return) {
            if (key.delete || key.backspace) {
              if (apiKey.length <= 1) {
                // Erasing the last character empties the field, and an empty field is not
                // the front of anything: the half-read sequence and the open paste behind
                // it go with it. Otherwise a stray opening bracket goes on refusing the
                // save over a field that reads "not set" and has nothing left to clear.
                clearApiKey();
                updateApiForm((form) => ({ ...form, errors: withoutKeys(form.errors, "key") }));
              } else {
                editApiKey((previous) => previous.slice(0, -1));
              }
            } else if (key.ctrl && input === "u") {
              clearApiKey();
              updateApiForm((form) => ({ ...form, errors: withoutKeys(form.errors, "key") }));
            }
            return;
          }
          if (key.return) {
            if (current.kind === "submit") {
              submitApiForm(addState);
              return;
            }
            if (current.id === "customValue" && form.customKey.trim() !== "") {
              commitCustomEntry();
              return;
            }
            moveApiCursor(1);
          }
          return;
        }

        // Discover multi-select
        if (addState.step === "discover-select") {
          const len = addState.discoveredAccounts.length;
          if (key.upArrow) {
            setAddState((prev) => (prev ? { ...prev, cursor: (prev.cursor - 1 + len) % Math.max(1, len) } : null));
          } else if (key.downArrow) {
            setAddState((prev) => (prev ? { ...prev, cursor: (prev.cursor + 1) % Math.max(1, len) } : null));
          } else if (input === " ") {
            setAddState((prev) => {
              if (!prev) return null;
              const account = prev.discoveredAccounts[prev.cursor];
              if (!account) return prev;
              const selected = prev.selectedAccounts.includes(account.configDir)
                ? prev.selectedAccounts.filter((d) => d !== account.configDir)
                : [...prev.selectedAccounts, account.configDir];
              return { ...prev, selectedAccounts: selected };
            });
          } else if (key.return && addState.selectedAccounts.length > 0) {
            const first = addState.selectedAccounts[0];
            const account = addState.discoveredAccounts.find((a) => a.configDir === first);
            const defaultName = account ? defaultProfileName(account.configDir) : "profile";
            setAddState((prev) =>
              prev
                ? {
                    ...prev,
                    step: "discover-name",
                    nameIndex: 0,
                    nameDraft: defaultName,
                    profileNames: {},
                  }
                : null,
            );
          }
          return;
        }

        // Add name steps: up/down to switch field, space to toggle sessions
        if (
          (addState.step === "discover-name" || addState.step === "login-name" || addState.step === "import-name") &&
          (key.upArrow || key.downArrow)
        ) {
          setAddState((prev) => (prev ? { ...prev, nameField: prev.nameField === 0 ? 1 : 0 } : null));
          return;
        }

        if (
          (addState.step === "discover-name" || addState.step === "login-name" || addState.step === "import-name") &&
          addState.nameField === 1 &&
          input === " "
        ) {
          if (addState.step === "discover-name") {
            const currentDir = addState.selectedAccounts[addState.nameIndex];
            if (currentDir) {
              setAddState((prev) =>
                prev
                  ? {
                      ...prev,
                      mergeSessionsMap: { ...prev.mergeSessionsMap, [currentDir]: !prev.mergeSessionsMap[currentDir] },
                    }
                  : null,
              );
            }
          } else {
            setAddState((prev) => (prev ? { ...prev, mergeSessions: !prev.mergeSessions } : null));
          }
          return;
        }

        // Discover name each
        if (addState.step === "discover-name" && key.return) {
          const currentDir = addState.selectedAccounts[addState.nameIndex];
          if (!currentDir) return;
          const trimmed = addState.nameDraft.trim() || "profile";
          // Check for duplicate name
          const currentAccount = addState.discoveredAccounts.find((a) => a.configDir === currentDir);
          const currentTool = currentAccount?.tool ?? "claude";
          const newDiscoverId = profileId(currentTool, trimmed);
          if (
            profiles.some((p) => p.name === newDiscoverId) ||
            Object.values(addState.profileNames).includes(trimmed)
          ) {
            setAddState((prev) => (prev ? { ...prev, message: `Profile "${trimmed}" already exists` } : null));
            return;
          }
          const nextNames = { ...addState.profileNames, [currentDir]: trimmed };
          const nextIndex = addState.nameIndex + 1;
          if (nextIndex >= addState.selectedAccounts.length) {
            // Apply all
            setAddState((prev) => (prev ? { ...prev, profileNames: nextNames, step: "applying" } : null));
            void (async () => {
              try {
                for (const [dir, name] of Object.entries(nextNames)) {
                  const merge = addState.mergeSessionsMap[dir] || undefined;
                  const account = addState.discoveredAccounts.find((a) => a.configDir === dir);
                  const tool = account?.tool ?? "claude";
                  await addProfile({ tool, name, fromPath: dir, mergeSessions: merge });
                }
                setAddState((prev) =>
                  prev ? { ...prev, step: "done", message: `Added ${Object.keys(nextNames).length} profile(s)` } : null,
                );
                await refreshDashboard();
              } catch (error) {
                setAddState((prev) =>
                  prev
                    ? { ...prev, step: "error", message: error instanceof Error ? error.message : String(error) }
                    : null,
                );
              }
            })();
          } else {
            const nextDir = addState.selectedAccounts[nextIndex];
            const nextAccount = addState.discoveredAccounts.find((a) => a.configDir === nextDir);
            const nextDefault = nextAccount ? defaultProfileName(nextAccount.configDir) : "profile";
            setAddState((prev) =>
              prev
                ? {
                    ...prev,
                    profileNames: nextNames,
                    nameIndex: nextIndex,
                    nameField: 0,
                    nameDraft: nextDefault,
                    message: undefined,
                  }
                : null,
            );
          }
          return;
        }

        // Login tool picker
        if (addState.step === "login-tool") {
          const tools = ["claude", "codex"] as const;
          if (key.upArrow) {
            setAddState((prev) => (prev ? { ...prev, cursor: (prev.cursor - 1 + tools.length) % tools.length } : null));
          } else if (key.downArrow) {
            setAddState((prev) => (prev ? { ...prev, cursor: (prev.cursor + 1) % tools.length } : null));
          } else if (key.return) {
            const tool = tools[addState.cursor];
            setAddState((prev) => (prev ? { ...prev, selectedTool: tool, step: "login-name", nameDraft: "" } : null));
          }
          return;
        }

        // Login name
        if (addState.step === "login-name" && key.return) {
          const name = addState.nameDraft.trim();
          if (!name) return;
          const newLoginId = profileId(addState.selectedTool, name);
          if (profiles.some((p) => p.name === newLoginId)) {
            setAddState((prev) => (prev ? { ...prev, message: `Profile "${name}" already exists` } : null));
            return;
          }
          setAddState((prev) => (prev ? { ...prev, step: "applying" } : null));
          void (async () => {
            try {
              const result = await suspendTuiAndRun(() =>
                addProfile({ tool: addState.selectedTool, name, mergeSessions: addState.mergeSessions || undefined }),
              );
              setAddState((prev) =>
                prev ? { ...prev, step: "done", message: `Added ${result.name} (${result.email})` } : null,
              );
              await refreshDashboard();
            } catch (error) {
              setAddState((prev) =>
                prev
                  ? { ...prev, step: "error", message: error instanceof Error ? error.message : String(error) }
                  : null,
              );
            }
          })();
          return;
        }

        // Import path
        if (addState.step === "import-path" && key.return) {
          const inputPath = addState.importPath.trim();
          if (!inputPath) return;
          void (async () => {
            const result = await validateConfigDir(
              inputPath,
              profiles.map((p) => p.configDir),
            );
            if ("error" in result) {
              setAddState((prev) => (prev ? { ...prev, importError: result.error } : null));
            } else {
              const defaultName = defaultProfileName(result.account.configDir);
              setAddState((prev) =>
                prev
                  ? {
                      ...prev,
                      step: "import-name",
                      importAccount: result.account,
                      nameDraft: defaultName,
                      importError: null,
                    }
                  : null,
              );
            }
          })();
          return;
        }

        // Import name
        if (addState.step === "import-name" && key.return) {
          const name = addState.nameDraft.trim();
          if (!name || !addState.importAccount) return;
          const newImportId = profileId(addState.importAccount.tool, name);
          if (profiles.some((p) => p.name === newImportId)) {
            setAddState((prev) => (prev ? { ...prev, message: `Profile "${name}" already exists` } : null));
            return;
          }
          setAddState((prev) => (prev ? { ...prev, step: "applying" } : null));
          void (async () => {
            try {
              const result = await addProfile({
                tool: addState.importAccount?.tool ?? "claude",
                name,
                fromPath: addState.importAccount?.configDir,
                mergeSessions: addState.mergeSessions || undefined,
              });
              setAddState((prev) =>
                prev ? { ...prev, step: "done", message: `Added ${result.name} (${result.email})` } : null,
              );
              await refreshDashboard();
            } catch (error) {
              setAddState((prev) =>
                prev
                  ? { ...prev, step: "error", message: error instanceof Error ? error.message : String(error) }
                  : null,
              );
            }
          })();
          return;
        }

        // Done - press any key to return
        if (addState.step === "done" && key.return) {
          resetAddState();
          return;
        }

        // Error - press any key to go back to method
        if (addState.step === "error") {
          if (key.return || input === "r") {
            setAddState((prev) => (prev ? { ...prev, step: "method", cursor: 0, message: undefined } : null));
          }
          return;
        }

        return;
      }

      // ── Default profile list handlers ──
      if (key.upArrow) {
        setCursor((prev) => (prev - 1 + profiles.length) % Math.max(1, profiles.length));
      } else if (key.downArrow) {
        setCursor((prev) => (prev + 1) % Math.max(1, profiles.length));
      } else if (key.return && profiles[cursor]) {
        void (async () => {
          const profile = profiles[cursor];
          await setActiveProfileByName(profile.name);
          if (enteredDirectly) {
            process.stdout.write(`${symbol.check} Switched to ${profile.name} (${displayName(profile)})\n`);
            exit();
          } else {
            setMessage(`${symbol.check} Switched to ${profile.name}`);
            await refreshDashboard();
            setCursor(0);
            setScreen("dashboard");
          }
        })();
      } else if (input === "a") {
        void startAddFlow();
      } else if (input === "d" && profiles[cursor]) {
        const p = profiles[cursor];
        setOverlay({ kind: "remove", profileName: p.name, email: p.email, isPrimary: p.isPrimary });
      } else if (input === "l" && profiles[cursor]) {
        const p = profiles[cursor];
        if (!p.isPrimary) {
          setOverlay({ kind: "login", profileName: p.name, email: displayName(p) });
        }
      } else if (input === "s" && profiles[cursor] && !profiles[cursor].isPrimary) {
        const p = profiles[cursor];
        setOverlay({ kind: "sessions", profileName: p.name, currentMerge: p.mergeSessions ?? false });
      }
      return;
    }

    if (screen === "usage") {
      const periods = ["today", "week", "month", "all"] as const;
      const idx = periods.indexOf(usagePeriod);
      if (key.leftArrow || key.upArrow) {
        setUsagePeriod(periods[(idx - 1 + periods.length) % periods.length]);
      } else if (key.rightArrow || key.downArrow) {
        setUsagePeriod(periods[(idx + 1) % periods.length]);
      }
      return;
    }

    if (screen === "doctor") {
      if (key.upArrow) {
        setCursor((prev) => (prev - 1 + doctor.length) % Math.max(1, doctor.length));
      } else if (key.downArrow) {
        setCursor((prev) => (prev + 1) % Math.max(1, doctor.length));
      } else if (input === "r" && doctor[cursor] && !doctor[cursor].healthy && !doctor[cursor].isPrimary) {
        const d = doctor[cursor];
        void (async () => {
          try {
            await repairProfile(d.name);
            const freshDoctor = await doctorProfiles();
            setDoctor(freshDoctor);
            const fixed = freshDoctor.find((dd) => dd.name === d.name);
            setMessage(
              fixed?.healthy
                ? `${symbol.check} ${d.name} repaired — all issues resolved`
                : `${symbol.diamond} ${d.name} repaired — ${fixed?.issues.length ?? 0} issue(s) remaining`,
            );
          } catch (error) {
            setMessage(`${symbol.cross} ${error instanceof Error ? error.message : String(error)}`);
          }
        })();
      }
      return;
    }

    if (screen === "init") {
      if (initState.step === "select") {
        if (key.upArrow) {
          setInitState((prev) => ({
            ...prev,
            cursor: (prev.cursor - 1 + prev.accounts.length) % Math.max(1, prev.accounts.length),
          }));
        } else if (key.downArrow) {
          setInitState((prev) => ({
            ...prev,
            cursor: (prev.cursor + 1) % Math.max(1, prev.accounts.length),
          }));
        } else if (input === " ") {
          setInitState((prev) => {
            const account = prev.accounts[prev.cursor];
            if (!account) return prev;
            const selected = prev.selected.includes(account.configDir)
              ? prev.selected.filter((value) => value !== account.configDir)
              : [...prev.selected, account.configDir];
            return { ...prev, selected };
          });
        } else if (key.return && initState.selected.length > 0) {
          const first = initState.selected[0];
          setInitState((prev) => ({
            ...prev,
            step: "name",
            nameIndex: 0,
            nameDraft: prev.profileNames[first] ?? "",
          }));
        }
        return;
      }

      if (initState.step === "name" && (key.upArrow || key.downArrow)) {
        const currentConfig = initState.selected[initState.nameIndex];
        const account = initState.accounts.find((a) => a.configDir === currentConfig);
        if (account && !account.isPrimary) {
          setInitState((prev) => ({ ...prev, nameField: prev.nameField === 0 ? 1 : 0 }));
        }
        return;
      }

      if (initState.step === "name" && initState.nameField === 1 && input === " ") {
        const currentConfig = initState.selected[initState.nameIndex];
        if (currentConfig) {
          setInitState((prev) => ({
            ...prev,
            mergeSessionsMap: {
              ...prev.mergeSessionsMap,
              [currentConfig]: !prev.mergeSessionsMap[currentConfig],
            },
          }));
        }
        return;
      }

      if (initState.step === "name" && key.return) {
        const currentConfig = initState.selected[initState.nameIndex];
        if (!currentConfig) return;
        const nextNames = {
          ...initState.profileNames,
          [currentConfig]: initState.nameDraft.trim() || "profile",
        };
        const nextIndex = initState.nameIndex + 1;
        if (nextIndex >= initState.selected.length) {
          setInitState((prev) => ({
            ...prev,
            profileNames: nextNames,
            step: "default",
            cursor: 0,
            defaultProfile: nextNames[prev.selected[0]] ?? "default",
          }));
        } else {
          const nextConfig = initState.selected[nextIndex];
          setInitState((prev) => ({
            ...prev,
            profileNames: nextNames,
            nameIndex: nextIndex,
            nameField: 0,
            nameDraft: nextNames[nextConfig] ?? "",
          }));
        }
        return;
      }

      if (initState.step === "default") {
        if (key.upArrow) {
          setInitState((prev) => ({
            ...prev,
            cursor: (prev.cursor - 1 + prev.selected.length) % Math.max(1, prev.selected.length),
          }));
        } else if (key.downArrow) {
          setInitState((prev) => ({
            ...prev,
            cursor: (prev.cursor + 1) % Math.max(1, prev.selected.length),
          }));
        } else if (key.return) {
          const selectedConfig = initState.selected[initState.cursor];
          if (!selectedConfig) return;
          setInitState((prev) => ({
            ...prev,
            defaultProfile: prev.profileNames[selectedConfig] ?? "default",
            step: "review",
          }));
        }
        return;
      }

      if (initState.step === "review" && key.return) {
        void (async () => {
          setInitState((prev) => ({ ...prev, step: "applying" }));
          try {
            const selectedAccounts = initState.accounts.filter((account) =>
              initState.selected.includes(account.configDir),
            );
            await initializeRegistry({
              accounts: selectedAccounts,
              profileNames: initState.profileNames,
              defaultProfile: initState.defaultProfile,
              mergeSessionsMap: initState.mergeSessionsMap,
            });
            setInitState((prev) => ({ ...prev, step: "done" }));
            setMessage(`${symbol.check} Profiles initialized`);
            await refreshDashboard();
          } catch (error) {
            setInitState((prev) => ({
              ...prev,
              step: "error",
              message: error instanceof Error ? error.message : String(error),
            }));
          }
        })();
      } else if (initState.step === "done" && key.return) {
        if (enteredDirectly) {
          exit();
        } else {
          setMessage(`${symbol.check} Profiles initialized`);
          setCursor(0);
          setScreen("dashboard");
        }
      }
    }
  });
  useInput(handleInput);

  // ── Screens ──

  // TUI suspended for interactive child process (e.g. OAuth login)
  if (suspended) {
    return null;
  }

  // Loading
  if (loading && screen !== "init") {
    return (
      <Chrome title="Loading" hints={[]}>
        <Spinner label="Reading clausona state..." />
      </Chrome>
    );
  }

  // ── Dashboard ──
  if (screen === "dashboard") {
    const activeProfile = profiles.find((p) => p.isActive) ?? profiles[0];
    return (
      <Chrome title="Dashboard" footer={message || undefined} hints={dashboardHints}>
        <Box gap={2} flexDirection="row" width="100%">
          <Box
            flexDirection="column"
            width="50%"
            minWidth={1}
            flexShrink={0}
            borderStyle="round"
            borderColor={color.dim}
            paddingX={1}
            paddingY={0}
          >
            <SelectList items={actions} index={cursor} />
          </Box>
          <Box flexGrow={1} flexShrink={1} minWidth={1} overflow="hidden">
            <ProfilePreview
              profile={activeProfile}
              doctor={activeProfile ? doctor.find((d) => d.name === activeProfile.name) : undefined}
            />
          </Box>
        </Box>
      </Chrome>
    );
  }

  // ── Profiles (extended "use" screen) ──
  if (screen === "use") {
    // ── Add flow screens ──
    if (addState) {
      if (addState.step === "loading") {
        return (
          <Chrome title="Add Profile" hints={[]}>
            <Spinner label="Scanning for unregistered accounts..." />
          </Chrome>
        );
      }

      if (addState.step === "applying") {
        return (
          <Chrome title="Add Profile" hints={[]}>
            <Spinner label="Registering profile..." />
          </Chrome>
        );
      }

      if (addState.step === "error") {
        return (
          <Chrome
            title="Add Profile"
            hints={[
              { keys: "r", action: "retry" },
              { keys: "esc", action: "back" },
            ]}
          >
            <Box flexDirection="column" gap={1} borderStyle="round" borderColor={color.error} paddingX={2} paddingY={1}>
              <Box gap={1}>
                <Text color={color.error}>{symbol.cross}</Text>
                <Text color={color.error}>{addState.message}</Text>
              </Box>
            </Box>
          </Chrome>
        );
      }

      if (addState.step === "done") {
        return (
          <Chrome title="Add Profile" hints={[{ keys: "enter", action: "done" }]}>
            <Box
              flexDirection="column"
              gap={1}
              borderStyle="round"
              borderColor={color.healthy}
              paddingX={2}
              paddingY={1}
            >
              <Box gap={1}>
                <Text color={color.healthy}>{symbol.check}</Text>
                <Text color={color.healthy} bold>
                  {addState.message}
                </Text>
              </Box>
            </Box>
          </Chrome>
        );
      }

      if (addState.step === "method") {
        const found = addState.discoveredAccounts.length;
        const methods: SelectListItem[] = ADD_METHODS.map((method) => ({
          id: method.value,
          label: method.label,
          detail: method.hint,
          ...(method.value === "discover"
            ? {
                badge: found > 0 ? `${found} found` : "none",
                badgeVariant: found > 0 ? ("primary" as const) : ("muted" as const),
              }
            : {}),
        }));
        return (
          <Chrome title="Add Profile" subtitle="Choose how to add" hints={selectHints}>
            <Box flexDirection="column" borderStyle="round" borderColor={color.dim} paddingX={2} paddingY={1}>
              <SelectList items={methods} index={addState.cursor} />
            </Box>
          </Chrome>
        );
      }

      if (addState.step === "api-form") {
        return (
          <Chrome title="Add Profile" subtitle="API endpoint" hints={apiFormHints}>
            <ApiForm
              form={addState.api}
              fields={apiFormFields(addState.api)}
              keySet={apiKey !== "" || keyPartial}
              mergeSessions={addState.mergeSessions}
              onChange={editApiField}
            />
          </Chrome>
        );
      }

      if (addState.step === "discover-select") {
        const currentAccount = addState.discoveredAccounts[addState.cursor];
        return (
          <Chrome title="Add Profile" subtitle="Discover" hints={addDiscoverHints}>
            <Box gap={2} flexDirection="row" width="100%">
              <Box
                flexDirection="column"
                width="50%"
                minWidth={1}
                flexShrink={0}
                borderStyle="round"
                borderColor={color.dim}
                paddingX={1}
                paddingY={0}
              >
                <Text color={color.secondary}>Select accounts to register:</Text>
                <SelectList
                  multi
                  items={addState.discoveredAccounts.map((a) => ({
                    id: a.configDir,
                    label: a.configDir.replace(homedir(), "~"),
                    detail: a.email,
                    selected: addState.selectedAccounts.includes(a.configDir),
                  }))}
                  index={addState.cursor}
                />
              </Box>
              <Box
                flexGrow={1}
                flexShrink={1}
                minWidth={1}
                borderStyle="round"
                borderColor={color.dim}
                paddingX={1}
                flexDirection="column"
                overflow="hidden"
              >
                {currentAccount ? (
                  <>
                    <Text color={color.text} bold>
                      {currentAccount.configDir.replace(homedir(), "~")}
                    </Text>
                    <Text color={color.secondary}>{currentAccount.email}</Text>
                    {currentAccount.orgName && <Text color={color.muted}>{currentAccount.orgName}</Text>}
                    <Box marginTop={1} gap={1}>
                      <Text color={color.healthy}>{symbol.check}</Text>
                      <Text color={color.secondary}>Credentials verified</Text>
                    </Box>
                  </>
                ) : (
                  <Text color={color.muted}>No accounts found.</Text>
                )}
              </Box>
            </Box>
          </Chrome>
        );
      }

      if (addState.step === "discover-name") {
        const currentDir = addState.selectedAccounts[addState.nameIndex];
        const account = addState.discoveredAccounts.find((a) => a.configDir === currentDir);
        const isMerged = addState.mergeSessionsMap[currentDir ?? ""];
        return (
          <Chrome title="Add Profile" subtitle="Name" hints={initNameHints}>
            <Box flexDirection="column" gap={1} borderStyle="round" borderColor={color.dim} paddingX={2} paddingY={1}>
              <Text color={color.secondary}>
                Profile {addState.nameIndex + 1} of {addState.selectedAccounts.length}
              </Text>
              <Box flexDirection="column">
                <Box gap={1}>
                  <Text color={color.muted}>Account </Text>
                  <Text color={color.text}>{account?.email}</Text>
                </Box>
                <Box gap={1}>
                  <Text color={color.muted}>Config </Text>
                  <Text color={color.secondary}>{currentDir?.replace(homedir(), "~")}</Text>
                </Box>
              </Box>
              {addState.message && (
                <Box gap={1}>
                  <Text color={color.error}>{symbol.cross}</Text>
                  <Text color={color.error}>{addState.message}</Text>
                </Box>
              )}
              <Box gap={1}>
                <Text color={addState.nameField === 0 ? color.cursor : color.dim}>
                  {addState.nameField === 0 ? symbol.cursor : " "}
                </Text>
                <Text color={color.text}>Name: </Text>
                <TextInput
                  value={addState.nameDraft}
                  onChange={(value) =>
                    setAddState((prev) => (prev ? { ...prev, nameDraft: value, message: undefined } : null))
                  }
                  focus={addState.nameField === 0}
                />
              </Box>
              <Box gap={1}>
                <Text color={addState.nameField === 1 ? color.cursor : color.dim}>
                  {addState.nameField === 1 ? symbol.cursor : " "}
                </Text>
                <Text color={color.text}>Sessions: </Text>
                <Text color={isMerged ? color.warning : color.text}>{isMerged ? "merged" : "separated"}</Text>
                {addState.nameField === 1 && <Text color={color.muted}> (space to toggle)</Text>}
              </Box>
            </Box>
          </Chrome>
        );
      }

      if (addState.step === "login-tool") {
        const tools = ["claude", "codex"] as const;
        return (
          <Chrome title="Add Profile" subtitle="Choose tool" hints={selectHints}>
            <Box flexDirection="column" borderStyle="round" borderColor={color.dim} paddingX={2} paddingY={1}>
              <SelectList
                items={tools.map((tool, i) => ({
                  id: tool,
                  label: tool,
                  detail: tool === "claude" ? "Claude by Anthropic" : "Codex by OpenAI",
                  selected: i === addState.cursor,
                }))}
                index={addState.cursor}
              />
            </Box>
          </Chrome>
        );
      }

      if (addState.step === "login-name") {
        return (
          <Chrome title="Add Profile" subtitle="Login as new account" hints={initNameHints}>
            <Box flexDirection="column" gap={1} borderStyle="round" borderColor={color.dim} paddingX={2} paddingY={1}>
              <Text color={color.secondary}>
                Enter a name for the new profile. OAuth login will open in your browser.
              </Text>
              {addState.message && (
                <Box gap={1}>
                  <Text color={color.error}>{symbol.cross}</Text>
                  <Text color={color.error}>{addState.message}</Text>
                </Box>
              )}
              <Box gap={1}>
                <Text color={addState.nameField === 0 ? color.cursor : color.dim}>
                  {addState.nameField === 0 ? symbol.cursor : " "}
                </Text>
                <Text color={color.text}>Name: </Text>
                <TextInput
                  value={addState.nameDraft}
                  onChange={(value) =>
                    setAddState((prev) => (prev ? { ...prev, nameDraft: value, message: undefined } : null))
                  }
                  focus={addState.nameField === 0}
                />
              </Box>
              <Box gap={1}>
                <Text color={addState.nameField === 1 ? color.cursor : color.dim}>
                  {addState.nameField === 1 ? symbol.cursor : " "}
                </Text>
                <Text color={color.text}>Sessions: </Text>
                <Text color={addState.mergeSessions ? color.warning : color.text}>
                  {addState.mergeSessions ? "merged" : "separated"}
                </Text>
                {addState.nameField === 1 && <Text color={color.muted}> (space to toggle)</Text>}
              </Box>
            </Box>
          </Chrome>
        );
      }

      if (addState.step === "import-path") {
        return (
          <Chrome title="Add Profile" subtitle="Import from path" hints={addInputHints}>
            <Box flexDirection="column" gap={1} borderStyle="round" borderColor={color.dim} paddingX={2} paddingY={1}>
              <Text color={color.secondary}>Enter the config directory path:</Text>
              <Box gap={1}>
                <Text color={color.cursor}>{symbol.cursor}</Text>
                <Text color={color.text}>Path: </Text>
                <TextInput
                  value={addState.importPath}
                  onChange={(value) =>
                    setAddState((prev) => (prev ? { ...prev, importPath: value, importError: null } : null))
                  }
                />
              </Box>
              {addState.importError ? (
                <Box gap={1}>
                  <Text color={color.error}>{symbol.cross}</Text>
                  <Text color={color.error}>{addState.importError}</Text>
                </Box>
              ) : (
                <Text color={color.muted}>
                  Expects a directory containing .claude.json with valid oauthAccount credentials.
                </Text>
              )}
            </Box>
          </Chrome>
        );
      }

      if (addState.step === "import-name") {
        return (
          <Chrome title="Add Profile" subtitle="Name the imported profile" hints={initNameHints}>
            <Box flexDirection="column" gap={1} borderStyle="round" borderColor={color.dim} paddingX={2} paddingY={1}>
              <Box flexDirection="column">
                <Box gap={1}>
                  <Text color={color.muted}>Account </Text>
                  <Text color={color.text}>{addState.importAccount?.email}</Text>
                </Box>
                <Box gap={1}>
                  <Text color={color.muted}>Config </Text>
                  <Text color={color.secondary}>{addState.importAccount?.configDir.replace(homedir(), "~")}</Text>
                </Box>
              </Box>
              {addState.message && (
                <Box gap={1}>
                  <Text color={color.error}>{symbol.cross}</Text>
                  <Text color={color.error}>{addState.message}</Text>
                </Box>
              )}
              <Box gap={1}>
                <Text color={addState.nameField === 0 ? color.cursor : color.dim}>
                  {addState.nameField === 0 ? symbol.cursor : " "}
                </Text>
                <Text color={color.text}>Name: </Text>
                <TextInput
                  value={addState.nameDraft}
                  onChange={(value) =>
                    setAddState((prev) => (prev ? { ...prev, nameDraft: value, message: undefined } : null))
                  }
                  focus={addState.nameField === 0}
                />
              </Box>
              <Box gap={1}>
                <Text color={addState.nameField === 1 ? color.cursor : color.dim}>
                  {addState.nameField === 1 ? symbol.cursor : " "}
                </Text>
                <Text color={color.text}>Sessions: </Text>
                <Text color={addState.mergeSessions ? color.warning : color.text}>
                  {addState.mergeSessions ? "merged" : "separated"}
                </Text>
                {addState.nameField === 1 && <Text color={color.muted}> (space to toggle)</Text>}
              </Box>
            </Box>
          </Chrome>
        );
      }
    }

    // ── Profiles list with optional overlay ──
    const selectedProfile = profiles[cursor];
    const profilesHints = [
      { keys: "↑↓", action: "nav" },
      { keys: "enter", action: "switch" },
      { keys: "a", action: "add" },
      ...(selectedProfile && !selectedProfile.isPrimary
        ? [
            { keys: "d", action: "remove" },
            { keys: "l", action: "re-login" },
            { keys: "s", action: "sessions" },
          ]
        : []),
      { keys: "esc", action: "back" },
    ];

    return (
      <Chrome
        title="Profiles"
        subtitle={message || "Select a profile to manage"}
        hints={overlay ? overlayHints : profilesHints}
      >
        <Box gap={2} flexDirection="row" width="100%">
          <Box
            flexDirection="column"
            width="50%"
            minWidth={1}
            flexShrink={0}
            borderStyle="round"
            borderColor={color.dim}
            paddingX={1}
            paddingY={0}
          >
            <SelectList
              items={profiles.map((p) => ({
                id: p.name,
                label: p.name,
                // An API profile has no account email; its label, as everywhere else.
                detail: displayName(p),
                badge: p.isActive ? "active" : undefined,
                badgeVariant: p.isActive ? ("active" as const) : undefined,
                meta: formatQuotaInline(p.quota),
                metaVariant: quotaSeverity(p.quota),
              }))}
              index={cursor}
            />
          </Box>
          <Box
            flexGrow={1}
            flexShrink={1}
            minWidth={1}
            borderStyle="round"
            borderColor={color.dim}
            paddingX={1}
            flexDirection="column"
            overflow="hidden"
          >
            <ProfilePreview profile={profiles[cursor]} doctor={doctor.find((d) => d.name === profiles[cursor]?.name)} />
          </Box>
        </Box>
        {overlay?.kind === "remove" && (
          <Box
            flexDirection="column"
            borderStyle="round"
            borderColor={overlay.isPrimary ? color.error : color.warning}
            paddingX={2}
            paddingY={1}
            marginTop={1}
          >
            {overlay.isPrimary ? (
              <>
                <Box gap={1}>
                  <Text color={color.error}>{symbol.cross}</Text>
                  <Text color={color.error}>Cannot remove the primary profile.</Text>
                </Box>
                <Text color={color.muted} dimColor>
                  Press esc to dismiss.
                </Text>
              </>
            ) : (
              <>
                <Text color={color.text} bold>
                  Remove &quot;{overlay.profileName}&quot;?
                </Text>
                <Text color={color.secondary}>This will unregister the profile and clean up associated files.</Text>
                <Box marginTop={1} gap={2}>
                  <Text color={color.warning}>y confirm</Text>
                  <Text color={color.muted}>esc cancel</Text>
                </Box>
              </>
            )}
          </Box>
        )}
        {overlay?.kind === "login" && (
          <Box
            flexDirection="column"
            borderStyle="round"
            borderColor={color.brand}
            paddingX={2}
            paddingY={1}
            marginTop={1}
          >
            <Text color={color.text} bold>
              Re-login &quot;{overlay.profileName}&quot;?
            </Text>
            <Text color={color.secondary}>
              This will open your browser to re-authenticate the OAuth token for {overlay.email}.
            </Text>
            <Text color={color.muted}>The TUI will be suspended during login.</Text>
            <Box marginTop={1} gap={2}>
              <Text color={color.brand}>y proceed</Text>
              <Text color={color.muted}>esc cancel</Text>
            </Box>
          </Box>
        )}
        {overlay?.kind === "sessions" && (
          <Box
            flexDirection="column"
            borderStyle="round"
            borderColor={color.brand}
            paddingX={2}
            paddingY={1}
            marginTop={1}
          >
            <Text color={color.text} bold>
              Change sessions for &quot;{overlay.profileName}&quot;?
            </Text>
            <Text color={color.secondary}>
              {overlay.currentMerge
                ? "Sessions will be isolated from the primary profile."
                : "Sessions will be shared with the primary profile."}
            </Text>
            <Box gap={1}>
              <Text color={color.muted}>Current:</Text>
              <Text color={overlay.currentMerge ? color.warning : color.text}>
                {overlay.currentMerge ? "merged" : "separated"}
              </Text>
              <Text color={color.muted}>{symbol.arrow}</Text>
              <Text color={!overlay.currentMerge ? color.warning : color.text}>
                {overlay.currentMerge ? "separated" : "merged"}
              </Text>
            </Box>
            <Box marginTop={1} gap={2}>
              <Text color={color.brand}>y confirm</Text>
              <Text color={color.muted}>esc cancel</Text>
            </Box>
          </Box>
        )}
      </Chrome>
    );
  }

  // ── Doctor ──
  if (screen === "doctor") {
    const currentDoctor = doctor[cursor];
    const doctorHints = [
      ...doctorHintsBase,
      ...(currentDoctor && !currentDoctor.healthy && !currentDoctor.isPrimary ? [{ keys: "r", action: "repair" }] : []),
    ];
    return (
      <Chrome title="Health Check" subtitle="Inspect profile integrity and symlink status" hints={doctorHints}>
        <Box gap={2} flexDirection="row" width="100%">
          <Box
            flexDirection="column"
            width="50%"
            minWidth={1}
            flexShrink={0}
            borderStyle="round"
            borderColor={color.dim}
            paddingX={1}
            paddingY={0}
          >
            <SelectList
              items={doctor.map((r) => ({
                id: r.name,
                label: r.name,
                detail: r.email,
                // A warning leaves the profile healthy, but "healthy" alone would hide it
                // from the only column this list has - and colouring by `healthy` painted a
                // profile reading "2 warnings" emerald green. Both come from the one rule.
                badge: doctorSummary(r.issues),
                badgeVariant: doctorSeverity(r.issues),
              }))}
              index={cursor}
            />
          </Box>
          <Box
            flexGrow={1}
            flexShrink={1}
            minWidth={1}
            borderStyle="round"
            borderColor={color.dim}
            paddingX={1}
            flexDirection="column"
            overflow="hidden"
          >
            {currentDoctor ? (
              <>
                <Box gap={1}>
                  <Text color={color.text} bold>
                    {currentDoctor.name}
                  </Text>
                  <Text color={currentDoctor.healthy ? color.healthy : color.warning}>
                    {currentDoctor.healthy ? symbol.check : symbol.diamond}
                  </Text>
                </Box>
                <Text color={color.secondary}>{currentDoctor.email}</Text>
                <Text color={color.muted}>{currentDoctor.configDir.replace(/^\/Users\/[^/]+/, "~")}</Text>
                {currentDoctor.issues.length > 0 && (
                  <Box flexDirection="column" marginTop={1}>
                    <Divider title="Issues" />
                    {currentDoctor.issues.map((issue) => (
                      <Box key={issue.message} gap={1}>
                        <Text color={color.warning}>{symbol.arrow}</Text>
                        <Text color={color.secondary}>{issue.message}</Text>
                      </Box>
                    ))}
                  </Box>
                )}
                {currentDoctor.issues.length === 0 && (
                  // Not `healthy`: a profile with warnings is healthy, and claiming every
                  // check passed directly under a list of findings is a plain contradiction.
                  <Box marginTop={1}>
                    <Text color={color.healthy}>{symbol.check} All checks passed</Text>
                  </Box>
                )}
              </>
            ) : (
              <Text color={color.muted}>No profiles found.</Text>
            )}
          </Box>
        </Box>
        {message && (
          <Box marginTop={1} gap={1}>
            <Text color={color.secondary}>{message}</Text>
          </Box>
        )}
      </Chrome>
    );
  }

  // ── Usage ──
  if (screen === "usage") {
    const periodLabels = { today: "Today", week: "This week", month: "This month", all: "All time" } as const;
    const periodKeys = ["today", "week", "month", "all"] as const;

    const formatDate = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const now = new Date();
    const todayStr = formatDate(now);

    const periodRange = (() => {
      if (usagePeriod === "today") return todayStr;
      if (usagePeriod === "all") return "";
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      if (usagePeriod === "week") {
        const day = start.getDay();
        start.setDate(start.getDate() - (day === 0 ? 6 : day - 1));
      } else {
        start.setDate(1);
      }
      return `${formatDate(start)} ~ ${todayStr}`;
    })();

    const getData = (p: ProfileListItem) => {
      switch (usagePeriod) {
        case "today":
          return p.today;
        case "week":
          return p.week;
        case "month":
          return p.month;
        case "all":
          return p.total;
      }
    };

    return (
      <Chrome
        title="Usage"
        hints={[
          { keys: "←→", action: "period" },
          { keys: "esc", action: "back" },
        ]}
      >
        <Box flexDirection="column" gap={1} borderStyle="round" borderColor={color.dim} paddingX={2} paddingY={1}>
          {/* Period tabs */}
          <Box gap={1} flexWrap="wrap">
            {periodKeys.map((pk) => (
              <Text key={pk} color={pk === usagePeriod ? color.brand : color.muted} bold={pk === usagePeriod}>
                {pk === usagePeriod ? `[${periodLabels[pk]}]` : ` ${periodLabels[pk]} `}
              </Text>
            ))}
          </Box>
          <Box marginBottom={1} gap={2}>
            <Text color={color.muted}>{periodRange || " "}</Text>
            {usagePeriod !== "all" && <Text color={color.dim}>{localTimezoneLabel()}</Text>}
          </Box>

          <Box flexDirection="row" width="100%" overflow="hidden" height={1}>
            <Box width={14} flexShrink={0}>
              <Text color={color.muted}>PROFILE</Text>
            </Box>
            <Box width={14} flexShrink={0}>
              <Text color={color.muted}>COST</Text>
            </Box>
            <Box width={14} flexShrink={0}>
              <Text color={color.muted}>INPUT</Text>
            </Box>
            <Box width={14} flexShrink={0}>
              <Text color={color.muted}>OUTPUT</Text>
            </Box>
          </Box>
          <Divider />
          {profiles.map((p) => {
            const d = getData(p);
            return (
              <Box key={p.name} flexDirection="row" width="100%" overflow="hidden" height={1}>
                <Box width={14} flexShrink={0}>
                  <Text color={p.isActive ? color.brand : color.text} bold={p.isActive}>
                    {p.name}
                  </Text>
                </Box>
                <Box width={14} flexShrink={0}>
                  <Text color={d.cost > 0 ? color.text : color.muted}>{formatCurrency(d.cost)}</Text>
                </Box>
                <Box width={14} flexShrink={0}>
                  <Text color={d.inputTokens > 0 ? color.text : color.muted}>{formatCount(d.inputTokens)}</Text>
                </Box>
                <Box width={14} flexShrink={0}>
                  <Text color={d.outputTokens > 0 ? color.text : color.muted}>{formatCount(d.outputTokens)}</Text>
                </Box>
              </Box>
            );
          })}
          <Divider />
          <Box flexDirection="row" width="100%" overflow="hidden" height={1}>
            <Box width={14} flexShrink={0}>
              <Text color={color.text} bold>
                Total
              </Text>
            </Box>
            <Box width={14} flexShrink={0}>
              <Text color={color.brand} bold>
                {formatCurrency(profiles.reduce((s, p) => s + getData(p).cost, 0))}
              </Text>
            </Box>
            <Box width={14} flexShrink={0}>
              <Text color={color.secondary}>
                {formatCount(profiles.reduce((s, p) => s + getData(p).inputTokens, 0))}
              </Text>
            </Box>
            <Box width={14} flexShrink={0}>
              <Text color={color.secondary}>
                {formatCount(profiles.reduce((s, p) => s + getData(p).outputTokens, 0))}
              </Text>
            </Box>
          </Box>
        </Box>
      </Chrome>
    );
  }

  // ── Init: Loading / Applying ──
  if (initState.step === "loading" || initState.step === "applying") {
    return (
      <Chrome title="Initialize" hints={[]}>
        <Spinner
          label={
            initState.step === "loading"
              ? "Scanning for Claude and Codex accounts..."
              : "Writing registry and symlinks..."
          }
        />
      </Chrome>
    );
  }

  // ── Init: Error ──
  if (initState.step === "error") {
    return (
      <Chrome title="Initialize" subtitle="Something went wrong" hints={[]}>
        <Box gap={1}>
          <Text color={color.error}>{symbol.cross}</Text>
          <Text color={color.error}>{initState.message}</Text>
        </Box>
      </Chrome>
    );
  }

  // ── Init: Select accounts ──
  if (initState.step === "select") {
    return (
      <Chrome title="Initialize" hints={initSelectHints}>
        <Box flexDirection="column" gap={1}>
          <StepIndicator steps={INIT_STEPS} current={0} />
          <Box
            flexDirection="column"
            gap={1}
            width="50%"
            minWidth={1}
            flexShrink={0}
            borderStyle="round"
            borderColor={color.dim}
            paddingX={1}
            paddingY={0}
          >
            <Text color={color.secondary}>Select accounts to register:</Text>
            <SelectList
              multi
              items={initState.accounts.map((account) => ({
                id: account.configDir,
                label: `[${account.tool}] ${account.configDir.replace(homedir(), "~")}`,
                detail: account.email,
                selected: initState.selected.includes(account.configDir),
              }))}
              index={initState.cursor}
            />
          </Box>
        </Box>
      </Chrome>
    );
  }

  // ── Init: Name profiles ──
  if (initState.step === "name") {
    const currentConfig = initState.selected[initState.nameIndex];
    const account = initState.accounts.find((item) => item.configDir === currentConfig);
    return (
      <Chrome title="Initialize" hints={account?.isPrimary ? addInputHints : initNameHints}>
        <Box flexDirection="column" gap={1}>
          <StepIndicator steps={INIT_STEPS} current={1} />
          <Box flexDirection="column" gap={1} borderStyle="round" borderColor={color.dim} paddingX={2} paddingY={1}>
            <Text color={color.secondary}>
              Profile {initState.nameIndex + 1} of {initState.selected.length}
            </Text>
            <Box flexDirection="column">
              <Box gap={1}>
                <Text color={color.muted}>Account </Text>
                <Text color={color.text}>{account?.email}</Text>
              </Box>
              <Box gap={1}>
                <Text color={color.muted}>Config </Text>
                <Text color={color.secondary}>{currentConfig?.replace(homedir(), "~")}</Text>
              </Box>
            </Box>
            <Box gap={1}>
              <Text color={initState.nameField === 0 ? color.cursor : color.dim}>
                {initState.nameField === 0 ? symbol.cursor : " "}
              </Text>
              <Text color={color.text}>Name: </Text>
              <TextInput
                value={initState.nameDraft}
                onChange={(value) => setInitState((prev) => ({ ...prev, nameDraft: value }))}
                focus={initState.nameField === 0}
              />
            </Box>
            {!account?.isPrimary && (
              <Box gap={1}>
                <Text color={initState.nameField === 1 ? color.cursor : color.dim}>
                  {initState.nameField === 1 ? symbol.cursor : " "}
                </Text>
                <Text color={color.text}>Sessions: </Text>
                <Text color={initState.mergeSessionsMap[currentConfig ?? ""] ? color.warning : color.text}>
                  {initState.mergeSessionsMap[currentConfig ?? ""] ? "merged" : "separated"}
                </Text>
                {initState.nameField === 1 && <Text color={color.muted}> (space to toggle)</Text>}
              </Box>
            )}
          </Box>
        </Box>
      </Chrome>
    );
  }

  // ── Init: Default profile ──
  if (initState.step === "default") {
    const selectedItems = initState.selected.map((configDir) => ({
      id: configDir,
      label: initState.profileNames[configDir] ?? configDir,
      detail: initState.accounts.find((account) => account.configDir === configDir)?.email,
    }));
    return (
      <Chrome title="Initialize" hints={selectHints}>
        <Box flexDirection="column" gap={1}>
          <StepIndicator steps={INIT_STEPS} current={2} />
          <Box flexDirection="column" gap={1} borderStyle="round" borderColor={color.dim} paddingX={2} paddingY={1}>
            <Text color={color.secondary}>Choose the default profile:</Text>
            <Text color={color.muted} dimColor>
              The default profile cannot be changed later.
            </Text>
            <SelectList items={selectedItems} index={initState.cursor} />
          </Box>
        </Box>
      </Chrome>
    );
  }

  // ── Init: Review / Done ──
  return (
    <Chrome
      title="Initialize"
      hints={initState.step === "done" ? [{ keys: "enter", action: "finish" }] : initReviewHints}
    >
      <Box flexDirection="column" gap={1}>
        <StepIndicator steps={INIT_STEPS} current={3} />
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={initState.step === "done" ? color.healthy : color.dim}
          paddingX={2}
          paddingY={1}
        >
          <Text color={color.secondary}>Review before applying:</Text>
          <Box flexDirection="column" marginTop={1}>
            {initState.selected.map((configDir) => {
              const account = initState.accounts.find((item) => item.configDir === configDir);
              const profileName = initState.profileNames[configDir];
              const isDefault = profileName === initState.defaultProfile;
              return (
                <Box key={configDir} gap={1} marginBottom={1}>
                  <Box width={16}>
                    <Text color={isDefault ? color.brandLight : color.text} bold={isDefault}>
                      {profileName}
                    </Text>
                  </Box>
                  <Text color={color.secondary}>{account?.email}</Text>
                  {isDefault && <Text color={color.brandLight}> {symbol.dot} default</Text>}
                  {!account?.isPrimary && (
                    <Text color={color.muted}>
                      {" "}
                      {symbol.dot} {initState.mergeSessionsMap[configDir] ? "merged" : "separated"}
                    </Text>
                  )}
                </Box>
              );
            })}
          </Box>
          {initState.step === "done" && (
            <Box gap={1} marginTop={1}>
              <Text color={color.healthy}>{symbol.check}</Text>
              <Text color={color.healthy} bold>
                Profiles initialized successfully.
              </Text>
            </Box>
          )}
        </Box>
      </Box>
    </Chrome>
  );
}
