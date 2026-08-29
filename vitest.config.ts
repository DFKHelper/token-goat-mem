import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["tests/setup/isolate-home.ts"],
    globalSetup: ["tests/setup/build-bundle.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json"],
      // Only `src/` is the subject; the test files and the build script are not what coverage is
      // measuring, and counting them flatters the number.
      include: ["src/**/*.ts"],
      // Ratchets, not targets. Set a couple of points under what the suite actually reaches today
      // (92.5 / 85.0 / 98.8 / 92.3), so this catches a chunk of `src/` losing its tests without
      // failing on the ordinary noise of a branch or two moving between runs. Raise the floors when
      // real coverage rises; never lower one to make a build pass.
      thresholds: {
        statements: 90,
        branches: 82,
        functions: 96,
        lines: 90,
      },
    },
  },
});
