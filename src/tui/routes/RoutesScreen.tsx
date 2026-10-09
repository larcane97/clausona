import { Box, type Key, Text, useInput, useStdout } from "ink";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { QuotaTarget } from "../../core/quota-store.js";
import { DEFAULT_MAX_USAGE, type RouteSpec, type RoutesFile, withDefaults } from "../../core/route-config.js";
import { RoutesFileError } from "../../core/routes-store.js";
import { type Ranking, rankRoute } from "../../core/routing.js";
import { freeNow } from "../../lib/route-render.js";
import { membersOf, quotaTargets } from "../../lib/route-service.js";
import type { QuotaSnapshot, Registry } from "../../types.js";
import { Chrome } from "../components/Chrome.js";
import { color, symbol } from "../theme.js";
import { useWidth } from "../use-width.js";
import { type Entry, GAP, MARK, RouteDetail } from "./RouteDetail.js";
import { formAccounts, RouteForm } from "./RouteForm.js";
import { defaultRoutesScreenDeps, errorText, type RoutesScreenDeps } from "./routes-deps.js";

/**
 * The dashboard's Routes screen: every route, and the one selected with its members ranked as
 * `csn route explain` ranks them. It reads routes.json, the registry, quota and the pick record,
 * and writes only when a route is removed, or saved from its form (RouteForm.tsx); a pick is
 * never recorded here.
 */

/** From this many terminal columns the detail sits beside the list; below, under it. */
const WIDE_AT = 100;
const LIST_WIDTH = 30;

const HINTS = [
  { keys: "↑↓", action: "move" },
  { keys: "n", action: "new" },
  { keys: "e", action: "edit" },
  { keys: "d", action: "delete" },
  { keys: "r", action: "refresh" },
  { keys: "esc", action: "back" },
];
const CONFIRM_HINTS = [
  { keys: "y", action: "remove" },
  { keys: "n/esc", action: "cancel" },
];
const BACK_HINTS = [{ keys: "esc", action: "back" }];

type Loaded =
  | { kind: "loading" }
  | { kind: "broken"; error: unknown }
  | { kind: "ready"; file: RoutesFile; registry: Registry | null };

/** One quota read, and the pick record as it was then. */
type Reading = { quotas: Record<string, QuotaSnapshot>; lastPicked: Record<string, string>; now: number };

/** The form on screen: a new route, or the selected one as stored. */
type FormOpen = { mode: "new" } | { mode: "edit"; name: string; spec: RouteSpec };

/** Without profiles.json the form has no accounts to offer, and every pattern names nobody. */
const NO_PROFILES: Registry = { version: 2, primarySources: {}, activeProfiles: {}, profiles: {} };

/** Every route, by name, ranked on `reading`; with none yet, on nothing, which lists the members only. */
function rankAll(file: RoutesFile, registry: Registry | null, reading: Reading | null, now: number): Entry[] {
  return Object.keys(file.routes)
    .sort()
    .map((name) => {
      const route = withDefaults(file.routes[name]);
      const ranking = rankRoute({
        route,
        members: registry ? membersOf(registry, route.tool) : [],
        quotas: reading?.quotas ?? {},
        lastPicked: reading?.lastPicked ?? {},
        now: reading?.now ?? now,
        resume: false,
      });
      return { name, route, ranking };
    });
}

/** Every subscription account: what the form offers, whether or not a route takes it yet. */
const everyTarget = (registry: Registry) =>
  quotaTargets(withDefaults({ tool: "all" }), membersOf(registry, "all"), false);

/** The members of every route, once each: one quota read serves them all, as in `csn route list`. */
function targetsOf(file: RoutesFile, registry: Registry | null): QuotaTarget[] {
  const targets = new Map<string, QuotaTarget>();
  for (const spec of Object.values(file.routes)) {
    const route = withDefaults(spec);
    const members = registry ? membersOf(registry, route.tool) : [];
    for (const target of quotaTargets(route, members, false)) targets.set(target.id, target);
  }
  return [...targets.values()];
}

/** A failed read is nothing read: the screen shows "no quota reading" rather than an error. */
const settle = <T,>(read: () => Promise<T>, fallback: T) =>
  Promise.resolve()
    .then(read)
    .catch(() => fallback);

/** The terminal's width, read again when it is resized. */
function useColumns(): number {
  const { stdout } = useStdout();
  const [columns, setColumns] = useState(stdout.columns ?? 80);
  useEffect(() => {
    const onResize = () => setColumns(stdout.columns ?? 80);
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);
  return columns;
}

export function RoutesScreen({ deps, onExit }: { deps?: RoutesScreenDeps; onExit: () => void }) {
  const [io] = useState(() => deps ?? defaultRoutesScreenDeps());
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [reading, setReading] = useState<Reading | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [removing, setRemoving] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [form, setForm] = useState<FormOpen | null>(null);
  /** Quota of the accounts no route took, read for the form: they are on its rows. */
  const [extra, setExtra] = useState<Record<string, QuotaSnapshot>>({});
  const columns = useColumns();
  const alive = useRef(true);
  /** Only the latest read is shown: an `r` pressed twice must not end on the older answer. */
  const readSeq = useRef(0);

  const rank = useCallback(
    async (file: RoutesFile, registry: Registry | null, refresh: boolean) => {
      const seq = ++readSeq.current;
      const [quotas, lastPicked] = await Promise.all([
        settle(() => io.collectQuotas(targetsOf(file, registry), { refresh }), {}),
        settle(() => io.readPicks(), {}),
      ]);
      if (!alive.current || seq !== readSeq.current) return;
      setReading({ quotas, lastPicked, now: io.clock() });
      setRefreshing(false);
    },
    [io],
  );

  useEffect(() => {
    alive.current = true;
    void (async () => {
      try {
        const [file, registry] = await Promise.all([io.readRoutes(), io.loadRegistry()]);
        // A profiles.json that cannot be read loads as none at all, which listed every route with
        // no accounts. None that is not there is clausona not set up, which the App sends to init.
        const problem = registry === null ? await io.registryProblem() : null;
        if (!alive.current) return;
        if (problem) {
          setLoaded({ kind: "broken", error: new Error(problem) });
          return;
        }
        // Painted at once; the quota follows.
        setLoaded({ kind: "ready", file, registry });
        await rank(file, registry, false);
      } catch (error) {
        if (alive.current) setLoaded({ kind: "broken", error });
      }
    })();
    return () => {
      alive.current = false;
    };
  }, [io, rank]);

  /** Everything read so far: a saved route whose accounts were read for the form shows them at once. */
  const shown = useMemo(() => reading && { ...reading, quotas: { ...extra, ...reading.quotas } }, [reading, extra]);
  const entries = useMemo(
    () => (loaded.kind === "ready" ? rankAll(loaded.file, loaded.registry, shown, io.clock()) : []),
    [loaded, shown, io],
  );
  const index = Math.min(cursor, Math.max(0, entries.length - 1));
  const selected = entries[index];

  async function remove(name: string) {
    try {
      const file = await io.updateRoutes((current) => {
        if (!Object.hasOwn(current.routes, name)) return null;
        delete current.routes[name];
        return current;
      });
      if (!alive.current) return;
      setLoaded((prev) => (prev.kind === "ready" ? { ...prev, file } : prev));
      setCursor((prev) => Math.max(0, Math.min(prev, Object.keys(file.routes).length - 1)));
    } catch (error) {
      if (!alive.current) return;
      if (error instanceof RoutesFileError) setLoaded({ kind: "broken", error });
      else setMessage(`${symbol.cross} ${errorText(error)}`);
    }
  }

  function openForm(open: FormOpen) {
    if (loaded.kind !== "ready") return;
    setForm(open);
    if (!loaded.registry) return;
    // The form offers every subscription account, so the ones no route takes are read too: from
    // the quota cache while it is fresh, else fetched, which may renew a lapsed sign-in as the
    // dashboard's own read does (collectQuotas' rules, never a forced refresh).
    const read = new Set([
      ...targetsOf(loaded.file, loaded.registry).map((target) => target.id),
      ...Object.keys(extra),
    ]);
    const missing = everyTarget(loaded.registry).filter((target) => !read.has(target.id));
    if (missing.length === 0) return;
    void settle(() => io.collectQuotas(missing), {}).then((quotas) => {
      if (alive.current) setExtra((prev) => ({ ...prev, ...quotas }));
    });
  }

  /**
   * Back to the list, with routes.json read again whichever way the form was left: it may have
   * saved, or found the file changed by another terminal and reloaded. The saved route is
   * selected, else the one that was.
   */
  async function closeForm(saved: string | null) {
    setForm(null);
    if (loaded.kind !== "ready") return;
    const { registry } = loaded;
    const keep = saved ?? selected?.name;
    try {
      const file = await io.readRoutes();
      if (!alive.current) return;
      if (saved === null && JSON.stringify(file) === JSON.stringify(loaded.file)) return;
      setLoaded({ kind: "ready", file, registry });
      setCursor(Math.max(0, keep === undefined ? 0 : Object.keys(file.routes).sort().indexOf(keep)));
      await rank(file, registry, false);
    } catch (error) {
      if (alive.current) setLoaded({ kind: "broken", error });
    }
  }

  const handle = (input: string, key: Key) => {
    // The question takes the next key, whatever it is: only y removes.
    if (removing) {
      setRemoving(null);
      if (input === "y" || input === "Y") void remove(removing);
      return;
    }
    if (key.escape) {
      onExit();
      return;
    }
    // Loading, or a routes.json that cannot be used: esc is the only key.
    if (loaded.kind !== "ready") return;
    setMessage("");
    const count = entries.length;
    if (key.upArrow && count > 0) setCursor((index - 1 + count) % count);
    else if (key.downArrow && count > 0) setCursor((index + 1) % count);
    else if (input === "r") {
      setRefreshing(true);
      void rank(loaded.file, loaded.registry, true);
    } else if (input === "d" && selected) setRemoving(selected.name);
    else if (input === "n") openForm({ mode: "new" });
    else if (input === "e" && selected) {
      openForm({ mode: "edit", name: selected.name, spec: loaded.file.routes[selected.name] });
    }
  };
  // Answered with the state on screen, as the App's keys are (`useCommittedHandler` in App.tsx).
  const handler = useRef(handle);
  useLayoutEffect(() => {
    handler.current = handle;
  });
  const onInput = useCallback((input: string, key: Key) => handler.current(input, key), []);
  // The form answers its own keys.
  useInput(onInput, { isActive: form === null });

  const question = removing ? `Remove route ${removing}? (y/N)` : undefined;
  const footer = refreshing ? "Reading quota again…" : message || undefined;
  const hints = removing ? CONFIRM_HINTS : loaded.kind === "ready" ? HINTS : BACK_HINTS;

  if (loaded.kind !== "ready") {
    return (
      <Chrome title="Routes" hints={hints}>
        {loaded.kind === "loading" ? (
          <Text color={color.muted}>Reading routes…</Text>
        ) : (
          <FileProblem error={loaded.error} />
        )}
      </Chrome>
    );
  }

  if (form) {
    return (
      <RouteForm
        {...form}
        accounts={formAccounts(loaded.registry ?? NO_PROFILES)}
        quotas={shown?.quotas ?? extra}
        lastPicked={reading?.lastPicked ?? {}}
        registry={loaded.registry ?? NO_PROFILES}
        deps={io}
        now={reading?.now ?? io.clock()}
        onDone={(saved) => void closeForm(saved)}
      />
    );
  }

  const wide = columns >= WIDE_AT;
  return (
    <Chrome title="Routes" footer={footer} question={question} hints={hints}>
      <Box flexDirection={wide ? "row" : "column"} gap={wide ? 2 : 1} width="100%">
        <Box
          flexDirection="column"
          width={wide ? LIST_WIDTH : "100%"}
          flexShrink={0}
          borderStyle="round"
          borderColor={color.dim}
          paddingX={1}
        >
          {entries.length > 0 ? (
            <RouteList entries={entries} index={index} pending={reading === null} />
          ) : (
            <Text color={color.muted}>No routes yet.</Text>
          )}
        </Box>
        <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={1}>
          {selected ? <RouteDetail entry={selected} pending={reading === null} /> : <NoRoutes />}
        </Box>
      </Box>
    </Chrome>
  );
}

/** Why routes.json (or the registry) cannot be read, in the words `csn route list` would print. */
function FileProblem({ error }: { error: unknown }) {
  const headline = error instanceof RoutesFileError ? `${error.filePath} cannot be used:` : errorText(error);
  return (
    <Box flexDirection="column">
      <Box gap={1}>
        <Box flexShrink={0}>
          <Text color={color.error}>{symbol.cross}</Text>
        </Box>
        <Text color={color.text}>{headline}</Text>
      </Box>
      {error instanceof RoutesFileError ? (
        <>
          <Box paddingLeft={4}>
            <Text color={color.text}>{error.problems.join("\n")}</Text>
          </Box>
          {/* A file from a newer clausona is fixed by updating, which its problem says. */}
          {error.newer ? null : (
            <Box marginTop={1}>
              <Text color={color.secondary}>Fix it with csn route edit.</Text>
            </Box>
          )}
        </>
      ) : null}
    </Box>
  );
}

function NoRoutes() {
  return (
    <Box flexDirection="column">
      <Text color={color.text}>
        {`A route picks the account for you: the next one in turn that is under ${DEFAULT_MAX_USAGE}% of its 5-hour and weekly limits.`}
      </Text>
      <Box marginTop={1}>
        <Text color={color.secondary}>Press n to create your first route.</Text>
      </Box>
    </Box>
  );
}

/** `<free>/<members>`, as `route list` counts them; `…` for free until the quota is read. */
function countText(ranking: Ranking, pending: boolean): string {
  const { free, members } = freeNow(ranking);
  return `${pending ? "…" : free}/${members}`;
}

function RouteList({ entries, index, pending }: { entries: Entry[]; index: number; pending: boolean }) {
  const [list, width] = useWidth();
  const counts = entries.map((entry) => countText(entry.ranking, pending));
  const toolWidth = Math.max(...entries.map((entry) => entry.route.tool.length));
  const countWidth = Math.max(...counts.map((count) => count.length));
  const longest = Math.max(...entries.map((entry) => entry.name.length));
  const nameWidth = Math.max(1, Math.min(longest, width - MARK - GAP - toolWidth - GAP - countWidth));
  return (
    <Box ref={list} flexDirection="column">
      {entries.map((entry, i) => {
        const focused = i === index;
        const nobody = !pending && freeNow(entry.ranking).free === 0;
        return (
          <Box key={entry.name} flexDirection="row">
            <Box width={MARK} flexShrink={0}>
              <Text color={focused ? color.cursor : color.dim}>{focused ? "▸" : " "}</Text>
            </Box>
            <Box width={nameWidth} flexShrink={0}>
              <Text color={focused ? color.text : color.secondary} bold={focused} wrap="truncate-end">
                {entry.name}
              </Text>
            </Box>
            <Box width={toolWidth} marginLeft={GAP} flexShrink={0}>
              <Text color={color.muted}>{entry.route.tool}</Text>
            </Box>
            <Box marginLeft={GAP} flexShrink={0}>
              <Text color={pending ? color.muted : nobody ? color.warning : color.text}>
                {counts[i].padStart(countWidth)}
              </Text>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}
