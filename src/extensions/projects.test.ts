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
    expect(await resolveCurrentProject(path.join(repo, "src", "deep"))).toBe(repo);
  });

  it("is the directory itself outside git", async () => {
    const h = newHome();
    const dir = h.path("notes");
    mkdirSync(dir, { recursive: true });
    expect(await resolveCurrentProject(dir)).toBe(dir);
  });

  it("is the home dir in the home dir, for what Claude Code keys by the dir it starts in", async () => {
    const h = newHome();
    expect(await resolveCurrentProject(h.home)).toBe(h.home);
  });

  it("is none at the filesystem root", async () => {
    expect(await resolveCurrentProject(path.parse(process.cwd()).root)).toBeUndefined();
  });
});

describe("collectProjects", () => {
  it("merges records, keeps existing dirs only - the home dir too - and adds the current one", async () => {
    const h = newHome();
    const app = h.project("repos/app");
    const web = h.project("repos/web");
    const here = h.project("repos/here");
    const { projects, current } = await collectProjects(
      [
        { tool: "claude", profile: "claude:work", paths: [app, h.path("repos/deleted"), h.home] },
        { tool: "claude", profile: "claude:personal", paths: [app, web] },
        { tool: "codex", profile: "codex:personal", paths: [web] },
      ],
      here,
    );
    expect(projects).toEqual([
      { path: h.home, tools: ["claude"], profiles: ["claude:work"] },
      { path: app, tools: ["claude"], profiles: ["claude:work", "claude:personal"] },
      { path: here, tools: [], profiles: [] },
      { path: web, tools: ["claude", "codex"], profiles: ["claude:personal", "codex:personal"] },
    ]);
    expect(current).toBe(here);
  });

  it("finds the current dir among the recorded projects by its real path, either way round", async () => {
    const h = newHome();
    const app = h.project("repos/app");
    h.link("repos/app", "links/app");
    const viaLink = h.path("links/app");
    const recordedReal = await collectProjects([{ tool: "claude", profile: "claude:work", paths: [app] }], viaLink);
    expect(recordedReal).toEqual({
      projects: [{ path: app, tools: ["claude"], profiles: ["claude:work"] }],
      current: app,
    });
    const recordedLink = await collectProjects([{ tool: "claude", profile: "claude:work", paths: [viaLink] }], app);
    expect(recordedLink.current).toBe(viaLink);
    expect(recordedLink.projects.map((p) => p.path)).toEqual([viaLink]);
  });

  it("reads the keys of a recorded projects object", () => {
    expect(recordedPaths({ "/a": {}, "/b": 1 })).toEqual(["/a", "/b"]);
    expect(recordedPaths(undefined)).toEqual([]);
  });
});
