import { describe, expect, it } from "vitest";

import { isOtherAccount } from "./account.js";

describe("isOtherAccount", () => {
  it.each([
    ["a@example.com", "b@example.com", true],
    // Addresses are case-insensitive in practice, and Claude Code does not normalise them.
    ["A@Example.com", "a@example.com", false],
    // Codex falls back to the account id when its id_token carries no email, so the two
    // forms of the same account must not read as different accounts.
    ["1f3c9a2e-4b5d-4e6f-8a7b-9c0d1e2f3a4b", "a@example.com", false],
    ["a@example.com", "1f3c9a2e-4b5d-4e6f-8a7b-9c0d1e2f3a4b", false],
    // Two account ids are the same form, so they can be compared exactly.
    ["1f3c9a2e-4b5d-4e6f-8a7b-9c0d1e2f3a4b", "7d8e9f0a-1b2c-4d3e-9f4a-5b6c7d8e9f0a", true],
    ["1f3c9a2e-4b5d-4e6f-8a7b-9c0d1e2f3a4b", "1f3c9a2e-4b5d-4e6f-8a7b-9c0d1e2f3a4b", false],
  ])("registered %s, signed in as %s: %s", (registered, signedInAs, expected) => {
    expect(isOtherAccount(registered, signedInAs)).toBe(expected);
  });
});
