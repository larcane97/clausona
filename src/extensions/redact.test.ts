import { describe, expect, it } from "vitest";

import { hookSummary, mcpSummary, redactCommand } from "./redact.js";

// Built from pieces so the repo's push protection does not take the fixture for a real key.
const KEY = ["sk", "ant", "api03", "Q2xhdXNvbmFUZXN0S2V5MTIzNDU2Nzg5MA"].join("-");

describe("redactCommand", () => {
  it("hides key-shaped words, the value after a secret-named flag, and URL credentials", () => {
    expect(redactCommand(["npx", "server", "--api-key", "plain-looking-value", `--token=${KEY}`, KEY])).toBe(
      "npx server --api-key <hidden> --token=<hidden> <hidden>",
    );
    expect(redactCommand(["curl", "https://user:pw@host.example/path?key=abc"])).toBe(
      "curl https://<hidden>@host.example/path?<hidden>",
    );
  });
});

describe("mcpSummary", () => {
  it("shows transport, command and the names - never the values - of env and headers", () => {
    const summary = mcpSummary({
      command: "npx",
      args: ["-y", "@acme/mcp"],
      env: { GITHUB_TOKEN: KEY, REGION: "eu" },
      headers: { Authorization: `Bearer ${KEY}` },
    });
    expect(summary).toEqual({
      transport: "stdio",
      command: "npx -y @acme/mcp",
      env: "GITHUB_TOKEN, REGION",
      headers: "Authorization",
    });
    expect(JSON.stringify(summary)).not.toContain(KEY.slice(10, 30));
  });

  it("reads an http server and hides a token in its URL", () => {
    expect(mcpSummary({ type: "http", url: "https://mcp.example/mcp?token=abc" })).toEqual({
      transport: "http",
      url: "https://mcp.example/mcp?<hidden>",
    });
  });
});

describe("hookSummary", () => {
  it("keeps event, matcher, type and a redacted command", () => {
    expect(hookSummary("PreToolUse", "Bash", { type: "command", command: `check --key ${KEY}` })).toEqual({
      event: "PreToolUse",
      matcher: "Bash",
      type: "command",
      command: "check --key <hidden>",
    });
  });
});
