import { describe, expect, it } from "vitest";

import { editToml, parseTomlText, type TomlEdit, TomlEditError, tomlValueAt } from "./toml.js";

// Built from pieces, so no key-shaped string sits in the source.
const KEY = ["sk", "ant", "api03", "Q2xhdXNvbmFUZXN0S2V5MTIzNDU2Nzg5MA"].join("-");
const docsOff: TomlEdit = { op: "mcp-enabled", server: "docs", enabled: false };
const docsCleared: TomlEdit = { op: "mcp-enabled", server: "docs", enabled: null };

/** The error `run` throws, so its class and message can both be checked. */
function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
}

describe("mcp-enabled", () => {
  it("puts enabled right after the server's header", () => {
    const result = editToml('[mcp_servers.docs]\ncommand = "npx"\n', [docsOff]);
    expect(result).toBe('[mcp_servers.docs]\nenabled = false\ncommand = "npx"\n');
    expect(tomlValueAt(parseTomlText(result), ["mcp_servers", "docs", "enabled"])).toBe(false);
  });

  it("changes an enabled line in place, keeping its indent", () => {
    expect(editToml('[mcp_servers.docs]\n  enabled = true\n  command = "npx"\n', [docsOff])).toBe(
      '[mcp_servers.docs]\n  enabled = false\n  command = "npx"\n',
    );
    // Already so: the text comes back as it was.
    const off = "[mcp_servers.docs]\nenabled=false\n";
    expect(editToml(off, [docsOff])).toBe(off);
  });

  it("takes the line out, and the header with it when nothing else is left", () => {
    expect(editToml("a = 1\n\n[mcp_servers.docs]\nenabled = false\n", [docsCleared])).toBe("a = 1\n\n");
    expect(editToml('[mcp_servers.docs]\ncommand = "npx"\nenabled = false\n', [docsCleared])).toBe(
      '[mcp_servers.docs]\ncommand = "npx"\n',
    );
  });

  it("adds the table after one blank line when there is none", () => {
    expect(editToml('model = "o3"\n', [docsOff])).toBe('model = "o3"\n\n[mcp_servers.docs]\nenabled = false\n');
    // A project's config.toml clausona creates.
    expect(editToml("", [docsOff])).toBe("[mcp_servers.docs]\nenabled = false\n");
  });

  it("finds a quoted server name, and quotes a new one", () => {
    const quoted: TomlEdit = { op: "mcp-enabled", server: "my server", enabled: false };
    expect(editToml('[mcp_servers."my server"]\ncommand = "x"\n', [quoted])).toBe(
      '[mcp_servers."my server"]\nenabled = false\ncommand = "x"\n',
    );
    expect(editToml("[mcp_servers . 'my server'] # mine\n", [quoted])).toBe(
      "[mcp_servers . 'my server'] # mine\nenabled = false\n",
    );
    expect(editToml('model = "o3"\n', [quoted])).toBe('model = "o3"\n\n[mcp_servers."my server"]\nenabled = false\n');
  });

  it("writes CRLF in a CRLF file and keeps every comment", () => {
    const text = '# Codex config\r\n[mcp_servers.docs] # docs\r\n# how it starts\r\ncommand = "npx" # npx\r\n';
    const result = editToml(text, [docsOff]);
    expect(result).toBe(
      '# Codex config\r\n[mcp_servers.docs] # docs\r\nenabled = false\r\n# how it starts\r\ncommand = "npx" # npx\r\n',
    );
    expect(result.replaceAll("\r\n", "")).not.toContain("\n");
  });

  it("refuses a server written as an inline table or dotted keys", () => {
    for (const text of ['mcp_servers = { docs = { command = "x" } }\n', 'mcp_servers.docs.command = "x"\n']) {
      const error = thrown(() => editToml(text, [docsOff]));
      expect(error).toBeInstanceOf(TomlEditError);
      expect((error as Error).message).toBe("is written in a form clausona does not edit");
    }
  });

  it("does not take a header inside a multi-line string for a table", () => {
    expect(editToml('note = """\n[mcp_servers.docs]\n"""\n\n[mcp_servers.docs]\ncommand = "x"\n', [docsOff])).toBe(
      'note = """\n[mcp_servers.docs]\n"""\n\n[mcp_servers.docs]\nenabled = false\ncommand = "x"\n',
    );
  });

  it("refuses a result that does not read back as intended", () => {
    // A new [mcp_servers.docs] cannot extend an inline mcp_servers table: the check catches it.
    const error = thrown(() => editToml('mcp_servers = { other = { command = "x" } }\n', [docsOff]));
    expect(error).toBeInstanceOf(TomlEditError);
  });
});

describe("mcp-delete", () => {
  it("takes out the server's table and subtables, and keeps the comment above the next table", () => {
    const text = [
      'model = "o3"',
      "",
      "[mcp_servers.docs]",
      'command = "npx"',
      "",
      "[mcp_servers.docs.env]",
      `TOKEN = "${KEY}"`,
      "",
      "[mcp_servers.docs.tools.search]",
      "enabled = true",
      "",
      "# the other one",
      "[mcp_servers.other]",
      'command = "other"',
      "",
    ].join("\n");
    const result = editToml(text, [{ op: "mcp-delete", server: "docs" }]);
    expect(result).toBe('model = "o3"\n\n# the other one\n[mcp_servers.other]\ncommand = "other"\n');
    expect(tomlValueAt(parseTomlText(result), ["mcp_servers", "docs"])).toBeUndefined();
  });

  it("leaves one blank line where two meet", () => {
    expect(editToml("a = 1\n\n[mcp_servers.docs]\nenabled = false\n\n[other]\nb = 2\n", [docsCleared])).toBe(
      "a = 1\n\n[other]\nb = 2\n",
    );
  });
});

describe("skill-config", () => {
  const WINDOWS = "C:\\Users\\me\\app\\.agents\\skills\\x\\SKILL.md";
  const three = [
    "[[skills.config]]",
    'name = "a"',
    "enabled = true",
    "",
    "[[skills.config]]",
    'name = "b"',
    "enabled = true",
    "",
    "[[skills.config]]",
    'name = "c"',
    "enabled = true",
    "",
  ].join("\n");

  it("adds an entry for a Windows path as a basic string that reads back the same", () => {
    const result = editToml('model = "o3"\n', [{ op: "skill-config", selector: { path: WINDOWS }, enabled: false }]);
    expect(result).toBe(
      'model = "o3"\n\n[[skills.config]]\npath = "C:\\\\Users\\\\me\\\\app\\\\.agents\\\\skills\\\\x\\\\SKILL.md"\nenabled = false\n',
    );
    expect(tomlValueAt(parseTomlText(result), ["skills", "config", 0, "path"])).toBe(WINDOWS);
  });

  it("changes the matching entry's block only", () => {
    expect(editToml(three, [{ op: "skill-config", selector: { name: "b" }, enabled: false }])).toBe(
      three.replace('name = "b"\nenabled = true', 'name = "b"\nenabled = false'),
    );
  });

  it("takes out the matching entry's block only", () => {
    expect(editToml(three, [{ op: "skill-config", selector: { name: "b" }, enabled: null }])).toBe(
      '[[skills.config]]\nname = "a"\nenabled = true\n\n[[skills.config]]\nname = "c"\nenabled = true\n',
    );
  });
});

describe("a file it cannot read", () => {
  it("says where it is not TOML, never what the text says", () => {
    const text = `token = "${KEY}"\nbroken =\n`;
    for (const run of [() => parseTomlText(text), () => editToml(text, [docsOff])]) {
      const error = thrown(run);
      expect(error).toBeInstanceOf(TomlEditError);
      expect((error as Error).message).toMatch(/^is not valid TOML/);
      expect((error as Error).message).not.toContain(KEY);
    }
  });
});
