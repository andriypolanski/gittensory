import { describe, expect, it } from "vitest";
import {
  COPYCAT_SHINGLE_SIZE,
  DEFAULT_COPYCAT_MIN_ADDED_LINES,
  DEFAULT_COPYCAT_MIN_SCORE,
  assessCopycat,
  codeShingleList,
  containmentScore,
  normalizeAddedLines,
  resolveCopycatDirection,
  resolveCopycatMinScore,
} from "../../src/signals/copycat";

/** Build N distinct, long-enough lines so sliding 3-line shingles are well-formed. */
function lines(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_unused, index) => `${prefix}_line_${index}_alpha_bravo_charlie();`);
}

describe("normalizeAddedLines / codeShingleList", () => {
  it("strips comments, collapses whitespace, drops blanks, and lowercases", () => {
    expect(
      normalizeAddedLines([
        "  Const X = 1; // trailing",
        "",
        "# comment only",
        "\tConst   Y = 2;",
        42 as unknown as string,
      ]),
    ).toEqual(["const x = 1;", "const y = 2;"]);
  });

  it("returns an empty list for empty input and a single whole-block for sub-width input", () => {
    expect(codeShingleList([])).toEqual([]);
    expect(codeShingleList(["a", "b"])).toEqual(["a\nb"]);
  });

  it("slides a multiset of width-sized shingles (duplicates preserved)", () => {
    const shingles = codeShingleList(["a", "b", "c", "a", "b", "c"], 3);
    expect(shingles).toEqual(["a\nb\nc", "b\nc\na", "c\na\nb", "a\nb\nc"]);
    expect(COPYCAT_SHINGLE_SIZE).toBe(3);
  });
});

describe("containmentScore (asymmetric multiset)", () => {
  it("returns 0 for empty candidate or empty prior art", () => {
    expect(containmentScore([], lines("prior", 12))).toBe(0);
    expect(containmentScore(lines("cand", 12), [])).toBe(0);
    expect(containmentScore([], [])).toBe(0);
  });

  it("scores 100 when the candidate's added lines are fully contained in prior art", () => {
    const prior = lines("shared", 12);
    const candidate = prior.slice(0, 10);
    expect(containmentScore(candidate, prior)).toBe(100);
  });

  it("scores 0 when there is no overlapping shingle", () => {
    expect(containmentScore(lines("left", 12), lines("right", 12))).toBe(0);
  });

  it("counts repeated candidate shingles as a multiset, not a Set (#5129 blocker)", () => {
    // Sliding 3-line windows over [a,b,c,a,b,c] yield [abc, bca, cab, abc]. Prior art holding only
    // the [a,b,c] block contributes the single shingle `abc`. Multiset scoring ⇒ 2/4 = 50%. Scoring
    // the candidate as a Set instead would under-count as 1/3 ≈ 33% — the #5129 review failure mode.
    const block = ["shared_a();", "shared_b();", "shared_c();"];
    const repeated = [...block, ...block];
    expect(containmentScore(repeated, block)).toBe(50);
  });

  it("is reformatting-invariant (whitespace / comment / case)", () => {
    const prior = ["const Token = 1;", "const Other = 2;", "const Third = 3;", "const Fourth = 4;"];
    const candidate = [
      "  CONST   token = 1; // noise",
      "const   Other = 2;",
      "CONST third = 3;",
      "const fourth = 4;",
    ];
    expect(containmentScore(candidate, prior)).toBe(100);
  });

  it("documents the short-snippet false-negative tradeoff (< SHINGLE_SIZE)", () => {
    // Two-line verbatim lift out of a longer prior-art file scores 0 because the whole-block
    // candidate token never appears as a 3-line prior shingle.
    const prior = lines("long", 12);
    const shortLift = prior.slice(0, 2);
    expect(shortLift.length).toBeLessThan(COPYCAT_SHINGLE_SIZE);
    expect(containmentScore(shortLift, prior)).toBe(0);
  });
});

describe("resolveCopycatDirection / resolveCopycatMinScore", () => {
  it("marks the later submission as candidate_copied and the earlier as prior_copied", () => {
    expect(
      resolveCopycatDirection(
        { submittedAt: "2026-07-01T12:11:00.000Z" },
        { submittedAt: "2026-07-01T12:00:00.000Z" },
      ),
    ).toBe("candidate_copied");
    expect(
      resolveCopycatDirection(
        { submittedAt: "2026-07-01T12:00:00.000Z" },
        { submittedAt: "2026-07-01T12:11:00.000Z" },
      ),
    ).toBe("prior_copied");
  });

  it("returns ambiguous on ties, missing, blank, or unparseable timestamps", () => {
    expect(
      resolveCopycatDirection(
        { submittedAt: "2026-07-01T12:00:00.000Z" },
        { submittedAt: "2026-07-01T12:00:00.000Z" },
      ),
    ).toBe("ambiguous");
    expect(resolveCopycatDirection({ submittedAt: null }, { submittedAt: "2026-07-01T12:00:00.000Z" })).toBe(
      "ambiguous",
    );
    expect(resolveCopycatDirection({ submittedAt: "2026-07-01T12:00:00.000Z" }, { submittedAt: "   " })).toBe(
      "ambiguous",
    );
    expect(resolveCopycatDirection({ submittedAt: "not-a-date" }, { submittedAt: "2026-07-01T12:00:00.000Z" })).toBe(
      "ambiguous",
    );
    expect(resolveCopycatDirection({}, {})).toBe("ambiguous");
  });

  it("clamps / defaults minScore", () => {
    expect(resolveCopycatMinScore(undefined)).toBe(DEFAULT_COPYCAT_MIN_SCORE);
    expect(resolveCopycatMinScore(null)).toBe(DEFAULT_COPYCAT_MIN_SCORE);
    expect(resolveCopycatMinScore(Number.NaN)).toBe(DEFAULT_COPYCAT_MIN_SCORE);
    expect(resolveCopycatMinScore(-10)).toBe(0);
    expect(resolveCopycatMinScore(150)).toBe(100);
    expect(resolveCopycatMinScore(87.4)).toBe(87);
  });
});

describe("assessCopycat", () => {
  const priorLines = lines("shared", 14);
  const candidateLines = priorLines.slice(0, 12);
  const later = {
    pullNumber: 20,
    submittedAt: "2026-07-01T12:11:00.000Z",
    authorLogin: "copycat",
  };
  const earlier = {
    pullNumber: 10,
    submittedAt: "2026-07-01T12:00:00.000Z",
    authorLogin: "original",
  };

  it("emits a finding when mode/score/direction/min-lines/authors all clear the precision guards", () => {
    const result = assessCopycat({
      candidateLines,
      priorArtLines: priorLines,
      candidate: later,
      priorArt: earlier,
      mode: "block",
      minScore: 85,
    });
    expect(result.containmentScore).toBe(100);
    expect(result.direction).toBe("candidate_copied");
    expect(result.wouldAct).toBe(true);
    expect(result.finding?.code).toBe("copycat_containment");
    expect(result.finding?.severity).toBe("critical");
    expect(result.finding?.detail).toContain("PR #10");
    expect(result.finding?.detail).toContain("100%");
    expect(result.finding?.publicText).toBe(result.finding?.detail);
    expect(result.candidateAddedLines).toBeGreaterThanOrEqual(DEFAULT_COPYCAT_MIN_ADDED_LINES);
  });

  it.each([
    ["warn", "info"],
    ["label", "warning"],
    ["block", "critical"],
  ] as const)("maps mode %s to severity %s", (mode, severity) => {
    const result = assessCopycat({
      candidateLines,
      priorArtLines: priorLines,
      candidate: later,
      priorArt: earlier,
      mode,
    });
    expect(result.finding?.severity).toBe(severity);
  });

  it("never acts when mode is off (score still computed)", () => {
    const result = assessCopycat({
      candidateLines,
      priorArtLines: priorLines,
      candidate: later,
      priorArt: earlier,
      mode: "off",
    });
    expect(result.containmentScore).toBe(100);
    expect(result.wouldAct).toBe(false);
    expect(result.finding).toBeNull();
  });

  it("never acts when the candidate is the earlier victim", () => {
    const result = assessCopycat({
      candidateLines,
      priorArtLines: priorLines,
      candidate: earlier,
      priorArt: later,
      mode: "warn",
    });
    expect(result.direction).toBe("prior_copied");
    expect(result.wouldAct).toBe(false);
    expect(result.finding).toBeNull();
  });

  it("never acts on ambiguous timestamps or same-author pairs", () => {
    expect(
      assessCopycat({
        candidateLines,
        priorArtLines: priorLines,
        candidate: { ...later, submittedAt: null },
        priorArt: earlier,
        mode: "label",
      }).wouldAct,
    ).toBe(false);
    expect(
      assessCopycat({
        candidateLines,
        priorArtLines: priorLines,
        candidate: { ...later, authorLogin: "SameDev" },
        priorArt: { ...earlier, authorLogin: "samedev" },
        mode: "block",
      }).wouldAct,
    ).toBe(false);
  });

  it("never acts below the threshold or below the min-added-lines floor", () => {
    expect(
      assessCopycat({
        candidateLines,
        priorArtLines: priorLines,
        candidate: later,
        priorArt: earlier,
        mode: "block",
        minScore: 100,
      }).wouldAct,
    ).toBe(true);
    expect(
      assessCopycat({
        candidateLines: lines("unique", 12),
        priorArtLines: priorLines,
        candidate: later,
        priorArt: earlier,
        mode: "block",
        minScore: 85,
      }).wouldAct,
    ).toBe(false);
    expect(
      assessCopycat({
        candidateLines: priorLines.slice(0, 4),
        priorArtLines: priorLines,
        candidate: later,
        priorArt: earlier,
        mode: "warn",
        minAddedLines: 10,
      }).wouldAct,
    ).toBe(false);
  });

  it("treats absent/unknown mode as off and falls back to the default threshold", () => {
    const result = assessCopycat({
      candidateLines,
      priorArtLines: priorLines,
      candidate: later,
      priorArt: earlier,
      mode: undefined,
      minScore: undefined,
    });
    expect(result.wouldAct).toBe(false);
    expect(result.resolvedMinScore).toBe(DEFAULT_COPYCAT_MIN_SCORE);
  });

  it("omits the prior PR number from the finding when it is missing", () => {
    const result = assessCopycat({
      candidateLines,
      priorArtLines: priorLines,
      candidate: later,
      priorArt: { ...earlier, pullNumber: null },
      mode: "warn",
    });
    expect(result.finding?.detail).toContain("earlier prior art");
    expect(result.finding?.detail).not.toContain("PR #");
  });

  it("covers blank logins, zero/NaN prior PR numbers, and undefined inputs", () => {
    expect(
      assessCopycat({
        candidateLines,
        priorArtLines: priorLines,
        candidate: { ...later, authorLogin: "   " },
        priorArt: earlier,
        mode: "block",
      }).wouldAct,
    ).toBe(true);
    expect(
      assessCopycat({
        candidateLines,
        priorArtLines: priorLines,
        candidate: later,
        priorArt: { ...earlier, pullNumber: 0 },
        mode: "warn",
      }).finding?.detail,
    ).toContain("earlier prior art");
    expect(
      assessCopycat({
        candidateLines,
        priorArtLines: priorLines,
        candidate: later,
        priorArt: { ...earlier, pullNumber: Number.NaN },
        mode: "label",
      }).finding?.detail,
    ).toContain("earlier prior art");
    // Undefined lines / submissions take the empty-default arms without throwing.
    const empty = assessCopycat({
      candidateLines: undefined as unknown as string[],
      priorArtLines: undefined as unknown as string[],
      candidate: undefined as unknown as typeof later,
      priorArt: undefined as unknown as typeof earlier,
      mode: "warn",
      minAddedLines: -1,
    });
    expect(empty.containmentScore).toBe(0);
    expect(empty.wouldAct).toBe(false);
    expect(empty.candidateAddedLines).toBe(0);
    expect(
      assessCopycat({
        candidateLines,
        priorArtLines: priorLines,
        candidate: later,
        priorArt: earlier,
        mode: "block",
        minAddedLines: 5.6,
      }).wouldAct,
    ).toBe(true);
  });
});
