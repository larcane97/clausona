import { describe, expect, it } from "vitest";

import { valueHash } from "./hash.js";
import { mcpRules, mcpTarget, ruleMatches, urlMatches } from "./mcp-policy.js";

describe("urlMatches", () => {
  // The patterns and what they allow, as Claude Code's managed MCP docs list them.
  it.each([
    ["https://mcp.example.com/*", "https://mcp.example.com/api", true],
    ["https://mcp.example.com/*", "https://mcp.example.com:8443/api", false],
    ["https://mcp.example.com", "https://mcp.example.com/any/path?q=1", true],
    ["https://mcp.example.com:8443/*", "https://mcp.example.com:8443/api", true],
    ["https://mcp.example.com:8443/*", "https://mcp.example.com/api", false],
    ["https://mcp.example.com:*/*", "https://mcp.example.com/api", true],
    ["https://mcp.example.com:*/*", "https://mcp.example.com:9000/api", true],
    ["https://*.example.com/*", "https://a.b.example.com:7000/x", true],
    ["https://*.example.com/*", "https://example.org/x", false],
    ["http://localhost:*/*", "http://localhost:3000/mcp", true],
    ["*://mcp.example.com/*", "http://mcp.example.com/x", true],
    ["*://mcp.example.com/*", "https://mcp.example.com/x", true],
    ["*://mcp.example.com/*", "https://mcp.example.com:8443/x", false],
    // The host in any case, with or without the trailing dot; the path in its own case.
    ["https://Mcp.Example.com/*", "https://mcp.example.com./api", true],
    ["https://mcp.example.com/API/*", "https://mcp.example.com/api/x", false],
    ["https://mcp.example.com/api/*", "https://mcp.example.com/api/x", true],
    ["https://mcp.example.com/*", "http://mcp.example.com/api", false],
    ["*", "https://anything.example/x", true],
    ["https://mcp.example.com/*", "not a url", false],
  ])("%s against %s is %s", (pattern, url, match) => {
    expect(urlMatches(url, pattern)).toBe(match);
  });
});

describe("mcpRules and ruleMatches", () => {
  it("keeps entries of exactly one known key and the right type, and drops the rest", () => {
    expect(
      mcpRules([
        { serverName: "github" },
        { serverCommand: ["npx", "-y", "server"] },
        { serverUrl: "https://*.example.com/*" },
        { serverName: "a", serverUrl: "https://x" },
        { serverCommand: "npx server" },
        { other: 1 },
        "github",
      ]),
    ).toEqual([
      { serverName: "github" },
      { serverCommand: valueHash(["npx", "-y", "server"]) },
      { serverUrl: "https://*.example.com/*" },
    ]);
    expect(mcpRules(undefined)).toBeUndefined();
    expect(mcpRules({})).toBeUndefined();
    expect(mcpRules([])).toEqual([]);
  });

  it("matches a name exactly, a command with every argument in order, a URL by its pattern", () => {
    const stdio = mcpTarget({ command: "npx", args: ["-y", "server"], env: { TOKEN: "x" } });
    const remote = mcpTarget({ type: "http", url: "https://mcp.example.com/api" });
    expect(stdio).toEqual({ command: valueHash(["npx", "-y", "server"]), vars: false });
    expect(remote).toEqual({ url: "https://mcp.example.com/api", vars: false });
    const [byName, byCommand, byUrl] = mcpRules([
      { serverName: "github" },
      { serverCommand: ["npx", "-y", "server"] },
      { serverUrl: "https://mcp.example.com/*" },
    ]) as NonNullable<ReturnType<typeof mcpRules>>;
    if (!byName || !byCommand || !byUrl) throw new Error("rules missing");
    expect(ruleMatches(byName, "github", stdio)).toBe(true);
    expect(ruleMatches(byName, "GitHub", stdio)).toBe(false);
    expect(ruleMatches(byCommand, "any", stdio)).toBe(true);
    expect(ruleMatches(byCommand, "any", mcpTarget({ command: "npx", args: ["server"] }))).toBe(false);
    // The env block is not compared.
    expect(ruleMatches(byCommand, "any", mcpTarget({ command: "npx", args: ["-y", "server"] }))).toBe(true);
    expect(ruleMatches(byUrl, "any", remote)).toBe(true);
    expect(ruleMatches(byUrl, "any", stdio)).toBe(false);
  });

  it("says a server's config uses variable expansion anywhere", () => {
    // Put together, so the text reads as a config holds it and as no placeholder of this file's.
    const ref = (name: string) => ["$", "{", name, "}"].join("");
    expect(mcpTarget({ command: "srv", env: { KEY: ref("KEY") } }).vars).toBe(true);
    expect(mcpTarget({ type: "http", url: `https://${ref("HOST")}/mcp` }).vars).toBe(true);
    expect(mcpTarget({ type: "stdio", command: "srv" })).toEqual({ command: valueHash(["srv"]), vars: false });
    expect(mcpTarget({ type: "sse" })).toEqual({ vars: false });
  });
});
