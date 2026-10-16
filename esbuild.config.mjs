import esbuild from "esbuild";
import { readFileSync } from "node:fs";

const isWatch = process.argv.includes("--watch");

/** Single source of truth for the version `mem --version` reports. Injected at build time so the CLI string can never drift from package.json the way a hand-maintained literal did (it shipped 0.2.0 while package.json said 0.2.1). */
const pkgVersion = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;

const config = {
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  outfile: "dist/token-goat-mem.mjs",
  format: "esm",
  // better-sqlite3 is a native addon (can't be bundled). commander is CJS and uses a dynamic `require("node:events")` internally that esbuild cannot statically resolve into an ESM-format bundle (it falls back to a runtime require shim that doesn't exist in real ESM, so the built binary throws "Dynamic require of node:events is not supported" on startup). jsonc-parser ships a UMD build with its own internal dynamic require ("./impl/format") that hits the same failure mode once bundled into ESM. All three are real npm "dependencies" (see package.json), so Node resolves them from node_modules at runtime same as it would for any external import.
  external: ["better-sqlite3", "commander", "jsonc-parser"],
  define: {
    "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV || "production"),
    __MEM_VERSION__: JSON.stringify(pkgVersion),
  },
};

// The test setup builds under a private name and renames it into place, so a second process never opens a half-written bundle.
const outfileFlag = process.argv.indexOf("--outfile");
if (outfileFlag !== -1) {
  const requested = process.argv[outfileFlag + 1];
  if (requested === undefined) {
    throw new Error("--outfile needs a path");
  }
  config.outfile = requested;
}

if (isWatch) {
  const context = await esbuild.context(config);
  await context.watch();
  console.log("Watching for changes...");
} else {
  await esbuild.build(config);
  console.log(`Built ${config.outfile}`);
}
