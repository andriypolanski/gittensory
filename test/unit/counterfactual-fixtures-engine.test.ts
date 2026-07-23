import { describe, expect, it } from "vitest";

// Import the engine SOURCE directly (not the built dist) -- coverage.include lists
// packages/loopover-engine/src/**, so only a source-path import exercises the .ts these branches live in
// (the dist-importing twin in packages/loopover-engine/test/ covers the built barrel for the workspace
// suite). Same pattern as backtest-corpus-engine.test.ts / repo-corpus-engine.test.ts.
import { assembleCounterfactualFixtures } from "../../packages/loopover-engine/src/calibration/counterfactual-fixtures";
import { COUNTERFACTUAL_SAMPLE_SEED_PREFIX } from "../../packages/loopover-engine/src/calibration/counterfactual-contract";
import type { BacktestCase } from "../../packages/loopover-engine/src/calibration/backtest-corpus";

const SEED = `${COUNTERFACTUAL_SAMPLE_SEED_PREFIX}:test-campaign`;

function replayable(targetKey: string, label: BacktestCase["label"] = "confirmed", extraMetadata: Record<string, unknown> = {}): BacktestCase {
  return {
    ruleId: "ai_consensus_defect",
    targetKey,
    outcome: "close",
    label,
    firedAt: "2026-07-01T00:00:00.000Z",
    decidedAt: "2026-07-02T00:00:00.000Z",
    metadata: { diff: `@@ diff for ${targetKey}`, ...extraMetadata },
  };
}

describe("assembleCounterfactualFixtures (#8220)", () => {
  it("shapes replayable cases into fixtures with era provenance, skipping context-less cases with accounting", () => {
    const cases: BacktestCase[] = [
      replayable("acme/widgets#1", "reversed"),
      { ...replayable("acme/widgets#2"), metadata: { confidence: 0.9 } }, // no diff — not replayable
      { ...replayable("acme/widgets#3"), metadata: { diff: "" } }, // empty diff — not replayable
      replayable("acme/widgets#4", "confirmed", { rawContextProvenance: "github_raw_context_refetch" }),
    ];
    const { fixtures, skipped } = assembleCounterfactualFixtures(cases, { seed: SEED, maxFixtures: 10 });
    expect(fixtures).toEqual([
      {
        fixtureId: "acme/widgets#1",
        label: "reversed",
        boundedInputs: { diff: "@@ diff for acme/widgets#1" },
        provenance: "live_capture",
      },
      {
        fixtureId: "acme/widgets#4",
        label: "confirmed",
        boundedInputs: { diff: "@@ diff for acme/widgets#4" },
        provenance: "raw_context_refetch",
      },
    ]);
    expect(skipped).toEqual({ no_raw_context: 2, sampled_out: 0 });
    // Sum invariant: every input case is a fixture or an accounted skip.
    expect(fixtures.length + skipped.no_raw_context + skipped.sampled_out).toBe(cases.length);
  });

  it("applies the seeded sample only when the eligible set exceeds the budget, preserving corpus order", () => {
    const cases = Array.from({ length: 20 }, (_, i) => replayable(`acme/widgets#${i + 1}`));
    const under = assembleCounterfactualFixtures(cases, { seed: SEED, maxFixtures: 20 });
    expect(under.fixtures).toHaveLength(20);
    expect(under.skipped.sampled_out).toBe(0);

    const sampled = assembleCounterfactualFixtures(cases, { seed: SEED, maxFixtures: 7 });
    expect(sampled.fixtures).toHaveLength(7);
    expect(sampled.skipped.sampled_out).toBe(13);
    // Corpus order is preserved within the sample — fixture ids ascend by original position.
    const positions = sampled.fixtures.map((fixture) => cases.findIndex((c) => c.targetKey === fixture.fixtureId));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("is deterministic per seed, differs across seeds, and never selects 'the first N'", () => {
    const cases = Array.from({ length: 30 }, (_, i) => replayable(`acme/widgets#${i + 1}`));
    const first = assembleCounterfactualFixtures(cases, { seed: SEED, maxFixtures: 10 });
    expect(assembleCounterfactualFixtures(cases, { seed: SEED, maxFixtures: 10 })).toEqual(first);

    const otherSeed = assembleCounterfactualFixtures(cases, { seed: `${SEED}-b`, maxFixtures: 10 });
    expect(otherSeed.fixtures.map((f) => f.fixtureId)).not.toEqual(first.fixtures.map((f) => f.fixtureId));
    // Hash-ranked membership, not positional truncation.
    expect(first.fixtures.map((f) => f.fixtureId)).not.toEqual(cases.slice(0, 10).map((c) => c.targetKey));
  });

  it("breaks a same-target rank tie toward the earlier case, deterministically", () => {
    // Two firings of the SAME target share a sample hash — a two-element sort MUST compare exactly that
    // tied pair, forcing the position tie-break: the earlier firing wins the single slot.
    const cases = [replayable("acme/widgets#7", "confirmed"), replayable("acme/widgets#7", "reversed")];
    const { fixtures, skipped } = assembleCounterfactualFixtures(cases, { seed: SEED, maxFixtures: 1 });
    expect(fixtures).toHaveLength(1);
    expect(fixtures[0]).toMatchObject({ fixtureId: "acme/widgets#7", label: "confirmed" });
    expect(skipped.sampled_out).toBe(1);
    // Reproducible byte-for-byte.
    expect(assembleCounterfactualFixtures(cases, { seed: SEED, maxFixtures: 1 })).toEqual({ fixtures, skipped });
  });

  it("returns an empty assembly for an empty corpus", () => {
    expect(assembleCounterfactualFixtures([], { seed: SEED, maxFixtures: 5 })).toEqual({
      fixtures: [],
      skipped: { no_raw_context: 0, sampled_out: 0 },
    });
  });
});
