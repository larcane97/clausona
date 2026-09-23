import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * A stand-in for macOS `security` that keeps its Keychain in a file, for the tests of the
 * code that writes Claude Code's and clausona's items. Only for tests: nothing in the app
 * imports it, and no test reaches the real binary through it.
 *
 * It answers the four commands clausona sends as Apple's SecurityTool does (read from
 * github.com/apple-oss-distributions/Security, SecurityTool/macOS):
 * - `-i`: reads commands from stdin, one per line, split as split_line splits them (a
 *   backslash takes the next character, a quoted argument runs to its quote), and exits with
 *   the last one's status. Other invocations never read stdin.
 * - `add-generic-password`: `-X <hex>` stores the bytes the hex names, `-w <value>` the
 *   value's; without `-U` an item already there is refused (errSecDuplicateItem, 45).
 * - `find-generic-password`: finds the first item by `-s` and, if given, `-a`; `-w` prints
 *   the password as it is when every byte is printable (0x20-0x7e) and as hex otherwise,
 *   then a newline; without `-w` it prints the attributes, `"acct"<blob>="..."` among them.
 *   Not found: 44 and "could not be found" on stderr.
 * - `delete-generic-password`: removes the first item by `-s` (and `-a`), or 44.
 *
 * Every invocation is logged with its argv and its stdin. `writes: "drop"` answers every add
 * with success and stores nothing - the 8-bit exit status letting a failure through - and
 * `writes: "fail"` refuses every add with status 1.
 */
export type KeychainCall = { argv: string[]; stdin: string };

type Item = { service: string; account: string; hex: string };

const SCRIPT = String.raw`
const fs = require("node:fs");
const [storePath, logPath, writes] = CONFIG;
const argv = process.argv.slice(2);
const stdin = argv[0] === "-i" ? fs.readFileSync(0, "utf8") : "";
fs.appendFileSync(logPath, JSON.stringify({ argv, stdin }) + "\n");
const load = () => JSON.parse(fs.readFileSync(storePath, "utf8"));
const save = (items) => fs.writeFileSync(storePath, JSON.stringify(items));

function splitLine(line) {
  const out = [];
  let i = 0;
  while (i < line.length) {
    while (i < line.length && /\s/.test(line[i])) i++;
    if (i >= line.length) break;
    const quote = line[i] === '"' || line[i] === "'" ? line[i++] : null;
    let arg = "";
    while (i < line.length) {
      const c = line[i];
      if (c === "\\") { arg += line[i + 1] ?? ""; i += 2; continue; }
      if (quote ? c === quote : /\s/.test(c)) { i++; break; }
      arg += c;
      i++;
    }
    out.push(arg);
  }
  return out;
}

// -w takes the password in add-generic-password and is a flag ("print it") in find.
function options(args, takesValue) {
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (takesValue.includes(args[i])) opts[args[i]] = args[++i];
    else opts[args[i]] = true;
  }
  return opts;
}

function notFound() {
  process.stderr.write("security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n");
  return 44;
}

function exec(args) {
  const [command, ...rest] = args;
  const opts = options(rest, command === "add-generic-password" ? ["-a", "-s", "-w", "-X"] : ["-a", "-s"]);
  const items = load();
  const at = items.findIndex((item) => item.service === opts["-s"] && (opts["-a"] === undefined || item.account === opts["-a"]));
  if (command === "add-generic-password") {
    if (writes === "fail") return 1;
    if (writes === "drop") return 0;
    const hex = opts["-X"] ?? Buffer.from(opts["-w"] ?? "", "utf8").toString("hex");
    const same = items.findIndex((item) => item.service === opts["-s"] && item.account === opts["-a"]);
    if (same >= 0 && !opts["-U"]) return 45;
    if (same >= 0) items[same].hex = hex;
    else items.push({ service: opts["-s"], account: opts["-a"], hex });
    save(items);
    return 0;
  }
  if (command === "find-generic-password") {
    if (at < 0) return notFound();
    const bytes = Buffer.from(items[at].hex, "hex");
    if (opts["-w"]) {
      const printable = bytes.every((byte) => byte >= 0x20 && byte <= 0x7e);
      process.stdout.write((printable ? bytes.toString("utf8") : items[at].hex) + "\n");
    } else {
      process.stdout.write('keychain: "/stand-in/login.keychain-db"\nclass: "genp"\nattributes:\n');
      process.stdout.write('    "acct"<blob>="' + items[at].account + '"\n    "svce"<blob>="' + items[at].service + '"\n');
    }
    return 0;
  }
  if (command === "delete-generic-password") {
    if (at < 0) return notFound();
    items.splice(at, 1);
    save(items);
    return 0;
  }
  return 2;
}

let status = 0;
if (argv[0] === "-i") {
  for (const line of stdin.split("\n").slice(0, -1)) {
    const args = splitLine(line);
    if (args.length > 0) status = exec(args);
  }
} else {
  status = exec(argv);
}
process.exit(status & 0xff);
`;

/**
 * Writes the stand-in into `root`/bin (a directory the caller creates and removes) and
 * returns what a test needs: the directory to put first on PATH, the calls it received, and
 * the items it holds.
 */
export function keychainStandIn(root: string, { writes = "store" }: { writes?: "store" | "drop" | "fail" } = {}) {
  const bin = path.join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const storePath = path.join(root, "keychain.json");
  const logPath = path.join(root, "calls.jsonl");
  writeFileSync(storePath, "[]");
  const script = path.join(root, "security.cjs");
  writeFileSync(script, SCRIPT.replace("CONFIG", JSON.stringify([storePath, logPath, writes])));
  // Through sh, so the path to node may hold spaces a #! line could not.
  const quoted = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
  writeFileSync(path.join(bin, "security"), `#!/bin/sh\nexec ${quoted(process.execPath)} ${quoted(script)} "$@"\n`, {
    mode: 0o755,
  });

  const items = (): Item[] => JSON.parse(readFileSync(storePath, "utf8"));
  return {
    bin,
    calls: (): KeychainCall[] =>
      existsSync(logPath)
        ? readFileSync(logPath, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as KeychainCall)
        : [],
    /** An item as another program left it: `data` is stored as its UTF-8 bytes. */
    seed(service: string, account: string, data: string) {
      writeFileSync(
        storePath,
        JSON.stringify([...items(), { service, account, hex: Buffer.from(data).toString("hex") }]),
      );
    },
    /** The bytes an item holds, as UTF-8, or undefined when there is no such item. */
    stored(service: string, account: string): string | undefined {
      const item = items().find((entry) => entry.service === service && entry.account === account);
      return item === undefined ? undefined : Buffer.from(item.hex, "hex").toString("utf8");
    },
    items,
  };
}

/**
 * How `security -i` splits a line into arguments (split_line in security.c), for asserting on
 * what a test's stand-in was sent on stdin.
 */
export function splitSecurityLine(line: string): string[] {
  const args: string[] = [];
  let current: string | null = null;
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    if (current === null) {
      if (/[ \t\n\v\f\r]/.test(ch)) continue;
      current = "";
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
    }
    if (ch === "\\") {
      i++;
      current += line[i] ?? "";
    } else if (quote === null ? /[ \t\n\v\f\r]/.test(ch) : ch === quote) {
      args.push(current);
      current = null;
      quote = null;
    } else {
      current += ch;
    }
  }
  if (current !== null) args.push(current);
  return args;
}
