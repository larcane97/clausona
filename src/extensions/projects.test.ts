import { mkdirSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { collectProjects, recordedPaths, resolveCurrentProject } from "./projects.js";
import { TestHome } from "./test-home.js";

const homes: TestHome[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) home.dispose();
});
function newHome(): TestHome {
  const home = new TestHome();
  homes.push(home);
  return home;
}

describe("resolveCurrentProject", () => {
  it("is the git root from a subdirectory", async () => {
    const h = newHome();
    const repo = h.project("repos/app");
    mkdirSync(path.join(repo, "src", "deep"), { recursive: true });
    expect(await resolveCurrentProject(path.join(repo, "src", "deep"), h.home)).toBe(repo);
  });

  it("is the directory itself outside git", async () => {
    const h = newHome();
    const dir = h.path("notes");
    mkdirSync(dir, { recursive: true });
    expect(await resolveCurrentProject(dir, h.home)).toBe(dir);
  });

  it("is none in the home dir, where .claude/ is the user's own config", async () => {
    const h = newHome();
    expect(await resolveCurrentProject(h.home, h.home)).toBeUndefined();
  });
});

describe("collectProjects", () => {
  it("merges records, keeps existing dirs only, never the home, and adds the current one", async () => {
    const h = newHome();
    const app = h.project("repos/app");
    const web = h.project("repos/web");
    const here = h.project("repos/here");
    const projects = await collectProjects(
      [
        { tool: "claude", profile: "claude:work", paths: [app, h.path("repos/deleted"), h.home] },
        { tool: "claude", profile: "claude:personal", paths: [app, web] },
        { tool: "codex", profile: "codex:personal", paths: [web] },
      ],
      h.home,
      here,
    );
    expect(projects).toEqual([
      { path: app, tools: ["claude"], profiles: ["claude:work", "claude:personal"] },
      { path: here, tools: [], profiles: [] },
      { path: web, tools: ["claude", "codex"], profiles: ["claude:personal", "codex:personal"] },
    ]);
  });

  it("reads the keys of a recorded projects object", () => {
    expect(recordedPaths({ "/a": {}, "/b": 1 })).toEqual(["/a", "/b"]);
    expect(recordedPaths(undefined)).toEqual([]);
  });
});
