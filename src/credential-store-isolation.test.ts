import { spawnSync } from "node:child_process";
import { accessSync, constants, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Where spawn would find `name`: the first executable file of that name in a PATH entry, the
 * lookup execvp does. Only resolved, never run - unguarded, this is the real binary.
 */
function resolveOnPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir === "") continue;
    const candidate = path.join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return null;
}

// vitest.global-setup.ts puts the stand-ins first on PATH for the whole run, so no test can
// reach the user's real Keychain or Secret Service. Windows uses neither binary.
describe.skipIf(process.platform === "win32")("the credential stores every test sees", () => {
  const shimDir = process.env.CLAUSONA_TEST_SHIM_DIR ?? "<no stand-in directory>";

  it.each(["security", "secret-tool"])("resolves %s to the suite's stand-in", (name) => {
    expect(resolveOnPath(name)).toBe(path.join(shimDir, name));
  });

  it("answers as the real binaries do for an item that is not there", () => {
    const security = spawnSync(path.join(shimDir, "security"), ["find-generic-password", "-s", "clausona-isolation"], {
      encoding: "utf8",
    });
    expect(security.status).toBe(44);
    expect(security.stderr).toContain("could not be found");

    const secretTool = spawnSync(path.join(shimDir, "secret-tool"), ["lookup", "clausona", "isolation"], {
      encoding: "utf8",
    });
    expect(secretTool.status).toBe(1);
    expect(secretTool.stdout).toBe("");
  });
});

/**
 * The one way past the stand-ins: a spawn handed an `env` of its own with no PATH in it. The
 * child's command is then looked up in the system's default path (/usr/bin:/bin), where the
 * real `security` is. Nothing structural stops a test from doing that, so every test source
 * is read here, and each spawn that passes an env must pass PATH in it, or all of
 * process.env. A static check: an env given by name is followed to the variable's
 * initializer in the same file, and one it cannot follow counts as missing PATH.
 */
const SPAWN_CALL = /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork|spawnCommand|spawnCommandSync)\s*\(/g;

/** The source from the bracket at `open` to the one that closes it, stepping over strings. */
function bracketed(source: string, open: number): string {
  const closing: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
  const stack: string[] = [];
  let quote: string | null = null;
  for (let i = open; i < source.length; i++) {
    const ch = source[i] as string;
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
    } else if (ch in closing) {
      stack.push(closing[ch] as string);
    } else if (ch === stack.at(-1)) {
      stack.pop();
      if (stack.length === 0) return source.slice(open, i + 1);
    }
  }
  return source.slice(open);
}

function carriesPath(env: string): boolean {
  return /\bPATH\s*:/.test(env) || /\.\.\.\s*process\.env\b/.test(env) || /^process\.env\b/.test(env);
}

/** The source of the env a call passes, or null when it passes none. */
function envOf(source: string, callStart: number, args: string): string | null {
  const option = /[{,\s]env\s*(:\s*|(?=[,}]))/.exec(args);
  if (!option) return null;
  const rest = args.slice(option.index + option[0].length);
  if (option[1]?.startsWith(":") && rest.startsWith("{")) return bracketed(rest, 0);
  const name = option[1]?.startsWith(":") ? /^[\w.$]+/.exec(rest)?.[0] : "env";
  if (!name || name.startsWith("process.env")) return name ?? "";
  const declarations = [
    ...source.slice(0, callStart).matchAll(new RegExp(`\\b(?:const|let|var)\\s+${name}\\b[^=]*=\\s*`, "g")),
  ];
  const last = declarations.at(-1);
  if (!last) return name;
  const start = (last.index ?? 0) + last[0].length;
  return source[start] === "{" ? bracketed(source, start) : (source.slice(start).split(/[;\n]/)[0] ?? "");
}

/** Lines of `source` that spawn with an env carrying no PATH. */
function spawnsWithoutPath(source: string): number[] {
  const lines: number[] = [];
  for (const call of source.matchAll(SPAWN_CALL)) {
    const start = call.index ?? 0;
    const env = envOf(source, start, bracketed(source, start + call[0].length - 1));
    if (env !== null && !carriesPath(env)) lines.push(source.slice(0, start).split("\n").length);
  }
  return lines;
}

describe("every test spawn that passes an env passes PATH in it", () => {
  // The function names are passed as strings, so this file's own source has no such call in it.
  const call = (fn: string, options: string) => `${fn}("security", ["-i"], ${options});`;

  it("finds the ones that do not", () => {
    expect(spawnsWithoutPath(call("spawnSync", "{ env: { HOME: home } }"))).toEqual([1]);
    expect(spawnsWithoutPath(`const env = { HOME: home };\n${call("spawnCommand", "{ env }")}`)).toEqual([2]);
    expect(spawnsWithoutPath(call("execFileSync", "{ env: childEnv }"))).toEqual([1]);
    expect(spawnsWithoutPath(call("spawnSync", "{ env: { ...process.env, HOME: home } }"))).toEqual([]);
    expect(spawnsWithoutPath(call("spawn", "{ env: { PATH: bin, HOME: home } }"))).toEqual([]);
    expect(spawnsWithoutPath(`const given = { PATH: bin };\n${call("spawnSync", "{ env: given }")}`)).toEqual([]);
    expect(spawnsWithoutPath(call("spawnSync", '{ encoding: "utf8" }'))).toEqual([]);
  });

  it("holds for every test source", () => {
    const root = path.dirname(fileURLToPath(import.meta.url));
    const offenders: string[] = [];
    for (const file of readdirSync(root, { recursive: true }) as string[]) {
      if (!/(\.test\.tsx?|(^|[\\/])test-[^\\/]*\.tsx?)$/.test(file)) continue;
      for (const line of spawnsWithoutPath(readFileSync(path.join(root, file), "utf8"))) {
        offenders.push(`src/${file}:${line}`);
      }
    }
    expect(offenders, "give these spawns PATH - see vitest.global-setup.ts").toEqual([]);
  });
});
