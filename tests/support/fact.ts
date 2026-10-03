/** The one `Fact` factory for tests: a complete base of every required field with `overrides` spread last, so a new required `Fact` field breaks compilation here once instead of in every test file. A plain module rather than a `.test.ts` one so importing it does not re-register the importing file's tests. */
import type { Fact } from "../../src/types.js";

/** Builds a `Fact` from `overrides`; optional fields stay absent unless passed. Defaults follow the majority of former call sites (a project-scoped, active, user-sourced `preference` with text `fact <id>`), and `embedding` is always `null` because retrieval.ts only skips a fact whose embedding is exactly `null`. */
export function makeFact(overrides: Partial<Fact> & Pick<Fact, "id">): Fact {
  return {
    text: `fact ${overrides.id}`,
    kind: "preference",
    subject: null,
    value: null,
    scope: "project",
    source_type: "user",
    source_ref: null,
    captured_at: "2026-01-01T00:00:00.000Z",
    anchor: null,
    status: "active",
    confidence: 1,
    embedding: null,
    ...overrides,
  };
}
