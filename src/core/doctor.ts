import type { DoctorIssue } from "../types.js";

export function evaluateSymlinkHealth({
  isPrimary,
  items,
}: {
  isPrimary: boolean;
  items: Array<{ name: string; isSymlink: boolean; pointsToPrimary: boolean; targetExists: boolean; existsInPrimary: boolean }>;
}): DoctorIssue[] {
  if (isPrimary) {
    return [];
  }

  const issues: DoctorIssue[] = [];
  for (const item of items) {
    if (item.isSymlink && !item.targetExists) {
      issues.push({
        kind: "broken_symlink",
        message: `${item.name} points to a missing target`,
      });
    }

    // Should be a symlink to primary but isn't
    if (!item.pointsToPrimary && item.existsInPrimary) {
      issues.push({
        kind: "local_override",
        message: `${item.name} replaced an expected shared symlink`,
      });
    }
  }

  return issues;
}
