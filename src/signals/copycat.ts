// Deterministic copycat / plagiarism containment engine (#1969 Phase 1; #1409 design).
// Sibling of the anti-slop signal and of packages/loopover-engine's self-plagiarism throttle: pure,
// no IO, no Date.now(), no randomness — identical inputs always yield the identical verdict.
//
// What it measures: the asymmetric containment of THIS candidate's added-code shingles inside an
// earlier piece of prior art (answers "how much of THIS PR is copied FROM prior art"). Direction
// by submission timestamp is load-bearing — the earlier submission is the victim; only the later
// one can be the copycat. Missing / unparseable / tied timestamps are `ambiguous` and never act.
//
// DETECTOR ONLY — gates nothing on its own. The already-scaffolded `gate.copycat.mode` /
// `gate.copycat.minScore` config (#4140) is still inert at the call site; wiring this engine into
// advisory / processors (label → block → strikes) is a deferred Phase 2/3 follow-up against #1969.
// False-accusation-averse: a finding is emitted only when mode is non-`off`, the score clears the
// threshold, the candidate has enough added lines, authors differ, AND direction is unambiguously
// `candidate_copied`.

import type { AdvisoryFinding, AdvisorySeverity, CopycatGateMode } from "../types";

/** Conservative default — only very high containment scores would act (precision-first, #1409). */
export const DEFAULT_COPYCAT_MIN_SCORE = 85;

/** Minimum added (normalized) lines on the candidate before containment is even considered — a
 *  tiny high-% overlap is not theft. */
export const DEFAULT_COPYCAT_MIN_ADDED_LINES = 10;

/** Multi-line shingle width. Short incidental coincidences (`}`, `return null;`) must not inflate
 *  the score. Deliberate false-negative tradeoff: a verbatim copy shorter than this width collapses
 *  to a single whole-block token and only matches an identically-short prior-art block (#5129). */
export const COPYCAT_SHINGLE_SIZE = 3;

export type CopycatDirection = "candidate_copied" | "prior_copied" | "ambiguous";

export type CopycatSubmission = {
  /** Pull request number (or other stable id) of this submission — surfaced in findings when present. */
  pullNumber?: number | null | undefined;
  /** ISO-8601 submission timestamp — earlier submission = original/victim. */
  submittedAt?: string | null | undefined;
  /** GitHub login of the author; same-author pairs never produce a finding. */
  authorLogin?: string | null | undefined;
};

export type CopycatAssessmentInput = {
  /** Added code lines of the PR under review (caller-normalized: exclude_paths already applied). */
  candidateLines: readonly string[];
  /** Added code lines of one piece of prior art (earlier open / recently merged/closed PR). */
  priorArtLines: readonly string[];
  candidate: CopycatSubmission;
  priorArt: CopycatSubmission;
  /** `gate.copycat.mode`. `off`/absent ⇒ score is still computed for observability, but no finding. */
  mode?: CopycatGateMode | null | undefined;
  /** `gate.copycat.minScore` (0-100). Non-finite / out-of-range clamps to the default. */
  minScore?: number | null | undefined;
  /** Override for the minimum-added-lines floor (tests / advanced callers). */
  minAddedLines?: number | null | undefined;
};

export type CopycatAssessment = {
  /** Asymmetric containment of the candidate inside prior art, rounded 0-100. */
  containmentScore: number;
  direction: CopycatDirection;
  /** True when a public finding would act under the configured mode + guards. */
  wouldAct: boolean;
  /** Public-safe finding when `wouldAct` is true; otherwise null. */
  finding: AdvisoryFinding | null;
  /** Resolved threshold actually used (after clamping). */
  resolvedMinScore: number;
  /** Normalized added-line count on the candidate (post whitespace/comment strip). */
  candidateAddedLines: number;
};

function normalizeLine(line: string): string {
  // Strip // and # line comments, then collapse whitespace + lowercase so reformatting never reads
  // as novel content. Block comments / strings are left alone — a perfect strip would need a parser
  // and this detector is deliberately format-agnostic and dependency-free.
  return line
    .replace(/\/\/.*$/, "")
    .replace(/#.*$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Normalize + drop blanks; exported for tests. */
export function normalizeAddedLines(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (typeof line !== "string") continue;
    const normalized = normalizeLine(line);
    if (normalized) out.push(normalized);
  }
  return out;
}

/**
 * Sliding multi-line shingles as a LIST (multiset). A candidate with repeated shingles must count
 * each occurrence toward containment — treating the candidate as a Set would under-count the
 * advertised "percentage of the candidate's added-code shingles" (#5129 blocker). Exported for tests.
 */
export function codeShingleList(normalizedLines: readonly string[], width = COPYCAT_SHINGLE_SIZE): string[] {
  if (normalizedLines.length === 0) return [];
  if (normalizedLines.length < width) {
    // Whole-block fallback for short candidates — documented FN for a short verbatim lift out of a
    // longer prior-art file (see module header / #5129 nit).
    return [normalizedLines.join("\n")];
  }
  const shingles: string[] = [];
  for (let index = 0; index <= normalizedLines.length - width; index += 1) {
    shingles.push(normalizedLines.slice(index, index + width).join("\n"));
  }
  return shingles;
}

/**
 * Asymmetric containment: fraction of the CANDIDATE's shingles (multiset) found in prior art,
 * rounded to a 0-100 percentage. Empty candidate ⇒ 0 (nothing to accuse). Empty prior with a
 * non-empty candidate ⇒ 0.
 */
export function containmentScore(candidateLines: readonly string[], priorArtLines: readonly string[]): number {
  const candidate = codeShingleList(normalizeAddedLines(candidateLines));
  if (candidate.length === 0) return 0;
  const prior = new Set(codeShingleList(normalizeAddedLines(priorArtLines)));
  if (prior.size === 0) return 0;
  let contained = 0;
  for (const shingle of candidate) {
    if (prior.has(shingle)) contained += 1;
  }
  return Math.round((contained / candidate.length) * 100);
}

function parseTimestampMs(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Direction by timestamp. Earlier submission = original/victim. Ties and missing/unparseable
 * timestamps are `ambiguous` — never act on them (false-accusation-averse).
 */
export function resolveCopycatDirection(
  candidate: CopycatSubmission,
  priorArt: CopycatSubmission,
): CopycatDirection {
  const candidateMs = parseTimestampMs(candidate.submittedAt);
  const priorMs = parseTimestampMs(priorArt.submittedAt);
  if (candidateMs === null || priorMs === null) return "ambiguous";
  if (candidateMs === priorMs) return "ambiguous";
  return candidateMs > priorMs ? "candidate_copied" : "prior_copied";
}

export function resolveCopycatMinScore(minScore: number | null | undefined): number {
  if (typeof minScore !== "number" || !Number.isFinite(minScore)) return DEFAULT_COPYCAT_MIN_SCORE;
  return Math.min(100, Math.max(0, Math.round(minScore)));
}

function resolveMinAddedLines(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return DEFAULT_COPYCAT_MIN_ADDED_LINES;
  }
  return Math.round(value);
}

function normalizeLogin(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

function severityForMode(mode: CopycatGateMode): AdvisorySeverity {
  if (mode === "block") return "critical";
  if (mode === "label") return "warning";
  return "info";
}

function buildCopycatFinding(args: {
  mode: CopycatGateMode;
  score: number;
  threshold: number;
  priorPullNumber: number | null;
}): AdvisoryFinding {
  const sourceRef =
    args.priorPullNumber !== null && args.priorPullNumber > 0 ? ` earlier PR #${args.priorPullNumber}` : " earlier prior art";
  const detail =
    `This pull request's added code overlaps${sourceRef} at ${args.score}% containment ` +
    `(threshold ${args.threshold}%). Please confirm originality or attribution before merge.`;
  return {
    code: "copycat_containment",
    title: "Possible copycat of earlier work",
    severity: severityForMode(args.mode),
    detail,
    action: "Confirm the change is original or properly attributed, or close if it duplicates earlier work.",
    // Public-safe: score + threshold + optional prior PR number only — never raw code, paths, or author identity.
    publicText: detail,
  };
}

/**
 * Assess one candidate against one piece of prior art under the configured `gate.copycat` mode.
 * Pure / fail-safe: never throws; never flags the earlier victim or same-author pairs.
 */
export function assessCopycat(input: CopycatAssessmentInput): CopycatAssessment {
  const mode: CopycatGateMode =
    input.mode === "warn" || input.mode === "label" || input.mode === "block" ? input.mode : "off";
  const resolvedMinScore = resolveCopycatMinScore(input.minScore);
  const minAddedLines = resolveMinAddedLines(input.minAddedLines);
  const normalizedCandidate = normalizeAddedLines(input.candidateLines ?? []);
  const score = containmentScore(input.candidateLines ?? [], input.priorArtLines ?? []);
  const direction = resolveCopycatDirection(input.candidate ?? {}, input.priorArt ?? {});

  const candidateLogin = normalizeLogin(input.candidate?.authorLogin);
  const priorLogin = normalizeLogin(input.priorArt?.authorLogin);
  const sameAuthor = candidateLogin !== null && priorLogin !== null && candidateLogin === priorLogin;

  const priorPull =
    typeof input.priorArt?.pullNumber === "number" && Number.isFinite(input.priorArt.pullNumber)
      ? Math.trunc(input.priorArt.pullNumber)
      : null;

  const wouldAct =
    mode !== "off" &&
    !sameAuthor &&
    direction === "candidate_copied" &&
    normalizedCandidate.length >= minAddedLines &&
    score >= resolvedMinScore;

  return {
    containmentScore: score,
    direction,
    wouldAct,
    finding: wouldAct
      ? buildCopycatFinding({ mode, score, threshold: resolvedMinScore, priorPullNumber: priorPull })
      : null,
    resolvedMinScore,
    candidateAddedLines: normalizedCandidate.length,
  };
}
