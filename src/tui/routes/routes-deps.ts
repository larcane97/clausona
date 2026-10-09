import { collectQuotas, type QuotaTarget } from "../../core/quota-store.js";
import type { RoutesFile } from "../../core/route-config.js";
import { readPicks, readRoutes, readRoutesText, routesPaths, updateRoutes } from "../../core/routes-store.js";
import { loadRegistry, registryProblem } from "../../lib/service.js";
import type { QuotaSnapshot, Registry } from "../../types.js";

/**
 * What the Routes screen and its form reach outside themselves, injectable for tests. Its own
 * module, so the form takes it without importing the screen that opens the form.
 */
export type RoutesScreenDeps = {
  loadRegistry: () => Promise<Registry | null>;
  /**
   * Why profiles.json cannot be used, or null when it can or is not there: `loadRegistry` reads
   * a file it cannot use exactly as it reads no file.
   */
  registryProblem: () => Promise<string | null>;
  readRoutes: () => Promise<RoutesFile>;
  updateRoutes: (update: (file: RoutesFile) => RoutesFile | null) => Promise<RoutesFile>;
  collectQuotas: (targets: QuotaTarget[], options?: { refresh?: boolean }) => Promise<Record<string, QuotaSnapshot>>;
  readPicks: () => Promise<Record<string, string>>;
  clock: () => number;
  /** routes.json as it is on disk, or null for none: the form saves only over the text it opened on. */
  readRoutesText: () => Promise<string | null>;
};

export function defaultRoutesScreenDeps(): RoutesScreenDeps {
  const paths = routesPaths();
  return {
    loadRegistry,
    registryProblem,
    readRoutes: () => readRoutes(paths),
    updateRoutes: (update) => updateRoutes(update, paths),
    collectQuotas: (targets, options) => collectQuotas(targets, { refresh: options?.refresh }),
    readPicks: () => readPicks(paths),
    clock: () => Date.now(),
    readRoutesText: () => readRoutesText(paths),
  };
}

/** A failed read or write, in the words the screen and its form show it. */
export const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
