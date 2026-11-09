#!/usr/bin/env node
/**
 * Writes the npm package of clausona: a directory with its own package.json, the bundle as
 * clausona.js, README.md and LICENSE, ready for `npm publish <dir> --tag latest`.
 *
 *   node scripts/npm-package.mjs                           # the bundle `pnpm build` wrote
 *   node scripts/npm-package.mjs --bundle path/clausona.js # a release's clausona.js
 *   node scripts/npm-package.mjs --out some/dir            # somewhere other than dist/npm
 *
 * The bundle is published as it is, byte for byte: it carries every dependency, so the package
 * has none, and it runs no install script. The version comes from package.json, and the bundle
 * has to report the same one, so a release's clausona.js can only go out under its own version.
 * README links that only work on GitHub are made absolute, pinned to the release's tag.
 */

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, stripVTControlCharacters } from "node:util";

const REPO = "larcane97/clausona";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const { values } = parseArgs({
  options: {
    bundle: { type: "string", default: path.join(root, "dist", "index.js") },
    out: { type: "string", default: path.join(root, "dist", "npm") },
  },
});
const bundle = path.resolve(values.bundle);
const out = path.resolve(values.out);

function fail(message) {
  process.stderr.write(`npm-package: ${message}\n`);
  process.exit(1);
}

const { version, description } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const tag = `v${version}`;

if (!existsSync(bundle)) fail(`${bundle} does not exist. Run pnpm build first, or pass --bundle <file>.`);
// npm links the bin on PATH straight to this file, so the file has to say what runs it.
if (!readFileSync(bundle, "utf8").startsWith("#!/usr/bin/env node\n")) {
  fail(`${bundle} does not start with #!/usr/bin/env node, so it is not clausona's bundle.`);
}

// What `clausona update` checks a download by: --version names the version, as v<version>.
let reported;
try {
  const stdout = execFileSync(process.execPath, [bundle, "--version"], { encoding: "utf8", timeout: 30_000 });
  const pattern = /\bv(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)/;
  reported = pattern.exec(stripVTControlCharacters(stdout))?.[1];
} catch (error) {
  fail(`${bundle} --version failed: ${error instanceof Error ? error.message : String(error)}`);
}
if (reported !== version) {
  fail(
    `${bundle} reports ${reported ? `v${reported}` : "no version"}, but package.json is ${version}. ` +
      `Check out ${tag}, or pass that release's clausona.js.`,
  );
}

/**
 * The README with every relative link made absolute. npmjs.com shows the README without the
 * repository's files beside it, so `docs/routing.md` or `assets/demo.gif` would point nowhere.
 * Images go to raw.githubusercontent.com and pages to github.com, both at the release's tag, so
 * the page on npm shows the docs of the version it describes. Anchors within the README stay.
 */
function absoluteLinks(markdown, ref) {
  const page = (target) => `https://github.com/${REPO}/blob/${ref}/${target}`;
  const raw = (target) => `https://raw.githubusercontent.com/${REPO}/${ref}/${target}`;
  const relative = (target) => !/^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(target);
  const image = (target) => /\.(?:png|jpe?g|gif|svg|webp)(?:[?#].*)?$/i.test(target);
  return markdown
    .replace(/(!?)\[([^\]]*)\]\(([^)\s]+)\)/g, (whole, bang, text, target) =>
      relative(target) ? `${bang}[${text}](${bang || image(target) ? raw(target) : page(target)})` : whole,
    )
    .replace(/\b(src|href)="([^"]+)"/g, (whole, attribute, target) =>
      relative(target) ? `${attribute}="${attribute === "src" || image(target) ? raw(target) : page(target)}"` : whole,
    );
}

const manifest = {
  name: "clausona",
  version,
  description,
  keywords: ["claude-code", "claude", "codex", "codex-cli", "multiple-accounts", "account-switcher", "profiles", "cli"],
  homepage: "https://larcane97.github.io/clausona/",
  bugs: { url: `https://github.com/${REPO}/issues` },
  repository: { type: "git", url: `git+https://github.com/${REPO}.git` },
  license: "MIT",
  author: "larcane97",
  // The bundle is an ES module. Without this, Node before 20.19 refuses its `import` lines, and
  // later ones parse it twice and warn about it on stderr, around every claude the hook starts.
  type: "module",
  bin: { clausona: "clausona.js" },
  files: ["clausona.js"],
  engines: { node: ">=20" },
};

// Written afresh each time, so a file left from an earlier run cannot be published by mistake. Only
// a directory this script wrote is emptied: a mistyped --out must not delete someone's files.
const written = ["LICENSE", "README.md", "clausona.js", "package.json"];
const inside = path.relative(out, bundle);
if (!inside.startsWith("..") && !path.isAbsolute(inside)) fail(`--out ${out} holds the bundle itself. Pick another.`);
if (existsSync(out)) {
  const strays = readdirSync(out).filter((entry) => !written.includes(entry));
  if (strays.length > 0) {
    fail(`${out} holds files this script did not write (${strays.join(", ")}). Pick another --out.`);
  }
  rmSync(out, { recursive: true, force: true });
}
mkdirSync(out, { recursive: true });
copyFileSync(bundle, path.join(out, "clausona.js"));
chmodSync(path.join(out, "clausona.js"), 0o755);
writeFileSync(path.join(out, "README.md"), absoluteLinks(readFileSync(path.join(root, "README.md"), "utf8"), tag));
copyFileSync(path.join(root, "LICENSE"), path.join(out, "LICENSE"));
writeFileSync(path.join(out, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

// A path below this directory starts with `./`: npm reads a bare `dist/npm` as a GitHub repository.
const below = path.relative(process.cwd(), out);
const shown = below === "" ? "." : below.startsWith("..") || path.isAbsolute(below) ? out : `./${below}`;
process.stdout.write(
  `Wrote clausona ${version} to ${out}\n` +
    `  check:   npm pack --dry-run ${shown}\n` +
    `  publish: npm publish ${shown} --tag latest --access public\n`,
);
