import { describe, expect, it } from "vitest";
import { computeOpportunityFreshness, type FreshnessIssue } from "../../packages/loopover-engine/src/opportunity-freshness";
import { rewardRiskFreshnessInternals } from "../../src/signals/reward-risk";
import type { IssueRecord } from "../../src/types";

const { opportunityFreshnessFactor } = rewardRiskFreshnessInternals;

const NOW = Date.parse("2026-07-10T00:00:00.000Z");

function toFreshnessIssues(issues: IssueRecord[]): FreshnessIssue[] {
  return issues.map((item) => ({
    state: item.state,
    updatedAt: item.updatedAt ?? null,
    createdAt: item.createdAt ?? null,
  }));
}

function issue(overrides: Partial<IssueRecord> = {}): IssueRecord {
  return {
    repoFullName: "owner/repo",
    number: 1,
    title: "t",
    state: "open",
    authorLogin: "dev",
    authorAssociation: "NONE",
    labels: [],
    linkedPrs: [],
    body: "body",
    createdAt: "2026-07-03T00:00:00.000Z",
    updatedAt: "2026-07-03T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * #8011: `opportunityFreshnessFactor` used to hand-duplicate `computeOpportunityFreshness` and call
 * bare `Date.now()` inside the pure path. It now delegates with an injected clock — pin parity and
 * determinism so the two cannot drift the way competition briefly did before #7529.
 */
describe("opportunityFreshnessFactor delegates to computeOpportunityFreshness (#8011)", () => {
  it("agrees with the pure mirror for the same issues + clock", () => {
    const cases: IssueRecord[][] = [
      [],
      [issue({ state: "closed" })],
      [issue({ updatedAt: "2026-07-09T00:00:00.000Z" })],
      [issue({ updatedAt: "2020-01-01T00:00:00.000Z" })],
      [issue({ updatedAt: null, createdAt: null })],
      [issue({ updatedAt: "not-a-date", createdAt: "2026-07-08T00:00:00.000Z" })],
      [
        issue({ number: 1, updatedAt: "2020-01-01T00:00:00.000Z" }),
        issue({ number: 2, updatedAt: "2026-07-09T00:00:00.000Z" }),
      ],
    ];
    for (const issues of cases) {
      expect(opportunityFreshnessFactor(issues, NOW)).toBe(
        computeOpportunityFreshness(toFreshnessIssues(issues), NOW),
      );
    }
  });

  it("is deterministic for a fixed clock (no live Date.now() in the calculator)", () => {
    const issues = [issue({ updatedAt: "2026-07-03T00:00:00.000Z" })];
    const first = opportunityFreshnessFactor(issues, NOW);
    const second = opportunityFreshnessFactor(issues, NOW);
    expect(first).toBe(second);
    expect(first).toBe(computeOpportunityFreshness(toFreshnessIssues(issues), NOW));
  });

  it("returns zero freshness for a non-finite injected clock (mirror contract)", () => {
    const issues = [issue()];
    expect(opportunityFreshnessFactor(issues, Number.NaN)).toBe(0);
    expect(opportunityFreshnessFactor(issues, Number.POSITIVE_INFINITY)).toBe(0);
  });
});
