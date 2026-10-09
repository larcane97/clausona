import { describe, expect, it } from "vitest";

import {
  applyOverrides,
  checkPattern,
  checkRoute,
  checkRouteName,
  checkRoutesFile,
  newRouteSpec,
  toolsOf,
  withDefaults,
} from "./route-config.js";

// Built from pieces so the source never holds a key-shaped string.
const keyShaped = () => ["sk", "ant", "x".repeat(24)].join("-");

describe("withDefaults", () => {
  it("fills every field a spec leaves out", () => {
    expect(withDefaults({ tool: "claude" })).toEqual({
      tool: "claude",
      from: ["*"],
      exclude: [],
      strategy: "round-robin",
      maxUsage: 80,
      reserveUsage: 95,
      fallback: [],
    });
  });

  it("turns the reserve off when the cut is above 95", () => {
    expect(withDefaults({ tool: "codex", maxUsage: 98 }).reserveUsage).toBe(98);
  });
});

describe("newRouteSpec", () => {
  it("writes the defaults out, so routes.json shows them", () => {
    expect(newRouteSpec("claude")).toEqual({
      tool: "claude",
      from: ["*"],
      strategy: "round-robin",
      maxUsage: 80,
      reserveUsage: 95,
    });
  });
});

describe("applyOverrides", () => {
  it("replaces only the fields given", () => {
    const spec = { tool: "claude" as const, from: ["*"], strategy: "headroom" as const, maxUsage: 80 };
    expect(applyOverrides(spec, { exclude: ["*-share"], maxUsage: 70 })).toEqual({
      tool: "claude",
      from: ["*"],
      strategy: "headroom",
      maxUsage: 70,
      exclude: ["*-share"],
    });
  });

  it("drops a stored reserve that a higher cut would leave below it", () => {
    const spec = { tool: "claude" as const, maxUsage: 80, reserveUsage: 95 };
    expect(applyOverrides(spec, { maxUsage: 98 })).toEqual({ tool: "claude", maxUsage: 98 });
  });
});

describe("checkRouteName", () => {
  it.each(["main", "work-2", "a.b_c", "9lives"])("accepts %s", (name) => {
    expect(checkRouteName(name)).toBeNull();
  });

  it.each(["", "-x", "with space", "a/b", "c:d"])("refuses %j", (name) => {
    expect(checkRouteName(name)).toMatch(/^Invalid route name/);
  });

  it("never quotes a key-shaped name", () => {
    const problem = checkRouteName(keyShaped()) ?? "";
    expect(problem).toMatch(/API key/);
    expect(problem).not.toContain(keyShaped());
  });

  it("never quotes a vendor token as a name", () => {
    // Short, and not starting with sk-: only a check for a key anywhere in it catches it.
    const token = ["hf", "Ab".repeat(17)].join("_");
    expect(checkRouteName(token)).toBe("That looks like an API key, not a route name.");
  });
});

describe("checkPattern", () => {
  it.each([
    "*",
    "team-*",
    "claude:hyeokmin",
    "w?rk",
    "*@example.com",
    "me@example.com",
    "claude:*@example.com",
    "jiyoung_lee",
    "*@corp.example.com",
  ])("accepts %s on a claude route", (pattern) => {
    expect(checkPattern(pattern, "claude")).toBeNull();
  });

  it("refuses another tool's prefix", () => {
    expect(checkPattern("codex:work", "claude")).toBe(
      "'codex:work' names a codex profile, but this route is for claude",
    );
  });

  it("refuses an unknown prefix", () => {
    expect(checkPattern("gpt:work", "claude")).toBe(
      "'gpt:work' names unknown tool 'gpt', but this route is for claude",
    );
  });

  it("reads a prefix on an email pattern the same way", () => {
    expect(checkPattern("codex:*@example.com", "claude")).toBe(
      "'codex:*@example.com' names a codex profile, but this route is for claude",
    );
    expect(checkPattern("gpt:*@example.com", "claude")).toBe(
      "'gpt:*@example.com' names unknown tool 'gpt', but this route is for claude",
    );
  });

  it("refuses a colon anywhere else in an email pattern", () => {
    expect(checkPattern("*@example.com:x", "claude")).toBe("'*@example.com:x' is not an email pattern");
    expect(checkPattern("claude:codex:*@example.com", "claude")).toBe(
      "'claude:codex:*@example.com' is not an email pattern",
    );
  });

  it("refuses characters a profile name cannot have", () => {
    expect(checkPattern("a b", "claude")).toMatch(/is not a profile name pattern/);
  });

  it("refuses an empty pattern and a non-string", () => {
    expect(checkPattern(" ", "claude")).toBe("must be a non-empty string");
    expect(checkPattern(3, "claude")).toBe("must be a non-empty string");
  });

  it("never quotes a key-shaped pattern", () => {
    const problem = checkPattern(keyShaped(), "claude") ?? "";
    expect(problem).toMatch(/API key/);
    expect(problem).not.toContain(keyShaped());
  });

  // The whole of each of these neither starts with 'sk-' nor passes the length ceiling.
  it.each([
    ["behind this tool's prefix", () => `claude:${keyShaped()}`],
    ["behind another tool's prefix", () => `codex:${keyShaped()}`],
    ["after an email pattern", () => `me@example.com ${keyShaped()}`],
  ])("refuses a key %s, and never quotes it", (_, pattern) => {
    const problem = checkPattern(pattern(), "claude") ?? "";
    expect(problem).toMatch(/API key/);
    expect(problem).not.toContain(keyShaped());
  });

  // Short, and not starting with sk-: a vendor token only a check for a key anywhere in it catches.
  it.each([
    ["on its own", (token: string) => token],
    ["behind this tool's prefix", (token: string) => `claude:${token}`],
    ["inside a glob", (token: string) => `*${token}*`],
  ])("refuses a vendor token %s, and never quotes it", (_, wrap) => {
    const token = ["hf", "Ab".repeat(17)].join("_");
    const problem = checkPattern(wrap(token), "claude") ?? "";
    expect(problem).toBe("looks like an API key, not a profile name or email pattern");
  });
});

describe("checkRoute", () => {
  it("accepts a full route", () => {
    const route = {
      tool: "claude",
      from: ["*"],
      exclude: ["*-share"],
      strategy: "headroom",
      maxUsage: 80,
      reserveUsage: 95,
      fallback: ["dalsoo"],
    };
    expect(checkRoute("main", route)).toEqual([]);
  });

  it("names an unknown key, so a typo is not silently ignored", () => {
    expect(checkRoute("main", { tool: "claude", maxusage: 80 })).toEqual(["routes.main: unknown key 'maxusage'"]);
  });

  it("never quotes a key-shaped unknown key", () => {
    const problems = checkRoute("main", { tool: "claude", [keyShaped()]: true });
    expect(problems).toEqual(["routes.main: an unknown key looks like an API key"]);
  });

  it("never quotes a vendor token as an unknown key", () => {
    // Short, and not starting with sk-: only a check for a token anywhere in it catches it.
    const token = ["ghp", "Ab".repeat(18)].join("_");
    const problems = checkRoute("main", { tool: "claude", [token]: true });
    expect(problems).toEqual(["routes.main: an unknown key looks like an API key"]);
    expect(problems.join("\n")).not.toContain(token);
  });

  it("needs a tool", () => {
    expect(checkRoute("main", { from: ["*"] })).toEqual(['routes.main.tool: must be "claude", "codex" or "all"']);
  });

  it("refuses something that is not an object", () => {
    expect(checkRoute("main", ["*"])).toEqual(["routes.main: must be an object"]);
  });

  it("refuses an empty from", () => {
    expect(checkRoute("main", { tool: "claude", from: [] })).toEqual([
      'routes.main.from: must name at least one pattern; leave it out for every account ("*")',
    ]);
  });

  it("refuses a list that is not a list", () => {
    expect(checkRoute("main", { tool: "claude", exclude: "*-share" })).toEqual([
      "routes.main.exclude: must be a list of patterns",
    ]);
  });

  it("refuses an unknown strategy", () => {
    expect(checkRoute("main", { tool: "claude", strategy: "random" })).toEqual([
      "routes.main.strategy: must be one of round-robin, headroom, expiring",
    ]);
  });

  it.each([0, 101, "80", Number.NaN, null])("refuses maxUsage %j", (value) => {
    expect(checkRoute("main", { tool: "claude", maxUsage: value })).toEqual([
      "routes.main.maxUsage: must be a number from 1 to 100",
    ]);
  });

  it("refuses a reserve below the cut", () => {
    expect(checkRoute("main", { tool: "claude", maxUsage: 90, reserveUsage: 85 })).toEqual([
      "routes.main.reserveUsage: must be a number from maxUsage (90) to 100",
    ]);
  });

  it("points at a pattern by its index", () => {
    expect(checkRoute("main", { tool: "claude", fallback: ["ok", "codex:x"] })).toEqual([
      "routes.main.fallback[1]: 'codex:x' names a codex profile, but this route is for claude",
    ]);
  });

  it("refuses a bad name before anything else", () => {
    expect(checkRoute("a b", { tool: "claude" })[0]).toMatch(/^Invalid route name/);
  });
});

describe("all routes", () => {
  it("accepts either tool's prefix on an all route", () => {
    expect(checkPattern("claude:work", "all")).toBeNull();
    expect(checkPattern("codex:*", "all")).toBeNull();
    expect(checkPattern("gpt:x", "all")).toBe("'gpt:x' names unknown tool 'gpt', but this route is for all");
  });

  it("still refuses a key behind a prefix on an all route, without quoting it", () => {
    for (const pattern of [`codex:${keyShaped()}`, `gpt:${keyShaped()}`]) {
      expect(checkPattern(pattern, "all")).toBe("looks like an API key, not a profile name or email pattern");
    }
  });

  it("accepts all as a tool and defaults new routes to claude", () => {
    expect(checkRoute("any", { tool: "all", from: ["*"] })).toEqual([]);
    expect(checkRoute("bad", { tool: "gpt" })).toEqual(['routes.bad.tool: must be "claude", "codex" or "all"']);
    expect(newRouteSpec().tool).toBe("claude");
    expect(toolsOf("all")).toEqual(["claude", "codex"]);
    expect(toolsOf("codex")).toEqual(["codex"]);
  });
});

describe("checkRoutesFile", () => {
  it("accepts a file and keeps keys a later version writes", () => {
    const raw = { version: 1, routes: { main: { tool: "claude" } }, dirs: { "~/w": { claude: "main" } } };
    expect(checkRoutesFile(raw)).toEqual({ ok: true, file: raw });
  });

  it("reads a missing routes object as none", () => {
    expect(checkRoutesFile({ version: 1 })).toEqual({ ok: true, file: { version: 1, routes: {} } });
  });

  it("says a newer version is newer", () => {
    expect(checkRoutesFile({ version: 2, routes: {} })).toEqual({
      ok: false,
      newerVersion: 2,
      problems: ["was written by a newer clausona (version 2); update clausona to use it"],
    });
  });

  it("refuses a missing or wrong version", () => {
    expect(checkRoutesFile({ routes: {} })).toEqual({ ok: false, problems: ["version: must be 1"] });
  });

  it("collects every route's problems", () => {
    const raw = { version: 1, routes: { a: { tool: "x" }, b: { tool: "claude", strategy: "?" } } };
    expect(checkRoutesFile(raw)).toEqual({
      ok: false,
      problems: [
        'routes.a.tool: must be "claude", "codex" or "all"',
        "routes.b.strategy: must be one of round-robin, headroom, expiring",
      ],
    });
  });

  it("refuses something that is not an object", () => {
    expect(checkRoutesFile([])).toEqual({ ok: false, problems: ["must be a JSON object"] });
    expect(checkRoutesFile({ version: 1, routes: [] })).toEqual({
      ok: false,
      problems: ["routes: must be an object of named routes"],
    });
  });
});
