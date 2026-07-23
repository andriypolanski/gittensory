import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assembleCounterfactualFixtures,
  COUNTERFACTUAL_SAMPLE_SEED_PREFIX,
  type BacktestCase,
} from "../dist/index.js";

const SEED = `${COUNTERFACTUAL_SAMPLE_SEED_PREFIX}:workspace-suite`;

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

test("barrel: the public entrypoint re-exports the fixture assembler (#8220)", () => {
  assert.equal(typeof assembleCounterfactualFixtures, "function");
});

test("assembler round-trip: eligibility, era provenance, and skip accounting per the #8219 contract", () => {
  const { fixtures, skipped } = assembleCounterfactualFixtures(
    [
      replayable("acme/widgets#1", "reversed"),
      { ...replayable("acme/widgets#2"), metadata: { confidence: 0.5 } },
      replayable("acme/widgets#3", "confirmed", { rawContextProvenance: "github_raw_context_refetch" }),
    ],
    { seed: SEED, maxFixtures: 10 },
  );
  assert.equal(fixtures.length, 2);
  assert.equal(fixtures[0]!.provenance, "live_capture");
  assert.equal(fixtures[1]!.provenance, "raw_context_refetch");
  assert.deepEqual(skipped, { no_raw_context: 1, sampled_out: 0 });
});

test("seeded sampling is deterministic and accounts every sampled-out case", () => {
  const cases = Array.from({ length: 25 }, (_, i) => replayable(`acme/widgets#${i + 1}`));
  const first = assembleCounterfactualFixtures(cases, { seed: SEED, maxFixtures: 9 });
  assert.equal(first.fixtures.length, 9);
  assert.equal(first.skipped.sampled_out, 16);
  assert.deepEqual(assembleCounterfactualFixtures(cases, { seed: SEED, maxFixtures: 9 }), first);
});
