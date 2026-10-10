import { createHash } from "node:crypto";

/**
 * Fingerprints of what clausona reads, so a write can tell that what it is about to change is
 * still what it read: a server's or a hook's raw entry, a file's bytes. Pure. A fingerprint is
 * kept in the inventory and in manifests, never printed: it is unsalted, so a short secret's
 * could be guessed from it.
 */

function isDateLike(value: unknown): value is { toISOString(): string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { toISOString?: unknown }).toISOString === "function"
  );
}

/**
 * JSON with object keys sorted at every depth; a Date-like value (has toISOString) as its ISO
 * string; undefined in an array as null. A Date-like value is how smol-toml reads a TOML date or
 * time. Like JSON.stringify, a key whose value is undefined is left out.
 */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : canonical(v))).join(",")}]`;
  if (isDateLike(value)) return JSON.stringify(value.toISOString());
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    // Written out by hand rather than rebuilt as an object: a "__proto__" key stays a key.
    const fields = Object.keys(record)
      .sort()
      .flatMap((key) => (record[key] === undefined ? [] : [`${JSON.stringify(key)}:${canonical(record[key])}`]));
    return `{${fields.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** sha256 hex of canonical(value). */
export function valueHash(value: unknown): string {
  return bytesHash(canonical(value));
}

/** sha256 hex of a string (UTF-8) or bytes. */
export function bytesHash(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}
