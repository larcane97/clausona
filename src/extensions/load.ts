import { homedir } from "node:os";

import { loadRegistry, noRegistryError } from "../lib/service.js";
import type { Action, ExtensionsCommand } from "./actions.js";
import {
  type ApplyResult,
  apply,
  lastOperation,
  type UndoPreview,
  type UndoResult,
  undo,
  writeEnvFor,
} from "./apply.js";
import { planChecked } from "./git-tracked.js";
import { loadInventory } from "./inventory.js";
import type { Inventory } from "./model.js";
import type { Plan, PlanContext } from "./plan.js";

/** The inventory as the dashboard opens it: this user's registry and home, from where csn was started. */
export async function loadInventoryHere(): Promise<Inventory> {
  const registry = await loadRegistry();
  if (!registry) throw await noRegistryError();
  return loadInventory({ homeDir: homedir(), registry, cwd: process.cwd() });
}

/**
 * What the Extensions screen writes with, handed to it as a prop: the TUI imports apply.ts,
 * writers and git-tracked.ts as types only. Undo here is of any command (rule F).
 */
export type ScreenWrites = {
  homeDir: string;
  backupRoot: string;
  stashDir: string;
  planChecked(
    ctx: Omit<PlanContext, "tracked" | "stashDir">,
    command: ExtensionsCommand,
    action: Action,
  ): Promise<{ plan: Plan; tracked: ReadonlySet<string> }>;
  apply(plan: Plan): Promise<ApplyResult>;
  /** The newest change not undone yet, of any command. */
  lastOperation(): Promise<UndoPreview | null>;
  /** Undoes that change. */
  undo(): Promise<UndoResult | null>;
};

/** The writes for `homeDir`: backups and kept copies under its ~/.clausona, `git` for what git tracks. */
export function writesFor(homeDir: string, options: { now?: () => number; git?: string } = {}): ScreenWrites {
  const env = writeEnvFor(homeDir, options.now);
  const git = options.git !== undefined ? { git: options.git } : {};
  return {
    homeDir,
    backupRoot: env.backupRoot,
    stashDir: env.stashDir,
    planChecked: (ctx, command, action) => planChecked({ ...ctx, stashDir: env.stashDir }, command, action, git),
    apply: (plan) => apply(plan, env),
    lastOperation: () => lastOperation(env),
    undo: () => undo(env),
  };
}

/** The writes for this user's home. */
export function writesHere(): ScreenWrites {
  return writesFor(homedir());
}
