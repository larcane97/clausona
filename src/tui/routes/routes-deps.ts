import { collectQuotas, type QuotaTarget } from "../../core/quota-store.js";
import type { RoutesFile } from "../../core/route-config.js";
import { type PathSystem, pathSystem } from "../../core/route-rules.js";
import {
  type LoadedRoutes,
  loadRoutes,
  readPicks,
  readRoutes,
  routesPaths,
  updateRoutes,
} from "../../core/routes-store.js";
import { namesOf } from "../../lib/route-service.js";
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
};

/**
 * The screen's own, beyond its form's: routes.json with the routes that cannot be used set apart,
 * and how its dir rules read a directory: from where clausona was started, `~` for home.
 */
export type RoutesListDeps = RoutesScreenDeps & {
  loadRoutes: () => Promise<LoadedRoutes>;
  cwd: string;
  system: PathSystem;
};

export function defaultRoutesScreenDeps(): RoutesListDeps {
  const paths = routesPaths();
  // Read with each use, as the CLI does: a profile added meanwhile is a name routes.json may hold.
  const names = async () => namesOf(await loadRegistry());
  return {
    loadRegistry,
    registryProblem,
    loadRoutes: async () => loadRoutes(paths, await names()),
    readRoutes: async () => readRoutes(paths, await names()),
    updateRoutes: async (update) => updateRoutes(update, paths, await names()),
    collectQuotas: (targets, options) => collectQuotas(targets, { refresh: options?.refresh }),
    readPicks: () => readPicks(paths),
    clock: () => Date.now(),
    cwd: process.cwd(),
    system: pathSystem(),
  };
}

/** A failed read or write, in the words the screen and its form show it. */
export const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
