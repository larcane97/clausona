import { describe, expect, it } from "vitest";
import { decodeJwtPayload } from "./codex-jwt.js";

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

describe("decodeJwtPayload", () => {
  it("decodes a normal payload", () => {
    const tok = makeJwt({ email: "x@y.com", name: "X" });
    expect(decodeJwtPayload(tok)).toEqual({ email: "x@y.com", name: "X" });
  });

  it("handles non-ASCII display names (Korean)", () => {
    const tok = makeJwt({ email: "u@v.co", name: "임문경" });
    expect(decodeJwtPayload(tok)).toMatchObject({ name: "임문경" });
  });

  it("returns null on malformed input", () => {
    expect(decodeJwtPayload("not.a.jwt.too.many.segments")).toBeNull();
    expect(decodeJwtPayload("only-one-segment")).toBeNull();
    expect(decodeJwtPayload("a.@@@.c")).toBeNull();
  });
});
