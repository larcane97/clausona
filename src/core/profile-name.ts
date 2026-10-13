/**
 * The form in which two names are compared. A case-insensitive filesystem (macOS and Windows
 * by default) treats `Work` and `work` as one directory, and APFS folds more than ASCII
 * case - `ſ` (U+017F) is `s` to it - which NFKC normalization covers.
 *
 * It lives in core so that route patterns, which name profiles, compare names the same way.
 */
export function foldProfileName(name: string): string {
  return name.normalize("NFKC").toLowerCase();
}
