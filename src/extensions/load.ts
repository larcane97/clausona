import { homedir } from "node:os";

import { loadRegistry, noRegistryError } from "../lib/service.js";
import { loadInventory } from "./inventory.js";
import type { Inventory } from "./model.js";

/** The inventory as the dashboard opens it: this user's registry and home, from where csn was started. */
export async function loadInventoryHere(): Promise<Inventory> {
  const registry = await loadRegistry();
  if (!registry) throw await noRegistryError();
  return loadInventory({ homeDir: homedir(), registry, cwd: process.cwd() });
}
