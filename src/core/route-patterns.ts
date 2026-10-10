import type { ToolName } from "../types.js";

/** A registered profile as routing sees it. */
export type Member = {
  /** `tool:name`, the registry key. */
  id: string;
  tool: ToolName;
  name: string;
  /** The account email; empty for an API profile. */
  email: string;
  kind: "subscription" | "api";
  /** The primary, or a profile with merged sessions: it sees the shared session history. */
  sharesSessions: boolean;
  configDir: string;
};

/** The form two names are compared in, as foldProfileName (src/lib/profile-ref.ts) does. */
const fold = (value: string) => value.normalize("NFKC").toLowerCase();

const hasGlob = (pattern: string) => /[*?]/.test(pattern);

/** Orders anything with an id - a member, a ranked row, a form's account - by that id. */
export const compareIds = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** A glob as an anchored, case-folded RegExp: `*` any run, `?` one character, the rest literal. */
export function globToRegExp(glob: string): RegExp {
  let source = "";
  for (const ch of fold(glob)) {
    if (ch === "*") source += ".*";
    else if (ch === "?") source += ".";
    else source += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, "u");
}

/**
 * A pattern's `tool:` prefix (null when it has none) and the rest, which is what is compared. A name
 * or an email pattern may carry the prefix; a colon after the `@` is not one. checkPattern
 * (route-config.ts) splits a pattern with this too, so a saved pattern is read as it was checked.
 */
export function splitToolPrefix(pattern: string): { prefix: string | null; body: string } {
  const colon = pattern.indexOf(":");
  const at = pattern.indexOf("@");
  if (colon === -1 || (at !== -1 && at < colon)) return { prefix: null, body: pattern };
  return { prefix: pattern.slice(0, colon), body: pattern.slice(colon + 1) };
}

export function matchesMember(pattern: string, member: Member): boolean {
  const { prefix, body } = splitToolPrefix(pattern.trim());
  // A prefix names one tool, so a pattern for another tool never matches.
  if (prefix !== null && prefix !== member.tool) return false;
  const isEmail = body.includes("@");
  // An API profile is billed per use, so it joins a route only by its exact name.
  if (member.kind === "api" && (isEmail || hasGlob(body))) return false;
  const subject = isEmail ? member.email : member.name;
  if (!subject) return false;
  return globToRegExp(body).test(fold(subject));
}

export type Expansion = {
  /** In the order the patterns are listed; within one pattern, by id. Each member once. */
  members: Array<{ member: Member; pattern: string }>;
  /** Exact names that match no registered profile: removed, or never added. */
  unknownNames: string[];
  /** Glob or email patterns that match nobody. Not an error: accounts come and go. */
  emptyPatterns: string[];
};

/** Expands patterns over the members of one tool. */
export function expandPatterns(patterns: string[], members: Member[]): Expansion {
  const out: Expansion = { members: [], unknownNames: [], emptyPatterns: [] };
  const seen = new Set<string>();
  const sorted = [...members].sort(compareIds);
  for (const pattern of patterns) {
    const matched = sorted.filter((member) => matchesMember(pattern, member));
    if (matched.length === 0) {
      const { body } = splitToolPrefix(pattern.trim());
      if (hasGlob(body) || body.includes("@")) out.emptyPatterns.push(pattern);
      else out.unknownNames.push(pattern);
    }
    for (const member of matched) {
      if (seen.has(member.id)) continue;
      seen.add(member.id);
      out.members.push({ member, pattern });
    }
  }
  return out;
}
