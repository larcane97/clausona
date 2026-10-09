import { Box, type Key, Text, useInput, useStdout } from "ink";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { collectQuotas, type QuotaTarget } from "../../core/quota-store.js";
import { DEFAULT_MAX_USAGE, type Route, type RoutesFile, withDefaults } from "../../core/route-config.js";
import { RoutesFileError, readPicks, readRoutes, routesPaths, updateRoutes } from "../../core/routes-store.js";
import { type Ranking, type Row, rankRoute } from "../../core/routing.js";
import { fitQuotaValue } from "../../lib/format.js";
import { detailOrder, freeNow, skipReason, toolLabel } from "../../lib/route-render.js";
import { membersOf, quotaTargets } from "../../lib/route-service.js";
import { loadRegistry } from "../../lib/service.js";
import type { QuotaSnapshot, QuotaWindow, Registry } from "../../types.js";
import { Chrome } from "../components/Chrome.js";
import { QuotaCell } from "../components/QuotaCell.js";
import { color, symbol } from "../theme.js";
import { useWidth } from "../use-width.js";

/**
 * The dashboard's Routes screen: every route, and the one selected with its members ranked as
 * `csn route explain` ranks them. It reads routes.json, the registry, quota and the pick record,
 * and writes only when a route is removed; a pick is never recorded here.
 */

/** What the screen reaches outside itself, injectable for tests. */
export type RoutesScreenDeps = {
  loadRegistry: () => Promise<Registry | null>;
  readRoutes: () => Promise<RoutesFile>;
  updateRoutes: (update: (file: RoutesFile) => RoutesFile | null) => Promise<RoutesFile>;
  collectQuotas: (targets: QuotaTarget[], options?: { refresh?: boolean }) => Promise<Record<string, QuotaSnapshot>>;
  readPicks: () => Promise<Record<string, string>>;
  clock: () => number;
};

export function defaultRoutesScreenDeps(): RoutesScreenDeps {
  const paths = routesPaths();
  return {
    loadRegistry,
    readRoutes: () => readRoutes(paths),
    updateRoutes: (update) => updateRoutes(update, paths),
    collectQuotas: (targets, options) => collectQuotas(targets, { refresh: options?.refresh }),
    readPicks: () => readPicks(paths),
    clock: () => Date.now(),
  };
}

/** From this many terminal columns the detail sits beside the list; below, under it. */
const WIDE_AT = 100;
const LIST_WIDTH = 30;
/** A row's mark (`▸`) and the space after it. */
const MARK = 2;
const GAP = 2;
/** The widths a quota cell is tried at, widest first: gauge and reset, percentage and reset, percentage. */
const QUOTA_WIDTHS = [19, 8, 4];

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

type Entry = { name: string; route: Route; ranking: Ranking };

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

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
        if (!alive.current) return;
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

  const entries = useMemo(
    () => (loaded.kind === "ready" ? rankAll(loaded.file, loaded.registry, reading, io.clock()) : []),
    [loaded, reading, io],
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
  };
  // Answered with the state on screen, as the App's keys are (`useCommittedHandler` in App.tsx).
  const handler = useRef(handle);
  useLayoutEffect(() => {
    handler.current = handle;
  });
  const onInput = useCallback((input: string, key: Key) => handler.current(input, key), []);
  useInput(onInput);

  const footer = removing
    ? `Remove route ${removing}? (y/N)`
    : refreshing
      ? "Reading quota again…"
      : message || undefined;
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

  const wide = columns >= WIDE_AT;
  return (
    <Chrome title="Routes" footer={footer} hints={hints}>
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

function Setting({ label, value }: { label: string; value: string }) {
  return (
    <Box flexDirection="row">
      <Box width={10} flexShrink={0}>
        <Text color={color.muted}>{label}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1} minWidth={0}>
        <Text color={color.text}>{value}</Text>
      </Box>
    </Box>
  );
}

function RouteDetail({ entry, pending }: { entry: Entry; pending: boolean }) {
  const { name, route, ranking } = entry;
  const [detail, width] = useWidth();
  return (
    <Box ref={detail} flexDirection="column">
      <Text color={color.text} bold wrap="truncate-end">
        {name}
      </Text>
      <Text color={color.muted}>
        {`${toolLabel(route.tool)} · ${route.strategy} · skip at ${route.maxUsage}%, reserve to ${route.reserveUsage}%`}
      </Text>
      <Setting
        label="Accounts"
        value={`${route.from.join(", ")}${route.exclude.length ? ` except ${route.exclude.join(", ")}` : ""}`}
      />
      <Setting label="Fallback" value={route.fallback.length ? route.fallback.join(", ") : "none"} />
      <MemberTable ranking={ranking} pending={pending} width={width} />
    </Box>
  );
}

/** A member table line: a ranked row with its two quota cells, or a name whose status runs across them. */
type Line = { key: string; id: string; picked: boolean; fallback: boolean; row?: Row; status: string; tone: string };

function statusOf(row: Row, ranking: Ranking): string {
  const { outcome, route } = ranking;
  if (row.status === "picked")
    return outcome.kind === "picked" && outcome.stage === "reserve" ? "next (reserve)" : "next";
  if (row.status === "over-limit") return `over ${route.maxUsage}%`;
  return "";
}

function lineOf(row: Row, ranking: Ranking, pending: boolean): Line {
  const base = { key: `row:${row.id}`, id: row.id, picked: row.status === "picked", fallback: row.role === "fallback" };
  // Before the quota is read every member reads as unread; those are the ones still loading.
  if (pending && row.skip === "no-reading") return { ...base, status: "loading…", tone: color.muted };
  if (row.skip) return { ...base, status: skipReason(row), tone: color.muted };
  return { ...base, row, status: statusOf(row, ranking), tone: base.picked ? color.accent : color.warning };
}

/** The widest a column of cells is at `width`: fitQuotaValue drops what does not fit. */
function quotaColumn(windows: QuotaWindow[], width: number): number {
  return Math.max(2, ...windows.map((window) => fitQuotaValue(window, width).length));
}

/** Text after a gap that takes the rest of the line, cut rather than wrapped. */
function Rest({ text, tone }: { text: string; tone: string }) {
  return (
    <Box marginLeft={GAP} flexGrow={1} flexShrink={1} minWidth={0}>
      <Text color={tone} wrap="truncate-end">
        {text}
      </Text>
    </Box>
  );
}

function MemberLine({ line, idWidth, quota }: { line: Line; idWidth: number; quota: number }) {
  const { row } = line;
  // The window that sets the member's usage is bold, as in `csn route explain`.
  const cell = (window: QuotaWindow | undefined, which: "5H" | "7D") => (
    <Box marginLeft={GAP} width={quota} flexShrink={0}>
      <QuotaCell window={window} live={!row?.usage?.stale} width={quota} bold={row?.usage?.window === which} />
    </Box>
  );
  return (
    <Box flexDirection="row">
      <Box width={MARK} flexShrink={0}>
        <Text color={color.accent}>{line.picked ? "▸" : " "}</Text>
      </Box>
      <Box width={idWidth} flexShrink={0}>
        <Text color={line.picked ? color.accent : color.text} wrap="truncate-end">
          {line.id}
          {line.fallback ? <Text color={color.muted}> (fallback)</Text> : null}
        </Text>
      </Box>
      {row ? cell(row.fiveHour, "5H") : null}
      {row ? cell(row.sevenDay, "7D") : null}
      {line.status ? <Rest text={line.status} tone={line.tone} /> : null}
    </Box>
  );
}

const FALLBACK_TAG = " (fallback)".length;

function MemberTable({ ranking, pending, width }: { ranking: Ranking; pending: boolean; width: number }) {
  const members = detailOrder(ranking.rows.filter((row) => row.skip !== "not-registered"));
  const unknown = ranking.rows.filter((row) => row.skip === "not-registered");
  const lines: Line[] = [
    ...[...members, ...unknown].map((row) => lineOf(row, ranking, pending)),
    ...[...new Set(ranking.emptyPatterns)].map(
      (pattern): Line => ({
        key: `pattern:${pattern}`,
        id: pattern,
        picked: false,
        fallback: false,
        status: "matches nobody",
        tone: color.muted,
      }),
    ),
  ];
  const windows = lines.flatMap(({ row }) =>
    [row?.fiveHour, row?.sevenDay].filter((window): window is QuotaWindow => window !== undefined),
  );
  const status = Math.max(0, ...lines.filter((line) => line.row).map((line) => line.status.length));
  const longest = Math.max(
    "ACCOUNT".length,
    ...lines.map((line) => line.id.length + (line.fallback ? FALLBACK_TAG : 0)),
  );
  /** A line's width but for its id: the mark, the two quota cells and the status, each after a gap. */
  const around = (quota: number) => MARK + 2 * (GAP + quota) + (status ? GAP + status : 0);
  // The most detailed cells that fit beside whole ids; failing that, percentages only and the ids cut.
  const fitting = QUOTA_WIDTHS.map((at) => quotaColumn(windows, at)).find((quota) => around(quota) + longest <= width);
  const quota = fitting ?? quotaColumn(windows, QUOTA_WIDTHS[QUOTA_WIDTHS.length - 1]);
  const idWidth = fitting === undefined ? Math.max("ACCOUNT".length, width - around(quota)) : longest;

  return (
    <Box flexDirection="column" marginTop={1}>
      {lines.length > 0 ? (
        <Box flexDirection="row">
          <Box width={MARK + idWidth} flexShrink={0}>
            <Text color={color.muted}>{" ".repeat(MARK)}ACCOUNT</Text>
          </Box>
          <Box marginLeft={GAP} width={quota} flexShrink={0}>
            <Text color={color.muted}>5H</Text>
          </Box>
          <Box marginLeft={GAP} width={quota} flexShrink={0}>
            <Text color={color.muted}>7D</Text>
          </Box>
        </Box>
      ) : null}
      {lines.map((line) => (
        <MemberLine key={line.key} line={line} idWidth={idWidth} quota={quota} />
      ))}
      {ranking.excluded.map((entry) => (
        <Box key={`excluded:${entry.id}`} paddingLeft={MARK}>
          <Text color={color.muted} wrap="truncate-end">{`excluded  ${entry.id} (${entry.pattern})`}</Text>
        </Box>
      ))}
    </Box>
  );
}
