import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Registry } from "../types.js";

/**
 * A throwaway home with Claude Code and Codex profiles, projects, skills and settings, for the
 * extensions tests. Only for tests: nothing in the app imports it.
 */
export class TestHome {
  readonly home = mkdtempSync(path.join(tmpdir(), "clausona-ext-"));
  readonly registry: Registry = { version: 2, primarySources: {}, activeProfiles: {}, profiles: {} };

  path(...parts: string[]): string {
    return path.join(this.home, ...parts);
  }

  write(rel: string, content: string | object): string {
    const file = this.path(rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`);
    return file;
  }

  /** A skill folder with a SKILL.md; `dir` is the skills dir, relative to the home. */
  skill(dir: string, name: string, description = `${name} skill`, body = "body"): string {
    this.write(path.join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`);
    return this.path(dir, name);
  }

  /** `link` (relative) made a link to `target` (relative, or absolute for one that dangles). */
  link(target: string, link: string): void {
    mkdirSync(path.dirname(this.path(link)), { recursive: true });
    symlinkSync(
      path.isAbsolute(target) ? target : this.path(target),
      this.path(link),
      process.platform === "win32" ? "junction" : "dir",
    );
  }

  /** A Claude profile. `.claude` is the primary, whose account file is ~/.claude.json. */
  claude(id: string, dir: string, json: Record<string, unknown> = {}): { configDir: string; jsonPath: string } {
    const configDir = this.path(dir);
    mkdirSync(configDir, { recursive: true });
    const primary = dir === ".claude";
    const jsonPath = primary ? this.path(".claude.json") : path.join(configDir, ".claude.json");
    writeFileSync(jsonPath, JSON.stringify(json));
    this.registry.profiles[`claude:${id}`] = {
      tool: "claude",
      configDir,
      email: `${id}@example.com`,
      ...(primary ? { isPrimary: true } : {}),
    };
    if (primary) this.registry.primarySources.claude = configDir;
    return { configDir, jsonPath };
  }

  /** A Codex profile. `.codex` is the primary. */
  codex(id: string, dir: string, configToml?: string): string {
    const configDir = this.path(dir);
    mkdirSync(configDir, { recursive: true });
    if (configToml !== undefined) writeFileSync(path.join(configDir, "config.toml"), configToml);
    const primary = dir === ".codex";
    this.registry.profiles[`codex:${id}`] = {
      tool: "codex",
      configDir,
      email: `${id}@example.com`,
      ...(primary ? { isPrimary: true } : {}),
    };
    if (primary) this.registry.primarySources.codex = configDir;
    return configDir;
  }

  /** A project dir with a `.git` folder, relative to the home. */
  project(dir: string): string {
    mkdirSync(this.path(dir, ".git"), { recursive: true });
    return this.path(dir);
  }

  dispose(): void {
    rmSync(this.home, { recursive: true, force: true });
  }
}
