// Counterfactual fixture assembler (#8220, sub-epic phase 2): from a labeled corpus, select and shape
// exactly the cases that are replayable under the #8219 contract — pure selection, no AI calls, no IO.
// Implements the contract's fixture/sampling shapes VERBATIM (counterfactual-contract.ts); every exclusion
// is accounted for in the return shape (the #8139 skipped-case discipline), never silently dropped.
//
// PROVENANCE: the #8207/#8170 backfill patches a re-fetched row's metadata with a `rawContextProvenance`
// tag (RAW_CONTEXT_REFETCH_PROVENANCE in scripts/backfill-calibration-corpus-phase2-core.ts); the live
// #8129/#8130 capture writers never set that key. Presence of the key is therefore the era discriminator —
// any tagged row is backfilled context, an untagged replayable row is live-captured.
//
// SAMPLING: when the eligible set exceeds the contract's budget, membership is decided by the same
// content-hash discipline as splitBacktestCorpus — sha256(`${seed}:${targetKey}`), first 8 hex chars as the
// rank, lowest ranks win — never "the first N", which would bias toward old cases. Selection keeps the
// corpus's own case order (no shuffle); a rank tie (two firings of the SAME target share a hash) breaks
// toward the earlier case, deterministically.

import { createHash } from "node:crypto";
import type { BacktestCase } from "./backtest-corpus.js";
import {
  isReplayableCase,
  type CounterfactualFixture,
  type CounterfactualSamplingContract,
  type CounterfactualSkipReason,
} from "./counterfactual-contract.js";

export type CounterfactualFixtureAssembly = {
  /** Replayable fixtures in corpus order, at most `contract.maxFixtures` of them. */
  fixtures: CounterfactualFixture[];
  /** Why every non-fixture case was excluded — `fixtures.length` plus these counts always sums to the
   *  input corpus size (pinned by an invariant test). */
  skipped: Record<CounterfactualSkipReason, number>;
};

function sampleRank(seed: string, targetKey: string): number {
  return parseInt(createHash("sha256").update(`${seed}:${targetKey}`).digest("hex").slice(0, 8), 16);
}

function toFixture(backtestCase: BacktestCase): CounterfactualFixture {
  // isReplayableCase already guaranteed a non-empty string diff for every case reaching here.
  const metadata = backtestCase.metadata!;
  return {
    fixtureId: backtestCase.targetKey,
    label: backtestCase.label,
    boundedInputs: { diff: metadata.diff as string },
    provenance: "rawContextProvenance" in metadata ? "raw_context_refetch" : "live_capture",
  };
}

/**
 * Assemble the replayable fixture set for one campaign per the #8219 contract: filter to cases carrying
 * bounded raw context (via the contract's own {@link isReplayableCase}), apply the seeded deterministic
 * sample when the eligible set exceeds `contract.maxFixtures`, and emit fixtures with era provenance —
 * with full skip accounting for everything excluded. Deterministic: same corpus + contract ⇒ same fixture
 * set, byte for byte.
 */
export function assembleCounterfactualFixtures(
  cases: readonly BacktestCase[],
  contract: CounterfactualSamplingContract,
): CounterfactualFixtureAssembly {
  const skipped: Record<CounterfactualSkipReason, number> = { no_raw_context: 0, sampled_out: 0 };
  const eligible: BacktestCase[] = [];
  for (const backtestCase of cases) {
    if (!isReplayableCase(backtestCase)) {
      skipped.no_raw_context += 1;
      continue;
    }
    eligible.push(backtestCase);
  }

  let selected = eligible;
  if (eligible.length > contract.maxFixtures) {
    const kept = new Set(
      eligible
        .map((backtestCase, index) => ({ index, rank: sampleRank(contract.seed, backtestCase.targetKey) }))
        .sort((a, b) => a.rank - b.rank || a.index - b.index)
        .slice(0, contract.maxFixtures)
        .map((entry) => entry.index),
    );
    selected = eligible.filter((_, index) => kept.has(index));
    skipped.sampled_out = eligible.length - selected.length;
  }

  return { fixtures: selected.map(toFixture), skipped };
}
