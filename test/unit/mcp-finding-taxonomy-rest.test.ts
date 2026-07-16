import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/routes";
import { FINDING_CATEGORIES } from "../../src/review/finding-category-classify";
import { buildFindingTaxonomyDocument } from "../../src/review/finding-taxonomy";
import { REVIEW_FINDING_SEVERITY_LADDER } from "../../src/signals/focus-manifest";
import { createTestEnv } from "../helpers/d1";

describe("GET /v1/mcp/finding-taxonomy (#6620)", () => {
  it("serves the canonical finding taxonomy without authentication", async () => {
    const app = createApp();
    const env = createTestEnv();

    const response = await app.request("/v1/mcp/finding-taxonomy", {}, env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(buildFindingTaxonomyDocument());
  });

  it("returns categories and severities exactly once", async () => {
    const app = createApp();
    const env = createTestEnv();

    const body = (await (await app.request("/v1/mcp/finding-taxonomy", {}, env)).json()) as {
      categories: string[];
      severities: string[];
    };
    expect(body.categories).toEqual([...FINDING_CATEGORIES]);
    expect(body.severities).toEqual([...REVIEW_FINDING_SEVERITY_LADDER]);
    expect(new Set(body.categories).size).toBe(FINDING_CATEGORIES.length);
    expect(new Set(body.severities).size).toBe(REVIEW_FINDING_SEVERITY_LADDER.length);
  });
});
