import { describe, expect, it } from "vitest";

import { bytesHash, canonical, valueHash } from "./hash.js";

describe("valueHash", () => {
  it("is the same for one value whatever its keys' order, and differs for another value", () => {
    const one = valueHash({ b: 1, a: [1, "x"] });
    expect(valueHash({ a: [1, "x"], b: 1 })).toBe(one);
    expect(valueHash({ a: [1, "y"] })).not.toBe(one);
    expect(one).toMatch(/^[0-9a-f]{64}$/);
    expect(valueHash({ a: [1, "y"] })).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("canonical", () => {
  it("sorts keys at every depth, writes a date as its ISO string and undefined in an array as null", () => {
    const at = new Date(Date.UTC(2026, 9, 10, 12, 0, 0));
    expect(canonical({ z: { b: 2, a: 1 }, a: [undefined, at], skipped: undefined })).toBe(
      '{"a":[null,"2026-10-10T12:00:00.000Z"],"z":{"a":1,"b":2}}',
    );
  });

  it("keeps a __proto__ key that JSON.parse read as a key", () => {
    expect(canonical(JSON.parse('{"a":1,"__proto__":{"x":1}}'))).toBe('{"__proto__":{"x":1},"a":1}');
  });
});

describe("bytesHash", () => {
  it("is the sha256 of a string's UTF-8 bytes, and of the same bytes given as bytes", () => {
    const abc = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    expect(bytesHash("abc")).toBe(abc);
    expect(bytesHash(new TextEncoder().encode("abc"))).toBe(abc);
  });
});
