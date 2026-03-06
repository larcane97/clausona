// ─── Design System ───────────────────────────────────────────────
// Aesthetic: "Modern CLI" — vibrant colors, clear layout,
// styled badges, and clean geometry.

export const color = {
  // Core palette
  brand: "#6366f1",       // indigo-500  — primary brand (backgrounds/accents)
  brandLight: "#818cf8",  // indigo-400  — primary text highlights
  accent: "#ec4899",      // pink-500    — secondary accent (cursors)
  surface: "#18181b",     // zinc-900    — panel backgrounds

  // Text hierarchy
  text: "#f4f4f5",        // zinc-100  — primary text
  secondary: "#a1a1aa",   // zinc-400  — secondary text
  muted: "#71717a",       // zinc-500  — tertiary / dimmed
  dim: "#3f3f46",         // zinc-700  — borders, separators

  // Semantic status
  healthy: "#10b981",     // emerald-500
  warning: "#f59e0b",     // amber-500
  error: "#ef4444",       // red-500
  info: "#3b82f6",        // blue-500

  // Interactive
  active: "#818cf8",      // matches brandLight
  cursor: "#ec4899",      // pink-500
  selected: "#818cf8",    // indigo-400
} as const;

export const symbol = {
  // Navigation
  cursor: "✦",
  cursorEmpty: " ",

  // Status
  check: "✔",
  cross: "✘",
  dot: "●",
  circle: "○",
  diamond: "◈",

  // Checkboxes
  checkboxOn: "◉",
  checkboxOff: "○",

  // Decorative
  arrow: "➔",
  arrowLeft: "←",
  sep: "│",
  pipe: "│",
  ellipsis: "…",

  // Box drawing
  lineH: "─",
  lineV: "│",
  cornerTL: "╭",
  cornerTR: "╮",
  cornerBL: "╰",
  cornerBR: "╯",
  teeR: "├",
  teeL: "┤",
} as const;

export const layout = {
  maxWidth: 80,
  panelGap: 2,
  listPanelWidth: "55%",
  previewPanelWidth: "45%",
  paddingX: 2,
  paddingY: 0,
} as const;

/** Repeat a character n times */
export function line(char: string, n: number): string {
  return char.repeat(Math.max(0, n));
}

/** Format a key hint like  ↑↓ navigate */
export function keyHint(keys: string, action: string): string {
  return `${keys} ${action}`;
}
