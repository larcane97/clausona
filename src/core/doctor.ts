import type { DoctorIssue } from "../types.js";

export function evaluateSymlinkHealth({
  isPrimary,
  items,
  missingSharedDirs = [],
}: {
  isPrimary: boolean;
  items: Array<{
    name: string;
    isSharedLink: boolean;
    pointsToPrimary: boolean;
    targetExists: boolean;
    existsInPrimary: boolean;
  }>;
  /**
   * Directories that exist in the primary config dir but are absent from this
   * profile. Shared links are only ever created from a snapshot of the primary
   * taken when the profile was set up, so anything the tool adds in a later
   * version never reaches an existing profile — the tool then creates it locally
   * and the two accounts silently stop sharing that state.
   *
   * Only directories are reported. Files in the primary are dominated by
   * transient state (`*.tmp.*`, `settings.json.bak.*`) that no profile is ever
   * expected to carry, and a file's shared link is replaced by a real file the
   * first time the tool writes it atomically — so file-level gaps are noise,
   * while a missing directory is always a real sharing gap.
   */
  missingSharedDirs?: string[];
}): DoctorIssue[] {
  if (isPrimary) {
    return [];
  }

  const issues: DoctorIssue[] = [];
  for (const item of items) {
    if (item.isSharedLink && !item.targetExists) {
      issues.push({
        kind: "broken_symlink",
        message: `${item.name} shared link points to a missing target`,
      });
    }

    // Should be a shared link to primary but isn't
    if (!item.pointsToPrimary && item.existsInPrimary) {
      issues.push({
        kind: "local_override",
        message: `${item.name} replaced an expected shared link`,
      });
    }
  }

  for (const name of missingSharedDirs) {
    issues.push({
      kind: "missing_shared_link",
      message: `${name}/ is shared in primary but missing here — run 'clausona repair'`,
    });
  }

  return issues;
}
