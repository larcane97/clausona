import { ALL_TOOLS } from "../tools/registry.js";
import type { Registry, ToolName } from "../types.js";

export type ParsedProfileRef = { tool: ToolName; name: string; id: string };

export function profileId(tool: ToolName, name: string): string {
  return `${tool}:${name}`;
}

function isToolName(value: string): value is ToolName {
  return (ALL_TOOLS as string[]).includes(value);
}

export function parseProfileRef(input: string, registry: Registry): ParsedProfileRef {
  if (input.includes(":")) {
    const [maybeTool, ...rest] = input.split(":");
    const name = rest.join(":");
    if (!isToolName(maybeTool)) {
      throw new Error(`Unknown tool '${maybeTool}'. Use one of: ${ALL_TOOLS.join(", ")}.`);
    }
    const id = profileId(maybeTool, name);
    if (!registry.profiles[id]) {
      throw new Error(`Profile '${id}' not found.`);
    }
    return { tool: maybeTool, name, id };
  }

  const candidates: ParsedProfileRef[] = [];
  for (const tool of ALL_TOOLS) {
    const id = profileId(tool, input);
    if (registry.profiles[id]) candidates.push({ tool, name: input, id });
  }
  if (candidates.length === 0) throw new Error(`Profile '${input}' not found.`);
  if (candidates.length > 1) {
    const list = candidates.map((c) => `'${c.id}'`).join(" or ");
    throw new Error(`'${input}' exists in both claude and codex. Use ${list}.`);
  }
  return candidates[0];
}
