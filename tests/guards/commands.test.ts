/**
 * Guard tests over the CLI's registered command surface. These were placeholder stubs
 * (`expect(true).toBe(true)`); they now assert the real invariants they described: every command
 * the design plan / P5 promises ("viewable / editable / deletable via CLI (`list`, `show`,
 * `forget`, `pin`, `edit`, `review`)", plus `remember`/`recall`/`epoch` from Sections 3/4 and the
 * `doctor` health check) is registered on `buildProgram()`, and nothing unexpected is.
 */
import { describe, it, expect } from "vitest";

import { buildProgram } from "../../src/cli.js";

const EXPECTED_COMMANDS = [
  "doctor",
  "edit",
  "epoch",
  "forget",
  "import",
  "list",
  "pin",
  "recall",
  "remember",
  "review",
  "show",
] as const;

describe("Command guards", () => {
  it("registers every command the design plan promises", () => {
    const registered = buildProgram()
      .commands.map((command) => command.name())
      .sort();
    for (const expected of EXPECTED_COMMANDS) {
      expect(registered).toContain(expected);
    }
  });

  it("registers no commands beyond the documented surface", () => {
    const registered = buildProgram()
      .commands.map((command) => command.name())
      .sort();
    expect(registered).toEqual([...EXPECTED_COMMANDS]);
  });
});
