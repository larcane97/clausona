import type { ToolName } from "../types.js";
import { claudeAdapter } from "./claude.js";
import { codexAdapter } from "./codex.js";
import type { ToolAdapter } from "./types.js";

const ADAPTERS: Record<ToolName, ToolAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
};

export function getAdapter(tool: ToolName): ToolAdapter {
  return ADAPTERS[tool];
}

export function allAdapters(): ToolAdapter[] {
  return Object.values(ADAPTERS);
}

export const ALL_TOOLS: ToolName[] = ["claude", "codex"];
