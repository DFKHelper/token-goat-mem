import esbuild from "esbuild";

const isWatch = process.argv.includes("--watch");

const config = {
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "node",
  target: "node18",
  outfile: "dist/token-goat-mem.mjs",
  format: "esm",
  // better-sqlite3 is a native addon (can't be bundled). commander is CJS and
  // uses a dynamic `require("node:events")` internally that esbuild cannot
  // statically resolve into an ESM-format bundle (it falls back to a runtime
  // require shim that doesn't exist in real ESM, so the built binary throws
  // "Dynamic require of node:events is not supported" on startup). Both are
  // real npm "dependencies" (see package.json), so Node resolves them from
  // node_modules at runtime same as it would for any external import.
  external: ["better-sqlite3", "commander"],
  define: {
    "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV || "production"),
  },
};

if (isWatch) {
  const context = await esbuild.context(config);
  await context.watch();
  console.log("Watching for changes...");
} else {
  await esbuild.build(config);
  console.log("Built dist/token-goat-mem.mjs");
}
