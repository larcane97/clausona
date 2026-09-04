import type { DoctorIssue } from "../types.js";

export function evaluateSymlinkHealth({
  isPrimary,
  items,
}: {
  isPrimary: boolean;
  items: Array<{
    name: string;
    isSharedLink: boolean;
    pointsToPrimary: boolean;
    targetExists: boolean;
    existsInPrimary: boolean;
  }>;
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

  return issues;
}
