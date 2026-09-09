import io

def patch(path, pairs):
    s = io.open(path, encoding="utf-8").read()
    for old, new in pairs:
        assert s.count(old) == 1, (path, old[:70], s.count(old))
        s = s.replace(old, new)
    io.open(path, "w", encoding="utf-8", newline="").write(s)


# ── 1. Pinned facts must not fall off the zero-signal recall ──────────────────
patch("src/retrieval.ts", [(
    """  const visible = options.hintFormat === true ? results.filter((result) => result.trust !== "withheld") : results;
  visible.sort((a, b) => {
    const delta = b.score - a.score;
    return delta !== 0 ? delta : b.fact.captured_at.localeCompare(a.fact.captured_at);
  });""",
    """  const visible = options.hintFormat === true ? results.filter((result) => result.trust !== "withheld") : results;

  // With no rank list at all -- no query, no embedding signal, no usefulness signal -- every score
  // ties at zero and this sort falls through to its recency tie-break, so the cap below keeps the
  // newest `limit` facts and silently drops everything older. That is exactly the shape of the
  // `SessionStart` recall `mem init` installs, and a pinned fact is precisely the fact the user has
  // said must not be lost: behind 20 newer facts it vanished from the one call it was pinned for.
  //
  // Pinned facts therefore sort ahead of the rest *only in that zero-signal case*. When any real
  // signal exists, relevance decides and a pin changes nothing -- letting a pin outrank a lexical
  // match would turn `mem pin` into a ranking cheat code, and a pinned fact irrelevant to the query
  // would displace the fact that answers it.
  const zeroSignal = rankLists.length === 0;
  visible.sort((a, b) => {
    if (zeroSignal) {
      const pinDelta = Number(b.fact.status === "pinned") - Number(a.fact.status === "pinned");
      if (pinDelta !== 0) {
        return pinDelta;
      }
    }
    const delta = b.score - a.score;
    return delta !== 0 ? delta : b.fact.captured_at.localeCompare(a.fact.captured_at);
  });""",
)])

# ── 3. valid-until date predicate ─────────────────────────────────────────────
patch("src/anchors.ts", [(
    """    case "git-tracked": {""",
    """    case "valid-until": {
      const [rawDate] = args;
      if (args.length !== 1 || rawDate === undefined) {
        return "unverified";
      }
      return evaluateValidUntil(rawDate);
    }
    case "git-tracked": {""",
)])

patch("src/anchors.ts", [(
    """/** Parses an anchor string into whitespace-separated tokens. No quoting support (not needed for fs/git paths). */""",
    '''/**
 * `valid-until <ISO date>` — affirmed while the date has not passed, contradicted once it has.
 *
 * The only predicate that reads no filesystem and no git state: some facts are true until a date
 * rather than until a file changes ("until the v2 migration lands, keep the shim"), and without
 * this they had no anchor at all and stayed permanently `unverified` — caveated forever, and never
 * surfaced in `mem review` as something to resolve.
 *
 * A bare `YYYY-MM-DD` is read as the *end* of that day rather than its midnight start, so an anchor
 * written `valid-until 2026-12-31` is still affirmed during 2026-12-31 instead of expiring the
 * instant the day begins — the reading anyone writing that date intends. A timestamp with an
 * explicit time is taken exactly as written.
 *
 * An unparseable date is `unverified`, matching every other malformed-argument path here: a typo
 * must not silently read as "this fact has expired" and suppress a true fact.
 */
function evaluateValidUntil(raw: string): AnchorVerdict {
  const dateOnly = /^\\d{4}-\\d{2}-\\d{2}$/u.test(raw);
  const parsed = new Date(dateOnly ? `${raw}T23:59:59.999Z` : raw);
  const deadline = parsed.getTime();
  if (Number.isNaN(deadline)) {
    return "unverified";
  }
  return Date.now() <= deadline ? "affirmed" : "contradicted";
}

/** Parses an anchor string into whitespace-separated tokens. No quoting support (not needed for fs/git paths). */''',
)])

# capture.ts: syntax validation must accept the new predicate, or it would be stored and then
# silently downgraded to permanently-unverified by an anchors.ts that does not recognize it.
patch("src/capture.ts", [
    (" * (file-newer-than, file-exists, file-absent, file-contains, file-not-contains,\n"
     " * newest-of, glob-exists, git-branch-is, git-tracked, package-version) — accepting a",
     " * (file-newer-than, file-exists, file-absent, file-contains, file-not-contains,\n"
     " * newest-of, glob-exists, git-branch-is, git-tracked, package-version, valid-until) — accepting a"),
    ("        `(file-newer-than, file-exists, file-absent, file-contains, file-not-contains, ` +\n"
     "          `newest-of, glob-exists, git-branch-is, git-tracked, package-version) — ` +",
     "        `(file-newer-than, file-exists, file-absent, file-contains, file-not-contains, ` +\n"
     "          `newest-of, glob-exists, git-branch-is, git-tracked, package-version, valid-until) — ` +"),
])

print("ok")
