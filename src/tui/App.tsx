import { useEffect, useRef, useState } from "react";
import { homedir } from "node:os";
import path from "node:path";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import { Spinner } from "@inkjs/ui";

import { bootstrapInitFromCurrentState } from "../commands.js";
import {
  addProfile,
  discoverAccounts,
  doctorProfiles,
  initializeRegistry,
  listProfiles,
  loginProfile,
  removeProfile,
  setActiveProfileByName,
  validateConfigDir,
} from "../lib/service.js";
import { Chrome } from "./components/Chrome.js";
import { ProfilePreview } from "./components/ProfilePreview.js";
import { SelectList, type SelectListItem } from "./components/SelectList.js";
import { StepIndicator } from "./components/StepIndicator.js";
import { Divider } from "./components/Divider.js";
import { color, symbol } from "./theme.js";
import { formatCurrency, formatCount, localTimezoneLabel } from "../lib/format.js";
import type { DiscoveredAccount, DoctorProfileResult, ProfileListItem } from "../types.js";

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
  message?: string;
};

// ── Add / Overlay types ──

type AddStep = "loading" | "method" | "discover-select" | "discover-name" | "login-name" | "import-path" | "import-name" | "applying" | "done" | "error";

type AddState = {
  step: AddStep;
  discoveredAccounts: DiscoveredAccount[];
  selectedAccounts: string[];
  profileNames: Record<string, string>;
  nameDraft: string;
  nameIndex: number;
  importPath: string;
  importError: string | null;
  importAccount: { configDir: string; email: string; orgName?: string } | null;
  cursor: number;
  message?: string;
};

type OverlayState =
  | null
  | { kind: "remove"; profileName: string; email: string; isPrimary: boolean }
  | { kind: "login"; profileName: string; email: string };

const INIT_STEPS = [
  { label: "Select" },
  { label: "Name" },
  { label: "Default" },
  { label: "Review" },
];

// ── Hint sets ──

const dashboardHints = [
  { keys: "↑↓", action: "navigate" },
  { keys: "enter", action: "open" },
  { keys: "esc", action: "quit" },
];

const doctorHints = [
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

const overlayHints = [
  { keys: "y", action: "confirm" },
  { keys: "esc", action: "cancel" },
];

// ── App ──

export function App({ initialScreen = "dashboard" }: AppProps) {
  const { exit } = useApp();
  const { stdout, write } = useStdout();

  const [screen, setScreen] = useState<Screen>(initialScreen);
  // Force clear the console state to prevent output duplication on terminal resize.
  useEffect(() => {
    if (stdout && typeof stdout.on === 'function') {
      let resizeTimer: NodeJS.Timeout;
      const onResize = () => {
        clearTimeout(resizeTimer);
        // Clear immediately to avoid partial layouts
        write('\x1b[2J\x1b[3J\x1b[H'); 
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
  });

  const [addState, setAddState] = useState<AddState | null>(null);
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
      setOverlay(null);
      setScreen("dashboard");
    }
  }

  function resetAddState() {
    setAddState(null);
    setCursor(0);
  }

  async function startAddFlow() {
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
      setAddState((prev) =>
        prev ? { ...prev, step: "method", discoveredAccounts: [], cursor: 0 } : null,
      );
    }
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
    const [nextProfiles, nextDoctor] = await Promise.all([listProfiles(), doctorProfiles()]);
    setProfiles(nextProfiles);
    setDoctor(nextDoctor);
    setLoading(false);
    // No registry yet — redirect to init flow
    if (nextProfiles.length === 0 && screen !== "init") {
      setScreen("init");
    }
  }

  useEffect(() => {
    void refreshDashboard();
  }, []);

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
            nameDraft: firstSelected ? state.profileNames[firstSelected] ?? "" : "",
            defaultProfile: state.defaultProfile,
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
        } else if (selectedAction === "use" || selectedAction === "doctor" || selectedAction === "init" || selectedAction === "usage") {
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
        } else if (addState.step === "discover-select" || addState.step === "login-name" || addState.step === "import-path") {
          setAddState((prev) => prev ? { ...prev, step: "method", cursor: 0 } : null);
        } else if (addState.step === "discover-name") {
          setAddState((prev) => prev ? { ...prev, step: "discover-select", cursor: 0 } : null);
        } else if (addState.step === "import-name") {
          setAddState((prev) => prev ? { ...prev, step: "import-path", importError: null } : null);
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
          }
        }
        return;
      }

      // ── Add flow handlers ──
      if (addState) {
        // Method chooser
        if (addState.step === "method") {
          const methods = ["discover", "login", "import"] as const;
          if (key.upArrow) {
            setAddState((prev) => prev ? { ...prev, cursor: (prev.cursor - 1 + methods.length) % methods.length } : null);
          } else if (key.downArrow) {
            setAddState((prev) => prev ? { ...prev, cursor: (prev.cursor + 1) % methods.length } : null);
          } else if (key.return) {
            const selected = methods[addState.cursor];
            if (selected === "discover") {
              if (addState.discoveredAccounts.length === 0) {
                setAddState((prev) => prev ? { ...prev, step: "error", message: "No unregistered accounts found." } : null);
              } else {
                const allDirs = addState.discoveredAccounts.map((a) => a.configDir);
                setAddState((prev) => prev ? { ...prev, step: "discover-select", selectedAccounts: allDirs, cursor: 0 } : null);
              }
            } else if (selected === "login") {
              setAddState((prev) => prev ? { ...prev, step: "login-name", nameDraft: "" } : null);
            } else if (selected === "import") {
              setAddState((prev) => prev ? { ...prev, step: "import-path", importPath: "", importError: null } : null);
            }
          }
          return;
        }

        // Discover multi-select
        if (addState.step === "discover-select") {
          const len = addState.discoveredAccounts.length;
          if (key.upArrow) {
            setAddState((prev) => prev ? { ...prev, cursor: (prev.cursor - 1 + len) % Math.max(1, len) } : null);
          } else if (key.downArrow) {
            setAddState((prev) => prev ? { ...prev, cursor: (prev.cursor + 1) % Math.max(1, len) } : null);
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
            const defaultName = account ? (path.basename(account.configDir).replace(/^\.claude-?/, "") || "profile") : "profile";
            setAddState((prev) => prev ? {
              ...prev,
              step: "discover-name",
              nameIndex: 0,
              nameDraft: defaultName,
              profileNames: {},
            } : null);
          }
          return;
        }

        // Discover name each
        if (addState.step === "discover-name" && key.return) {
          const currentDir = addState.selectedAccounts[addState.nameIndex];
          if (!currentDir) return;
          const trimmed = addState.nameDraft.trim() || "profile";
          // Check for duplicate name
          if (profiles.some((p) => p.name === trimmed) || Object.values(addState.profileNames).includes(trimmed)) {
            setAddState((prev) => prev ? { ...prev, message: `Profile "${trimmed}" already exists` } : null);
            return;
          }
          const nextNames = { ...addState.profileNames, [currentDir]: trimmed };
          const nextIndex = addState.nameIndex + 1;
          if (nextIndex >= addState.selectedAccounts.length) {
            // Apply all
            setAddState((prev) => prev ? { ...prev, profileNames: nextNames, step: "applying" } : null);
            void (async () => {
              try {
                for (const [dir, name] of Object.entries(nextNames)) {
                  await addProfile({ name, fromPath: dir });
                }
                setAddState((prev) => prev ? { ...prev, step: "done", message: `Added ${Object.keys(nextNames).length} profile(s)` } : null);
                await refreshDashboard();
              } catch (error) {
                setAddState((prev) => prev ? { ...prev, step: "error", message: error instanceof Error ? error.message : String(error) } : null);
              }
            })();
          } else {
            const nextDir = addState.selectedAccounts[nextIndex];
            const nextAccount = addState.discoveredAccounts.find((a) => a.configDir === nextDir);
            const nextDefault = nextAccount ? (path.basename(nextAccount.configDir).replace(/^\.claude-?/, "") || "profile") : "profile";
            setAddState((prev) => prev ? { ...prev, profileNames: nextNames, nameIndex: nextIndex, nameDraft: nextDefault, message: undefined } : null);
          }
          return;
        }

        // Login name
        if (addState.step === "login-name" && key.return) {
          const name = addState.nameDraft.trim();
          if (!name) return;
          if (profiles.some((p) => p.name === name)) {
            setAddState((prev) => prev ? { ...prev, message: `Profile "${name}" already exists` } : null);
            return;
          }
          setAddState((prev) => prev ? { ...prev, step: "applying" } : null);
          void (async () => {
            try {
              const result = await suspendTuiAndRun(() => addProfile({ name }));
              setAddState((prev) => prev ? { ...prev, step: "done", message: `Added ${result.name} (${result.email})` } : null);
              await refreshDashboard();
            } catch (error) {
              setAddState((prev) => prev ? { ...prev, step: "error", message: error instanceof Error ? error.message : String(error) } : null);
            }
          })();
          return;
        }

        // Import path
        if (addState.step === "import-path" && key.return) {
          const inputPath = addState.importPath.trim();
          if (!inputPath) return;
          void (async () => {
            const result = await validateConfigDir(inputPath, profiles.map((p) => p.configDir));
            if ("error" in result) {
              setAddState((prev) => prev ? { ...prev, importError: result.error } : null);
            } else {
              const defaultName = path.basename(result.account.configDir).replace(/^\.claude-?/, "") || "profile";
              setAddState((prev) => prev ? {
                ...prev,
                step: "import-name",
                importAccount: result.account,
                nameDraft: defaultName,
                importError: null,
              } : null);
            }
          })();
          return;
        }

        // Import name
        if (addState.step === "import-name" && key.return) {
          const name = addState.nameDraft.trim();
          if (!name || !addState.importAccount) return;
          if (profiles.some((p) => p.name === name)) {
            setAddState((prev) => prev ? { ...prev, message: `Profile "${name}" already exists` } : null);
            return;
          }
          setAddState((prev) => prev ? { ...prev, step: "applying" } : null);
          void (async () => {
            try {
              const result = await addProfile({ name, fromPath: addState.importAccount!.configDir });
              setAddState((prev) => prev ? { ...prev, step: "done", message: `Added ${result.name} (${result.email})` } : null);
              await refreshDashboard();
            } catch (error) {
              setAddState((prev) => prev ? { ...prev, step: "error", message: error instanceof Error ? error.message : String(error) } : null);
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
            setAddState((prev) => prev ? { ...prev, step: "method", cursor: 0, message: undefined } : null);
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
    return <></>;
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
      <Chrome
        title="Dashboard"
        footer={message || undefined}
        hints={dashboardHints}
      >
        <Box gap={2} flexDirection="row" width="100%">
          <Box flexDirection="column" width="50%" minWidth={1} flexShrink={0} borderStyle="round" borderColor={color.dim} paddingX={1} paddingY={0}>
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
          <Chrome title="Add Profile" hints={[{ keys: "r", action: "retry" }, { keys: "esc", action: "back" }]}>
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
            <Box flexDirection="column" gap={1} borderStyle="round" borderColor={color.healthy} paddingX={2} paddingY={1}>
              <Box gap={1}>
                <Text color={color.healthy}>{symbol.check}</Text>
                <Text color={color.healthy} bold>{addState.message}</Text>
              </Box>
            </Box>
          </Chrome>
        );
      }

      if (addState.step === "method") {
        const methods: SelectListItem[] = [
          {
            id: "discover",
            label: "Discover accounts",
            detail: "Scan for unregistered ~/.claude-* accounts",
            badge: addState.discoveredAccounts.length > 0 ? `${addState.discoveredAccounts.length} found` : "none",
            badgeVariant: addState.discoveredAccounts.length > 0 ? "primary" : "muted",
          },
          {
            id: "login",
            label: "Login as new account",
            detail: "Authenticate via browser OAuth",
          },
          {
            id: "import",
            label: "Import from path",
            detail: "Register an existing config directory manually",
          },
        ];
        return (
          <Chrome title="Add Profile" subtitle="Choose how to add" hints={selectHints}>
            <Box flexDirection="column" borderStyle="round" borderColor={color.dim} paddingX={2} paddingY={1}>
              <SelectList items={methods} index={addState.cursor} />
            </Box>
          </Chrome>
        );
      }

      if (addState.step === "discover-select") {
        const currentAccount = addState.discoveredAccounts[addState.cursor];
        return (
          <Chrome title="Add Profile" subtitle="Discover" hints={addDiscoverHints}>
            <Box gap={2} flexDirection="row" width="100%">
              <Box flexDirection="column" width="50%" minWidth={1} flexShrink={0} borderStyle="round" borderColor={color.dim} paddingX={1} paddingY={0}>
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
              <Box flexGrow={1} flexShrink={1} minWidth={1} borderStyle="round" borderColor={color.dim} paddingX={1} flexDirection="column" overflow="hidden">
                {currentAccount ? (
                  <>
                    <Text color={color.text} bold>{currentAccount.configDir.replace(homedir(), "~")}</Text>
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
        return (
          <Chrome title="Add Profile" subtitle="Name" hints={addInputHints}>
            <Box flexDirection="column" gap={1} borderStyle="round" borderColor={color.dim} paddingX={2} paddingY={1}>
              <Text color={color.secondary}>
                Profile {addState.nameIndex + 1} of {addState.selectedAccounts.length}
              </Text>
              <Box flexDirection="column">
                <Box gap={1}>
                  <Text color={color.muted}>Account</Text>
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
                <Text color={color.cursor}>{symbol.cursor}</Text>
                <Text color={color.text}>Name: </Text>
                <TextInput
                  value={addState.nameDraft}
                  onChange={(value) => setAddState((prev) => prev ? { ...prev, nameDraft: value, message: undefined } : null)}
                />
              </Box>
            </Box>
          </Chrome>
        );
      }

      if (addState.step === "login-name") {
        return (
          <Chrome title="Add Profile" subtitle="Login as new account" hints={addInputHints}>
            <Box flexDirection="column" gap={1} borderStyle="round" borderColor={color.dim} paddingX={2} paddingY={1}>
              <Text color={color.secondary}>Enter a name for the new profile. OAuth login will open in your browser.</Text>
              {addState.message && (
                <Box gap={1}>
                  <Text color={color.error}>{symbol.cross}</Text>
                  <Text color={color.error}>{addState.message}</Text>
                </Box>
              )}
              <Box gap={1}>
                <Text color={color.cursor}>{symbol.cursor}</Text>
                <Text color={color.text}>Name: </Text>
                <TextInput
                  value={addState.nameDraft}
                  onChange={(value) => setAddState((prev) => prev ? { ...prev, nameDraft: value, message: undefined } : null)}
                />
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
                  onChange={(value) => setAddState((prev) => prev ? { ...prev, importPath: value, importError: null } : null)}
                />
              </Box>
              {addState.importError ? (
                <Box gap={1}>
                  <Text color={color.error}>{symbol.cross}</Text>
                  <Text color={color.error}>{addState.importError}</Text>
                </Box>
              ) : (
                <Text color={color.muted}>Expects a directory containing .claude.json with valid oauthAccount credentials.</Text>
              )}
            </Box>
          </Chrome>
        );
      }

      if (addState.step === "import-name") {
        return (
          <Chrome title="Add Profile" subtitle="Name the imported profile" hints={addInputHints}>
            <Box flexDirection="column" gap={1} borderStyle="round" borderColor={color.dim} paddingX={2} paddingY={1}>
              <Box flexDirection="column">
                <Box gap={1}>
                  <Text color={color.muted}>Account</Text>
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
                <Text color={color.cursor}>{symbol.cursor}</Text>
                <Text color={color.text}>Name: </Text>
                <TextInput
                  value={addState.nameDraft}
                  onChange={(value) => setAddState((prev) => prev ? { ...prev, nameDraft: value, message: undefined } : null)}
                />
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
        ? [{ keys: "d", action: "remove" }, { keys: "l", action: "re-login" }]
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
          <Box flexDirection="column" width="50%" minWidth={1} flexShrink={0} borderStyle="round" borderColor={color.dim} paddingX={1} paddingY={0}>
            <SelectList
              items={profiles.map((p) => ({
                id: p.name,
                label: p.name,
                detail: p.email,
                badge: p.isActive ? "active" : undefined,
                badgeVariant: p.isActive ? "active" as const : undefined,
              }))}
              index={cursor}
            />
          </Box>
          <Box flexGrow={1} flexShrink={1} minWidth={1} borderStyle="round" borderColor={color.dim} paddingX={1} flexDirection="column" overflow="hidden">
            <ProfilePreview
              profile={profiles[cursor]}
              doctor={doctor.find((d) => d.name === profiles[cursor]?.name)}
              />
          </Box>
        </Box>
        {overlay?.kind === "remove" && (
          <Box flexDirection="column" borderStyle="round" borderColor={overlay.isPrimary ? color.error : color.warning} paddingX={2} paddingY={1} marginTop={1}>
            {overlay.isPrimary ? (
              <>
                <Box gap={1}>
                  <Text color={color.error}>{symbol.cross}</Text>
                  <Text color={color.error}>Cannot remove the primary profile.</Text>
                </Box>
                <Text color={color.muted} dimColor>Press esc to dismiss.</Text>
              </>
            ) : (
              <>
                <Text color={color.text} bold>Remove &quot;{overlay.profileName}&quot;?</Text>
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
          <Box flexDirection="column" borderStyle="round" borderColor={color.brand} paddingX={2} paddingY={1} marginTop={1}>
            <Text color={color.text} bold>Re-login &quot;{overlay.profileName}&quot;?</Text>
            <Text color={color.secondary}>This will open your browser to re-authenticate the OAuth token for {overlay.email}.</Text>
            <Text color={color.muted}>The TUI will be suspended during login.</Text>
            <Box marginTop={1} gap={2}>
              <Text color={color.brand}>y proceed</Text>
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
    return (
      <Chrome
        title="Health Check"
        subtitle="Inspect profile integrity and symlink status"
        hints={doctorHints}
      >
        <Box gap={2} flexDirection="row" width="100%">
          <Box flexDirection="column" width="50%" minWidth={1} flexShrink={0} borderStyle="round" borderColor={color.dim} paddingX={1} paddingY={0}>
            <SelectList
              items={doctor.map((r) => ({
                id: r.name,
                label: r.name,
                detail: r.email,
                badge: r.healthy ? "healthy" : `${r.issues.length} issue(s)`,
                badgeVariant: r.healthy ? "healthy" as const : "warning" as const,
              }))}
              index={cursor}
            />
          </Box>
          <Box flexGrow={1} flexShrink={1} minWidth={1} borderStyle="round" borderColor={color.dim} paddingX={1} flexDirection="column" overflow="hidden">
            {currentDoctor ? (
              <>
                <Box gap={1}>
                  <Text color={color.text} bold>{currentDoctor.name}</Text>
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
                {currentDoctor.healthy && (
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
        case "today": return p.today;
        case "week": return p.week;
        case "month": return p.month;
        case "all": return p.total;
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
              <Text
                key={pk}
                color={pk === usagePeriod ? color.brand : color.muted}
                bold={pk === usagePeriod}
              >
                {pk === usagePeriod ? `[${periodLabels[pk]}]` : ` ${periodLabels[pk]} `}
              </Text>
            ))}
          </Box>
          <Box marginBottom={1} gap={2}>
            <Text color={color.muted}>{periodRange || " "}</Text>
            {usagePeriod !== "all" && <Text color={color.dim}>{localTimezoneLabel()}</Text>}
          </Box>

          <Box flexDirection="row" width="100%" overflow="hidden" height={1}>
            <Box width={14} flexShrink={0}><Text color={color.muted}>PROFILE</Text></Box>
            <Box width={14} flexShrink={0}><Text color={color.muted}>COST</Text></Box>
            <Box width={14} flexShrink={0}><Text color={color.muted}>INPUT</Text></Box>
            <Box width={14} flexShrink={0}><Text color={color.muted}>OUTPUT</Text></Box>
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
                  <Text color={d.cost > 0 ? color.text : color.muted}>
                    {formatCurrency(d.cost)}
                  </Text>
                </Box>
                <Box width={14} flexShrink={0}>
                  <Text color={d.inputTokens > 0 ? color.text : color.muted}>
                    {formatCount(d.inputTokens)}
                  </Text>
                </Box>
                <Box width={14} flexShrink={0}>
                  <Text color={d.outputTokens > 0 ? color.text : color.muted}>
                    {formatCount(d.outputTokens)}
                  </Text>
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
        <Spinner label={initState.step === "loading" ? "Scanning for Claude accounts..." : "Writing registry and symlinks..."} />
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
          <Box flexDirection="column" gap={1} width="50%" minWidth={1} flexShrink={0} borderStyle="round" borderColor={color.dim} paddingX={1} paddingY={0}>
            <Text color={color.secondary}>Select accounts to register:</Text>
            <SelectList
              multi
              items={initState.accounts.map((account) => ({
                id: account.configDir,
                label: account.configDir.replace(homedir(), "~"),
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
      <Chrome
        title="Initialize"
        hints={addInputHints}
      >
        <Box flexDirection="column" gap={1}>
          <StepIndicator steps={INIT_STEPS} current={1} />
          <Box flexDirection="column" gap={1} borderStyle="round" borderColor={color.dim} paddingX={2} paddingY={1}>
            <Text color={color.secondary}>
              Profile {initState.nameIndex + 1} of {initState.selected.length}
            </Text>
            <Box flexDirection="column">
              <Box gap={1}>
                <Text color={color.muted}>Account</Text>
                <Text color={color.text}>{account?.email}</Text>
              </Box>
              <Box gap={1}>
                <Text color={color.muted}>Config </Text>
                <Text color={color.secondary}>{currentConfig?.replace(homedir(), "~")}</Text>
              </Box>
            </Box>
            <Box gap={1}>
              <Text color={color.cursor}>{symbol.cursor}</Text>
              <Text color={color.text}>Name: </Text>
              <TextInput
                value={initState.nameDraft}
                onChange={(value) => setInitState((prev) => ({ ...prev, nameDraft: value }))}
              />
            </Box>
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
            <Text color={color.muted} dimColor>The default profile cannot be changed later.</Text>
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
        <Box flexDirection="column" borderStyle="round" borderColor={initState.step === "done" ? color.healthy : color.dim} paddingX={2} paddingY={1}>
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
                  {isDefault && (
                    <Text color={color.brandLight}> {symbol.dot} default</Text>
                  )}
                </Box>
              );
            })}
          </Box>
          {initState.step === "done" && (
            <Box gap={1} marginTop={1}>
              <Text color={color.healthy}>{symbol.check}</Text>
              <Text color={color.healthy} bold>Profiles initialized successfully.</Text>
            </Box>
          )}
        </Box>
      </Box>
    </Chrome>
  );
}
