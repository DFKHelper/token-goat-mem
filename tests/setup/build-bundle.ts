import { execSync } from "child_process";

export async function setup(): Promise<void> {
  // Build the bundle once before any test runs
  console.warn("Building dist/token-goat-mem.mjs...");
  try {
    execSync("npm run build", { stdio: "inherit" });
  } catch (error) {
    console.error("Failed to build bundle:", error);
    throw error;
  }
}
