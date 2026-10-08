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

describe("redactCommand on a token that is not key-shaped", () => {
  // Lowercase hex, which the key-shape check misses: what a self-hosted gateway often issues.
  const HEX = "0123456789abcdef".repeat(2);
  const command = (line: string) => hookSummary("Stop", undefined, { type: "command", command: line }).command ?? "";

  it("hides the value of a NAME=value whose name says it is a secret", () => {
    const docker = redactCommand(["docker", "run", "-e", `GITHUB_TOKEN=${HEX}`, "img"]);
    expect(docker).toBe("docker run -e GITHUB_TOKEN=<hidden> img");
    const prefixed = command(`TOKEN=${HEX} notify`);
    expect(prefixed).toBe("TOKEN=<hidden> notify");
    expect(`${docker} ${prefixed}`).not.toContain(HEX);
  });

  it("hides a secret header's value in one argument and across a quoted hook command", () => {
    const remote = redactCommand(["mcp-remote", "https://x.example/mcp", "--header", `Authorization: Bearer ${HEX}`]);
    expect(remote).toBe("mcp-remote https://x.example/mcp --header Authorization: <hidden>");
    // hookSummary splits at whitespace, so the quoted header arrives as three words.
    const curl = command(`curl -H "Authorization: Bearer ${HEX}" https://h.example`);
    expect(curl).toBe('curl -H "Authorization: <hidden>" https://h.example');
    expect(`${remote} ${curl}`).not.toContain(HEX);
  });

  it("hides the word after Bearer or Basic under any header name", () => {
    const arg = redactCommand(["server", "--header", `X-Upstream: Bearer ${HEX}`]);
    expect(arg).toBe("server --header X-Upstream: Bearer <hidden>");
    const hook = command(`notify --header "X-Upstream: Basic ${HEX}" done`);
    expect(hook).toBe('notify --header "X-Upstream: Basic <hidden>" done');
    expect(`${arg} ${hook}`).not.toContain(HEX);
  });

  it("hides the password of the user:password after -u or --user, and leaves a bare user", () => {
    const curl = redactCommand(["curl", "-u", `alice:${HEX}`, `--user=bob:${HEX}`, "https://h.example"]);
    expect(curl).toBe("curl -u alice:<hidden> --user=bob:<hidden> https://h.example");
    expect(curl).not.toContain(HEX);
    expect(redactCommand(["curl", "-u", "alice", "https://h.example"])).toBe("curl -u alice https://h.example");
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
