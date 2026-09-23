import { homedir } from "node:os";
import { StringDecoder } from "node:string_decoder";

import { Spinner } from "@inkjs/ui";
import { Box, Text, useApp, useInput, useStdin, useStdout } from "ink";
import TextInput from "ink-text-input";
import { useEffect, useRef, useState } from "react";

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
import { defaultProfileName, looksLikeCredential, profileId } from "../lib/profile-ref.js";
import { EMPTY_SECRET_INPUT, readSecretChunk, type SecretInputState } from "../lib/prompt-secret.js";
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
  customEntryError,
  defaultAuthScheme,
  emptyApiForm,
  isTypingField,
  liveApiFieldError,
  scrubSecret,
  validateApiForm,
  withoutKeys,
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
 * What the key field says when the terminal sent something the reader cannot measure, and
 * when a paste opened and never closed.
 *
 * The situations are `prompt-secret.ts`'s, and so is the refusal: nothing is stored, and a
 * fragment is never reported as success. The wording is not, because the prompt's advice is
 * to pipe the key in instead, and there is no pipe behind a form - only the field the
 * message appears under.
 */
const UNREADABLE_KEY_INPUT =
  "This terminal sent something the key field cannot read, so part of the key may be missing. The field has been cleared - paste it again.";
const UNFINISHED_PASTE =
  "A paste started and never finished, so only part of the key arrived. Nothing was saved - clear the field with ctrl-u and paste it again.";
const UNFINISHED_SEQUENCE =
  "The terminal started a sequence and never finished it, so part of the key is still unread. Nothing was saved - clear the field with ctrl-u and paste it again.";

/**
 * What the key field says when it cannot get at the bytes the terminal sent.
 *
 * It reads them directly rather than through ink, because `useInput` strips one leading ESC
 * and offers no flag saying it did - through it, a typed `[` and a stripped `ESC [` are the
 * same string, and so are `O` and `ESC O`. Guessing between them corrupted a key twice, in
 * both directions. So when the raw stream is out of reach there is no reader to fall back
 * to, and the field says where the key can go in instead of taking one it cannot trust.
 *
 * Short on purpose: the panel truncates an error to one line, and the way out is the part
 * that has to survive the truncation.
 */
const NO_RAW_KEY_INPUT = "This terminal cannot be read directly - use clausona add --api --key-from env:NAME.";

/**
 * Whether the cursor is on the API form's key field.
 *
 * It is what gates the raw input listener: attached on this row and on no other, so that a
 * keystroke meant for the name or the endpoint can never reach the key.
 */
function isKeyFieldFocused(screen: Screen, state: AddState | null): boolean {
  if (screen !== "use" || state === null || state.step !== "api-form") return false;
  const fields = apiFormFields(state.api);
  return fields[Math.min(state.api.cursor, fields.length - 1)]?.kind === "secret";
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

// ── App ──

export function App({ initialScreen = "dashboard" }: AppProps) {
  const { exit } = useApp();
  const { stdout, write } = useStdout();
  const { stdin } = useStdin();

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
   * How far through a terminal escape sequence the key field is. A ref rather than state:
   * it decides what the next chunk of input means, and nothing on screen is drawn from it.
   */
  const secretInput = useRef<SecretInputState>({ ...EMPTY_SECRET_INPUT });
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
      clearApiKey();
      setOverlay(null);
      setScreen("dashboard");
    }
  }

  function resetAddState() {
    setAddState(null);
    clearApiKey();
    setCursor(0);
  }

  async function startAddFlow() {
    clearApiKey();
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
    updateApiForm((form) => {
      const length = apiFormFields(form).length;
      return { ...form, cursor: (Math.min(form.cursor, length - 1) + delta + length) % length };
    });
  }

  function toggleApiAdvanced() {
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
  }

  /**
   * The key field's text comes from the terminal's own bytes, not from `useInput`.
   *
   * `useInput` hands over `keypress.sequence` with one leading ESC removed and nothing in
   * the `key` object saying it was removed - no `code`, and `meta` false for an unnamed CSI
   * exactly as for a typed bracket. So through it a focus report `ESC [ I` and a key
   * containing `[I` are the same three characters, and both of this field's silent
   * corruptions came from guessing which: the first round appended `[I` to the key, the
   * second reconstructed an ESC in front of every `[` and `O` and ate the characters after
   * them. `O` is an ordinary base64 character; there is no third guess.
   *
   * `readSecretChunk` is given what the terminal sent, which is what it needs to measure a
   * sequence rather than guess at one. `useInput` keeps the named keys below - erase,
   * ctrl-u, return, esc, the arrows - and appends nothing, so there is exactly one writer.
   *
   * Attached only while the cursor is on the key field. Everywhere else the terminal's bytes
   * are none of this listener's business.
   */
  const keyFieldFocused = isKeyFieldFocused(screen, addState);
  const canReadKeyBytes = typeof stdin?.on === "function" && typeof stdin?.off === "function";
  useEffect(() => {
    if (!keyFieldFocused) return;
    if (!canReadKeyBytes) {
      // No reader at all rather than a guessing one, and the refusal is shown where the key
      // would have been typed instead of at the save, which is too late to retype anything.
      setAddState((prev) =>
        prev ? { ...prev, api: { ...prev.api, errors: { ...prev.api.errors, key: NO_RAW_KEY_INPUT } } } : null,
      );
      return;
    }
    // Decoded here rather than by `setEncoding`, which would change the shared stdin for
    // whatever ink and the rest of the process do with it, and re-created with the listener
    // so a multibyte character split across two reads is joined rather than mangled.
    const decoder = new StringDecoder("utf8");
    const onData = (chunk: Buffer | string) => {
      const bytes = typeof chunk === "string" ? chunk : decoder.write(chunk);
      if (bytes === "") return;
      const read = readSecretChunk(secretInput.current, bytes);
      secretInput.current = read.state;
      // The same two writes `editApiKey` makes, inlined so that this listener depends on
      // nothing that changes every render: re-attaching it would drop the decoder, and with
      // it half of any character that happened to be spanning two reads.
      if (read.problem === "unreadable") {
        setApiKey("");
        setAddState((prev) =>
          prev ? { ...prev, api: { ...prev.api, errors: { ...prev.api.errors, key: UNREADABLE_KEY_INPUT } } } : null,
        );
        return;
      }
      if (read.text === "") return;
      setApiKey((previous) => previous + read.text);
      setAddState((prev) =>
        prev ? { ...prev, api: { ...prev.api, errors: withoutKeys(prev.api.errors, "key") } } : null,
      );
    };
    stdin.on("data", onData);
    return () => {
      stdin.off("data", onData);
    };
  }, [keyFieldFocused, canReadKeyBytes, stdin]);

  function editApiField(field: ApiField, value: string) {
    updateApiForm((form) => {
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
    // A paste whose closing bracket never arrived: what is in the field is the front of a
    // key rather than the key. The prompt refuses to return that rather than have it
    // stored and reported as success, and so does this.
    if (secretInput.current.pasting) errors.key = UNFINISHED_PASTE;
    // The same refusal one branch out. Since the field reads the terminal's own bytes, a
    // sequence still half-arrived at save time means real bytes are parked behind it - and
    // a key is what the terminal sent, not what got as far as the field.
    if (secretInput.current.pending !== "") errors.key = UNFINISHED_SEQUENCE;
    // And nothing can be saved at all from a field that never had a reader.
    if (!canReadKeyBytes) errors.key = NO_RAW_KEY_INPUT;
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

  useInput((input, key) => {
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
          // The key goes with the step; everything else stays, so a stray esc costs a URL
          // nobody has to retype. Coming back to a mask over a value the user can no
          // longer read is a value they cannot check, and one this component would then
          // have held for the rest of the session - so the field comes back empty, on a
          // form that is otherwise as they left it.
          //
          // A name is a plain field and shows what was typed into it, key included, for as
          // long as it is on screen. It does not outlive the step: a name the form already
          // refused as key-shaped goes the same way the key does.
          clearApiKey();
          setAddState((prev) =>
            prev
              ? {
                  ...prev,
                  step: "method",
                  cursor: 0,
                  api: {
                    ...prev.api,
                    name: looksLikeCredential(prev.api.name.trim()) ? "" : prev.api.name,
                    cursor: 0,
                  },
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
          const fields = apiFormFields(form);
          const index = Math.min(form.cursor, fields.length - 1);
          const current = fields[index];
          const typing = isTypingField(current);

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
          if (current?.kind === "auth" && (input === " " || key.leftArrow || key.rightArrow)) {
            updateApiForm((prev) => ({
              ...prev,
              authScheme: prev.authScheme === "bearer" ? "api-key" : "bearer",
              authTouched: true,
            }));
            return;
          }
          if (current?.kind === "sessions" && input === " ") {
            setAddState((prev) => (prev ? { ...prev, mergeSessions: !prev.mergeSessions } : null));
            return;
          }
          if (current?.kind === "advanced" && (input === " " || key.return)) {
            toggleApiAdvanced();
            return;
          }
          // The key field is the one field with no text input behind it, because a text
          // input draws one glyph per character it holds and the length of a key is
          // something this form does not show. So the editing keys are handled here:
          // erase and kill-line. The characters themselves are not: they come from the raw
          // stdin listener above, which reads the bytes before ink has edited them.
          if (current?.kind === "secret" && !key.return) {
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
            if (current?.kind === "submit") {
              submitApiForm(addState);
              return;
            }
            if (current?.id === "customValue" && form.customKey.trim() !== "") {
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
            process.stdout.write(`${symbol.check} Switched to ${profile.name} (${profile.email})\n`);
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
          setOverlay({ kind: "login", profileName: p.name, email: p.email });
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
              keySet={apiKey !== ""}
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
                detail: p.email,
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
