import { describe, expect, it } from "vitest";

import { valueHash } from "./hash.js";
import { expandVars, mcpRules, mcpTarget, ruleMatches, urlMatches } from "./mcp-policy.js";

/**
 * `${NAME}`, or `${NAME:-fallback}`, put together, so the text reads as a config holds it and as
 * no placeholder of this file's.
 */
const ref = (name: string, fallback?: string) =>
  ["$", "{", name, fallback === undefined ? "" : `:-${fallback}`, "}"].join("");

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

  it("expands a variable in an entry and in what a server starts before they match, as Claude Code does", () => {
    const env = { TOOLS: "/opt/tools", HOST: "mcp.example.com" };
    const [command, url, plain] = mcpRules(
      [
        { serverCommand: [`${ref("TOOLS")}/srv`, "--port", ref("PORT", "80")] },
        { serverUrl: `https://${ref("HOST")}/*` },
        { serverCommand: ["srv"] },
      ],
      env,
    ) as NonNullable<ReturnType<typeof mcpRules>>;
    expect(command).toEqual({ serverCommand: valueHash(["/opt/tools/srv", "--port", "80"]), reads: ["TOOLS", "PORT"] });
    expect(url).toEqual({ serverUrl: "https://mcp.example.com/*", reads: ["HOST"] });
    expect(plain).toEqual({ serverCommand: valueHash(["srv"]) });

    const written = mcpTarget({ command: "/opt/tools/srv", args: ["--port", "80"] }, env);
    expect(written).toEqual({ command: valueHash(["/opt/tools/srv", "--port", "80"]), vars: false });
    const fromEnv = mcpTarget({ command: `${ref("TOOLS")}/srv`, args: ["--port", "80"] }, env);
    expect(fromEnv).toEqual({ command: valueHash(["/opt/tools/srv", "--port", "80"]), vars: true, reads: ["TOOLS"] });
    expect(mcpTarget({ type: "http", url: `https://${ref("HOST")}/api` }, env)).toEqual({
      url: "https://mcp.example.com/api",
      vars: true,
      reads: ["HOST"],
    });
    for (const target of [written, fromEnv]) expect(command && ruleMatches(command, "any", target)).toBe(true);
    // A plugin's server reads its own folder as CLAUDE_PLUGIN_ROOT, no variable of the user's.
    expect(mcpTarget({ command: `${ref("CLAUDE_PLUGIN_ROOT")}/srv` }, env, "/plugins/kit")).toEqual({
      command: valueHash(["/plugins/kit/srv"]),
      vars: true,
    });
  });

  it("keeps an unset variable with no default as written, and reads an empty one as empty", () => {
    expect(expandVars(`${ref("NOPE")}/srv`, {})).toEqual({
      text: `${ref("NOPE")}/srv`,
      reads: ["NOPE"],
      wildcard: false,
    });
    expect(expandVars(`${ref("NOPE", "/usr")}/srv`, {}).text).toBe("/usr/srv");
    // Set, even to nothing, the value wins over the default.
    expect(expandVars(`${ref("EMPTY", "/usr")}/srv`, { EMPTY: "" }).text).toBe("/srv");
    // Only ${NAME} is a reference: not $NAME, not a name that starts with a digit.
    expect(expandVars(`$HOME/${ref("1X")}`, { HOME: "/h", "1X": "y" })).toEqual({
      text: `$HOME/${ref("1X")}`,
      reads: [],
      wildcard: false,
    });
    // Each name once, in the order met.
    expect(expandVars(`${ref("A")}${ref("B")}${ref("A")}`, { A: "a", B: "b" })).toEqual({
      text: "aba",
      reads: ["A", "B"],
      wildcard: false,
    });
    // Unset on both sides, an entry and a server written alike still match, as both stay as written.
    const [entry] = mcpRules([{ serverCommand: [`${ref("NOPE")}/srv`] }], {}) as NonNullable<
      ReturnType<typeof mcpRules>
    >;
    expect(entry && ruleMatches(entry, "any", mcpTarget({ command: `${ref("NOPE")}/srv` }, {}))).toBe(true);
  });

  it("reads a fallback for a variable the environment does not set, after the default, as a denylist entry does", () => {
    const fallback = { TOOLS: "/from/settings", HOST: "*.example.com" };
    expect(expandVars(`${ref("TOOLS")}/srv`, {}, fallback).text).toBe("/from/settings/srv");
    expect(expandVars(`${ref("TOOLS")}/srv`, { TOOLS: "/from/shell" }, fallback).text).toBe("/from/shell/srv");
    expect(expandVars(`${ref("TOOLS", "/usr")}/srv`, {}, fallback).text).toBe("/usr/srv");
    expect(expandVars(`https://${ref("HOST")}/*`, {}, fallback)).toEqual({
      text: "https://*.example.com/*",
      reads: ["HOST"],
      wildcard: true,
    });
    expect(mcpRules([{ serverCommand: [`${ref("TOOLS")}/bad`] }], {}, fallback)).toEqual([
      { serverCommand: valueHash(["/from/settings/bad"]), reads: ["TOOLS"] },
    ]);
  });

  it("says a value that brings a * into a URL entry, which an allowlist then never takes", () => {
    expect(expandVars(`https://${ref("HOST")}/*`, { HOST: "*.example.com" }).wildcard).toBe(true);
    expect(expandVars(`https://${ref("HOST")}/*`, { HOST: "a%2Ab.example.com" }).wildcard).toBe(true);
    expect(expandVars(`https://${ref("HOST")}/*`, { HOST: "mcp.example.com" }).wildcard).toBe(false);
    expect(mcpRules([{ serverUrl: `https://${ref("HOST")}/*` }], { HOST: "*.example.com" })).toEqual([
      { serverUrl: "https://*.example.com/*", reads: ["HOST"], wildcard: true },
    ]);
  });

  it("says a server's config uses variable expansion anywhere", () => {
    expect(mcpTarget({ command: "srv", env: { KEY: ref("KEY") } }).vars).toBe(true);
    expect(mcpTarget({ type: "http", url: `https://${ref("HOST")}/mcp` }).vars).toBe(true);
    expect(mcpTarget({ type: "stdio", command: "srv" })).toEqual({ command: valueHash(["srv"]), vars: false });
    expect(mcpTarget({ type: "sse" })).toEqual({ vars: false });
  });
});
