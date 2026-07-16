import { describe, expect, it, vi } from "vitest";

// Force the (otherwise fail-safe) stats computation to throw, so the route's defensive 503 catch is exercised.
// resolvePublicStatsManifestOverride is mocked too (#6275) -- the real module export the route also imports;
// `present: false` so isPublicStatsEnabled falls through to the mocked always-true check above, unaffected.
vi.mock("../../src/review/public-stats", () => ({
  isPublicStatsEnabled: () => true,
  resolvePublicStatsManifestOverride: () => Promise.resolve({ present: false, enabled: false }),
  getPublicStats: () => Promise.reject(new Error("stats boom")),
}));

import { createApp } from "../../src/api/routes";
import { createTestEnv } from "../helpers/d1";

describe("GET /v1/public/stats — error path", () => {
  it("returns 503 when stats computation throws", async () => {
    const env = createTestEnv({ LOOPOVER_PUBLIC_STATS: "1" });
    const res = await createApp().request("/v1/public/stats", {}, env);
    expect(res.status).toBe(503);
    expect((await res.json()) as { error: string }).toEqual({
      error: "public_stats_unavailable",
    });
  });
});
