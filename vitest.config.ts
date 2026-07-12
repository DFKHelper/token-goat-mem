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
    },
  },
});
