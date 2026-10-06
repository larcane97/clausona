import { describe, expect, it } from "vitest";

import { tomlRootValue } from "./toml.js";

describe("tomlRootValue", () => {
  it("finds a root key however it is written, and nothing that only looks like one", () => {
    expect(tomlRootValue('sqlite_home = "/srv/state" # shared\n', "sqlite_home")).toBe('"/srv/state"');
    expect(tomlRootValue("﻿'sqlite_home'='/srv/state'\r\n", "sqlite_home")).toBe("'/srv/state'");
    expect(tomlRootValue('"sqlite_home" = "/srv/state"', "sqlite_home")).toBe('"/srv/state"');

    // After a table header, inside a string or array that spans lines, in a comment, or as part
    // of a dotted key: none of these is the root key.
    const decoys = [
      '[profiles.fast]\nsqlite_home = "/srv/state"\n',
      'notes = """\nsqlite_home = "/srv/state"\n"""\n',
      "notes = '''\n[table]\n'''\nother = 1\n",
      'paths = [\n  "a",\n  ["b"]\n]\n',
      '# sqlite_home = "/srv/state"\n',
      'sqlite_home.x = "/srv/state"\n',
      'title = "sqlite_home = x"\n',
    ];
    for (const text of decoys) expect(tomlRootValue(text, "sqlite_home"), text).toBeUndefined();

    // And a root key still counts after what the decoys above step over.
    expect(
      tomlRootValue('notes = """\n[table]\n"""\npaths = [\n  ["b"]\n]\nsqlite_home = "/x"\n[t]\n', "sqlite_home"),
    ).toBe('"/x"');
  });
});
