import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { build } from "esbuild";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));

// Stub out react-devtools-core — ink imports it but it's unnecessary for CLI
rmSync("dist", { recursive: true, force: true });
const stubDir = "node_modules/.clausona-stubs";
mkdirSync(stubDir, { recursive: true });
writeFileSync(path.join(stubDir, "react-devtools-core.js"), "export default undefined;\n");

await build({
  entryPoints: ["src/index.tsx"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile: "dist/index.js",
  banner: {
    js: [
      "#!/usr/bin/env node",
      'import { createRequire } from "node:module";',
      "const require = createRequire(import.meta.url);",
    ].join("\n"),
  },
  jsx: "automatic",
  // The shell hook starts this bundle around every `claude` and `codex` run, and Node parses
  // all of it on each start, so a smaller file is a cheaper start. keepNames keeps function
  // and class `.name`, which React's component names and error names read.
  minify: true,
  keepNames: true,
  // Single source of truth: `clausona --version` must not drift from package.json.
  define: { __CLAUSONA_VERSION__: JSON.stringify(version) },
  alias: {
    "react-devtools-core": `./${stubDir}/react-devtools-core.js`,
  },
});
