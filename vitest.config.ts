import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

const { version } = JSON.parse(readFileSync(new URL("package.json", import.meta.url), "utf8")) as {
  version: string;
};

export default defineConfig({
  // Mirrors build.mjs so the version behaves the same under test as when bundled.
  define: { __CLAUSONA_VERSION__: JSON.stringify(version) },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // Keeps every test off the real `security` and `secret-tool` - see the file.
    globalSetup: ["./vitest.global-setup.ts"],
    // Windows runners stall now and then: a case that takes under a second there has run
    // past the 5s default. A timed-out case is not stopped, and what it goes on writing lands
    // in the next case's HOME and fails that one too.
    ...(process.platform === "win32" ? { testTimeout: 20_000 } : {}),
  },
});
