import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  parseRoutesText,
  pickWithRecord,
  RoutesFileError,
  readPicks,
  readRoutes,
  readRoutesText,
  replaceRoutesText,
  routesPaths,
  updateRoutes,
} from "./routes-store.js";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function paths() {
  const dir = mkdtempSync(path.join(tmpdir(), "clausona-routes-"));
  temps.push(dir);
  return routesPaths(dir);
}

const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8"));

describe("routesPaths", () => {
  it("keeps both files and their locks in the clausona directory", () => {
    const dir = path.join("some", "clausona");
    expect(routesPaths(dir)).toEqual({
      routesPath: path.join(dir, "routes.json"),
      picksPath: path.join(dir, "route-picks.json"),
      routesLock: path.join(dir, "locks", "routes.lock"),
      picksLock: path.join(dir, "locks", "route-picks.lock"),
    });
  });
});

describe("parseRoutesText", () => {
  it("returns the checked file", () => {
    expect(parseRoutesText('{ "version": 1 }', "routes.json")).toEqual({ version: 1, routes: {} });
  });

  const parseError = (text: string) => {
    try {
      parseRoutesText(text, "routes.json");
    } catch (error) {
      return error as RoutesFileError;
    }
    throw new Error("parsed");
  };

  it("names every problem the check finds", () => {
    const error = parseError(JSON.stringify({ version: 1, routes: { a: { tool: "x" } } }));
    expect(error).toBeInstanceOf(RoutesFileError);
    expect(error.filePath).toBe("routes.json");
    expect(error.newer).toBe(false);
    expect(error.problems).toEqual(['routes.a.tool: must be "claude", "codex" or "all"']);
  });

  it("says on which line and column the JSON breaks", () => {
    const error = parseError('\uFEFF{\n  "version": 1,\n  "routes": {},\n}\n');
    expect(error.problems).toEqual(["not valid JSON (line 4, column 1)"]);
  });

  // JSON.parse's own message quotes the text around the error.
  it("never quotes the file, so a key pasted into it stays out of the message", () => {
    const key = `${["sk", "ant", "api03"].join("-")}-${"Ab1".repeat(16)}`;
    for (const text of [`{ "version": 1, "routes": { "a": { "tool": "claude", "from": [${key}] } } }`, `[${key}]`]) {
      const error = parseError(text);
      expect(error.problems).toEqual([expect.stringMatching(/^not valid JSON( \(line \d+, column \d+\))?$/)]);
      expect(error.message).not.toContain("sk-");
    }
  });
});

describe("readRoutes", () => {
  it("reads a missing file as no routes", async () => {
    expect(await readRoutes(paths())).toEqual({ version: 1, routes: {} });
  });

  // Review Focus 1: Notepad saves UTF-8 with a byte-order mark.
  it("reads a file that starts with a byte-order mark", async () => {
    const p = paths();
    writeFileSync(p.routesPath, `\uFEFF${JSON.stringify({ version: 1, routes: { main: { tool: "claude" } } })}`);
    expect((await readRoutes(p)).routes.main).toEqual({ tool: "claude" });
  });

  it("names the file and the problem when it cannot be used", async () => {
    const p = paths();
    writeFileSync(p.routesPath, "{ not json");
    const error = await readRoutes(p).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RoutesFileError);
    expect((error as RoutesFileError).message).toContain(p.routesPath);
    expect((error as RoutesFileError).problems[0]).toMatch(/^not valid JSON/);
    expect((error as RoutesFileError).message).toContain("clausona route edit");
  });

  it("refuses a newer file and says so", async () => {
    const p = paths();
    writeFileSync(p.routesPath, JSON.stringify({ version: 2, routes: {} }));
    const error = (await readRoutes(p).catch((e: unknown) => e)) as RoutesFileError;
    expect(error.newer).toBe(true);
    expect(error.message).toMatch(/newer clausona/);
  });
});

describe("readRoutesText", () => {
  it("reads the file as it is, or null when there is none", async () => {
    const p = paths();
    expect(await readRoutesText(p)).toBeNull();
    writeFileSync(p.routesPath, "{ not json");
    expect(await readRoutesText(p)).toBe("{ not json");
  });
});

describe("updateRoutes", () => {
  it("writes the change and keeps keys it does not know", async () => {
    const p = paths();
    writeFileSync(p.routesPath, JSON.stringify({ version: 1, routes: {}, dirs: { "~/w": { claude: "main" } } }));
    await updateRoutes((file) => {
      file.routes.main = { tool: "claude" };
      return file;
    }, p);
    expect(readJson(p.routesPath)).toEqual({
      version: 1,
      routes: { main: { tool: "claude" } },
      dirs: { "~/w": { claude: "main" } },
    });
  });

  it("keeps every one of several concurrent changes", async () => {
    const p = paths();
    await Promise.all(
      ["a", "b", "c", "d", "e"].map((name) =>
        updateRoutes((file) => {
          file.routes[name] = { tool: "claude" };
          return file;
        }, p),
      ),
    );
    expect(Object.keys(readJson(p.routesPath).routes).sort()).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("writes nothing when the change is invalid", async () => {
    const p = paths();
    await expect(
      updateRoutes((file) => {
        file.routes.bad = { tool: "claude", maxUsage: 0 };
        return file;
      }, p),
    ).rejects.toThrow("routes.bad.maxUsage: must be a number from 1 to 100");
    expect(existsSync(p.routesPath)).toBe(false);
  });

  it("writes nothing when the update returns null", async () => {
    const p = paths();
    await updateRoutes(() => null, p);
    expect(existsSync(p.routesPath)).toBe(false);
  });

  it("refuses to change a file it cannot use, and leaves it as it was", async () => {
    const p = paths();
    writeFileSync(p.routesPath, "{ not json");
    await expect(updateRoutes((file) => file, p)).rejects.toBeInstanceOf(RoutesFileError);
    expect(readFileSync(p.routesPath, "utf8")).toBe("{ not json");
  });
});

describe("replaceRoutesText", () => {
  it("replaces the file when it is still what the edit started from", async () => {
    const p = paths();
    await replaceRoutesText(null, '{ "version": 1, "routes": {} }\n', p);
    expect(readJson(p.routesPath)).toEqual({ version: 1, routes: {} });
  });

  it("replaces an existing file the edit started from, ending it with a newline", async () => {
    const p = paths();
    writeFileSync(p.routesPath, '{ "version": 1 }\n');
    await replaceRoutesText('{ "version": 1 }\n', '{ "version": 1, "routes": {} }', p);
    expect(readFileSync(p.routesPath, "utf8")).toBe('{ "version": 1, "routes": {} }\n');
  });

  it("refuses when the file changed meanwhile", async () => {
    const p = paths();
    writeFileSync(p.routesPath, '{ "version": 1, "routes": {} }\n');
    await expect(replaceRoutesText(null, '{ "version": 1, "routes": {} }\n', p)).rejects.toThrow(
      /changed while you were editing/,
    );
  });
});

describe("picks", () => {
  it("reads a missing or broken record as no picks", async () => {
    const p = paths();
    expect(await readPicks(p)).toEqual({});
    writeFileSync(p.picksPath, "garbage");
    expect(await readPicks(p)).toEqual({});
  });

  it("records the pick with the clock's time", async () => {
    const p = paths();
    const result = await pickWithRecord(
      () => ({ result: "claude:a", picked: "claude:a" }),
      () => Date.parse("2026-10-09T01:02:03.000Z"),
      p,
    );
    expect(result).toBe("claude:a");
    expect(readJson(p.picksPath)).toEqual({ version: 1, lastPicked: { "claude:a": "2026-10-09T01:02:03.000Z" } });
  });

  it("records nothing when nothing was picked", async () => {
    const p = paths();
    expect(await pickWithRecord(() => ({ result: null }), Date.now, p)).toBeNull();
    expect(existsSync(p.picksPath)).toBe(false);
  });

  it("gives concurrent picks each other's records", async () => {
    const p = paths();
    let tick = 0;
    const clock = () => Date.parse("2026-10-09T00:00:00.000Z") + tick++;
    const choose = (lastPicked: Record<string, string>) => {
      const next = ["claude:a", "claude:b", "claude:c"].find((id) => !lastPicked[id]) ?? "claude:a";
      return { result: next, picked: next };
    };
    const picked = await Promise.all([1, 2, 3].map(() => pickWithRecord(choose, clock, p)));
    expect(picked.sort()).toEqual(["claude:a", "claude:b", "claude:c"]);
  });
});
