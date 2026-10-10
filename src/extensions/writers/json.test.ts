import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  applyJsonEdits,
  DEFAULT_JSON_STYLE,
  editJson,
  entryAt,
  type JsonEdit,
  JsonEditError,
  type JsonPath,
  NO_PROJECT,
  readJsonText,
  resolvePath,
  touchedPath,
  valueAt,
} from "./json.js";

// Built from pieces, so no key-shaped string sits in the source.
const KEY = ["sk", "ant", "api03", "Q2xhdXNvbmFUZXN0S2V5MTIzNDU2Nzg5MA"].join("-");
const A = { type: "command", command: "notify" };
const B = { type: "command", command: "lint" };
const setB: JsonEdit = { op: "set", path: ["b"], value: "x" };

/** The error `run` throws, so its class and message can both be checked. */
function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
}

describe("editJson keeps how the file is written", () => {
  it("adds a key last in its object, in the file's indent", () => {
    expect(
      editJson('{\n  "b": 1,\n  "a": {\n    "x": true\n  }\n}\n', [{ op: "set", path: ["a", "y"], value: "off" }]),
    ).toBe('{\n  "b": 1,\n  "a": {\n    "x": true,\n    "y": "off"\n  }\n}\n');
  });

  it("keeps a missing final newline, tabs, four spaces, CRLF and a BOM", () => {
    expect(editJson('{\n  "a": 1\n}', [setB])).toBe('{\n  "a": 1,\n  "b": "x"\n}');
    expect(editJson('{\n\t"a": 1\n}\n', [setB])).toBe('{\n\t"a": 1,\n\t"b": "x"\n}\n');
    expect(editJson('{\n    "a": 1\n}\n', [setB])).toBe('{\n    "a": 1,\n    "b": "x"\n}\n');
    expect(editJson('{\r\n  "a": 1\r\n}\r\n', [setB])).toBe('{\r\n  "a": 1,\r\n  "b": "x"\r\n}\r\n');
    expect(editJson('\uFEFF{\n  "a": 1\n}\n', [setB])).toBe('\uFEFF{\n  "a": 1,\n  "b": "x"\n}\n');
  });

  it("keeps a one-line file on one line", () => {
    expect(editJson('{"a":1}', [setB])).toBe('{"a":1,"b":"x"}');
  });

  it("writes an empty file in the default style, making the parents", () => {
    expect(readJsonText("  \n")).toEqual({ value: {}, style: DEFAULT_JSON_STYLE });
    expect(editJson("", [{ op: "set", path: ["skillOverrides", "eli5"], value: "off" }])).toBe(
      '{\n  "skillOverrides": {\n    "eli5": "off"\n  }\n}\n',
    );
  });

  it("gives the text back unchanged when nothing changed", () => {
    const text = '{ "a": [1, 2] }';
    expect(editJson(text, [{ op: "delete", path: ["missing"] }])).toBe(text);
  });
});

describe("applyJsonEdits", () => {
  it("adds to a string list once, making it, and leaves an emptied list as []", () => {
    const list = ["projects", "/p", "disabledMcpServers"];
    const added = applyJsonEdits({ projects: { "/p": {} } }, [{ op: "list-add", path: list, value: "github" }]);
    expect(valueAt(added, list)).toEqual(["github"]);
    const twice = applyJsonEdits(added, [{ op: "list-add", path: list, value: "github" }]);
    expect(valueAt(twice, list)).toEqual(["github"]);
    const removed = applyJsonEdits(twice, [{ op: "list-remove", path: list, value: "github" }]);
    expect(valueAt(removed, list)).toEqual([]);
    // A changed copy: what it was given stays as it was.
    expect(valueAt(added, list)).toEqual(["github"]);
  });

  it("deletes a key, and takes an absent one as done", () => {
    const value = { mcpServers: { figma: { command: "figma" }, docs: { command: "docs" } } };
    const edit: JsonEdit = { op: "delete", path: ["mcpServers", "figma"] };
    expect(entryAt(value, edit)).toEqual({ command: "figma" });
    expect(applyJsonEdits(value, [edit])).toEqual({ mcpServers: { docs: { command: "docs" } } });
    expect(applyJsonEdits(value, [{ op: "delete", path: ["mcpServers", "gone", "x"] }])).toEqual(value);
  });
});

describe("resolvePath", () => {
  const P = path.join(path.sep, "p");
  const slashed = `${P}${path.sep}`;
  const at = ["projects", { projectKey: P }, "x"] as const;

  it("finds a project's key as written, else the first key that is the same path", () => {
    expect(resolvePath({ projects: { [slashed]: {} } }, at)).toEqual(["projects", slashed, "x"]);
    expect(resolvePath({ projects: { [slashed]: {}, [P]: {} } }, at)).toEqual(["projects", P, "x"]);
    expect(resolvePath({ projects: { [path.join(path.sep, "q")]: {} } }, at)).toBeUndefined();
    expect(valueAt({ projects: { [slashed]: { x: 1 } } }, at)).toBe(1);
    expect(valueAt({ projects: {} }, at)).toBeUndefined();
  });
});

describe("an edit under a project's key (rule E)", () => {
  const P = path.join(path.sep, "p");
  const at = (...rest: string[]): JsonPath => ["projects", { projectKey: P }, ...rest];
  const edits: JsonEdit[] = [
    { op: "set", path: at("skillOverrides", "eli5"), value: "off" },
    { op: "list-add", path: at("disabledMcpServers"), value: "github" },
    { op: "restore", path: at("mcpServers", "figma") },
  ];

  it("throws NO_PROJECT for a project with no entry, and never makes one", () => {
    const other = path.join(path.sep, "q");
    for (const value of [{}, { projects: {} }, { projects: { [other]: {} } }]) {
      for (const edit of edits) {
        const error = thrown(() => applyJsonEdits(value, [edit], { command: "figma" }));
        expect(error, `${edit.op} in ${JSON.stringify(value)}`).toBeInstanceOf(JsonEditError);
        expect((error as Error).message).toBe(NO_PROJECT);
        expect(thrown(() => editJson(JSON.stringify(value), [edit], { command: "figma" }))).toBeInstanceOf(
          JsonEditError,
        );
      }
    }
  });
});

describe("hook edits", () => {
  const stop = { base: "hooks", event: "Stop", group: 0, index: 0 } as const;

  it("removes a hook, then its emptied group, then its emptied event; hooks stays", () => {
    const value = { hooks: { Stop: [{ hooks: [A, B] }] } };
    expect(entryAt(value, { op: "hook-remove", place: stop })).toEqual(A);
    expect(touchedPath(value, { op: "hook-remove", place: stop })).toEqual(["hooks", "Stop"]);
    const once = applyJsonEdits(value, [{ op: "hook-remove", place: stop }]);
    expect(once).toEqual({ hooks: { Stop: [{ hooks: [B] }] } });
    expect(applyJsonEdits(once, [{ op: "hook-remove", place: stop }])).toEqual({ hooks: {} });
    // A hooks.json written without a "hooks" key keeps its events at the root.
    const root = { ...stop, base: "root" } as const;
    expect(touchedPath({}, { op: "hook-remove", place: root })).toEqual(["Stop"]);
    expect(applyJsonEdits({ Stop: [{ hooks: [A, B] }] }, [{ op: "hook-remove", place: root }])).toEqual({
      Stop: [{ hooks: [B] }],
    });
  });

  it("puts a hook back in its group, or a group with its matcher, or a new group", () => {
    const back: JsonEdit = { op: "hook-restore", place: stop };
    expect(applyJsonEdits({ hooks: { Stop: [{ hooks: [B] }] } }, [back], A)).toEqual({
      hooks: { Stop: [{ hooks: [A, B] }] },
    });
    expect(applyJsonEdits({}, [back], A)).toEqual({ hooks: { Stop: [{ hooks: [A] }] } });
    const bash: JsonEdit = { op: "hook-restore", place: { ...stop, matcher: "Bash" } };
    expect(applyJsonEdits({ hooks: { Stop: [{ matcher: "Edit", hooks: [B] }] } }, [bash], A)).toEqual({
      hooks: {
        Stop: [
          { matcher: "Edit", hooks: [B] },
          { matcher: "Bash", hooks: [A] },
        ],
      },
    });
  });
});

describe("restore", () => {
  const back: JsonEdit = { op: "restore", path: ["mcpServers", "figma"] };

  it("puts the entry back, and refuses when something is there", () => {
    expect(applyJsonEdits({ mcpServers: { docs: {} } }, [back], { command: "figma" })).toEqual({
      mcpServers: { docs: {}, figma: { command: "figma" } },
    });
    const error = thrown(() =>
      applyJsonEdits({ mcpServers: { figma: { command: "x" } } }, [back], { command: "figma" }),
    );
    expect(error).toBeInstanceOf(JsonEditError);
    expect((error as Error).message).toBe("present");
  });
});

describe("a file it cannot read", () => {
  it("says where it is not JSON, never what the text says", () => {
    const error = thrown(() => editJson(`{ "k": "${KEY}", }`, [setB]));
    expect(error).toBeInstanceOf(JsonEditError);
    expect((error as Error).message).toMatch(/^is not valid JSON/);
    expect((error as Error).message).not.toContain(KEY);
  });

  it("refuses a file that is not an object", () => {
    const error = thrown(() => editJson("[1]", [setB]));
    expect(error).toBeInstanceOf(JsonEditError);
    expect((error as Error).message).toBe("is not a JSON object");
  });
});
