import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Vitest's 5s default is a bound on how long a legitimate operation may take, and on a cold
    // windows-latest runner it is too tight for this suite: the bundle tests spawn the built
    // binary as a subprocess, and the scale tests build a 500-fact SQLite store. Three
    // consecutive v0.4.0 release runs went red on that bound alone -- a different test each
    // time, always `Test timed out in 5000ms`, always Windows-only while every ubuntu job
    // passed. A per-test bump would just move the failure to the next slowest test.
    //
    // This does not hide a hang: a genuinely stuck test still fails, 30s later, and the job's
    // own limit still bounds the run. What it stops is a fast machine's idea of slow deciding
    // whether an assertion gets to run at all.
    testTimeout: 30_000,
    // Hooks do strictly more than tests here -- globalSetup runs a full esbuild -- so they get
    // more room.
    hookTimeout: 60_000,
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
