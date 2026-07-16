import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/routes";
import { buildEnrichmentAnalyzersTaxonomyDocument } from "../../src/review/enrichment-analyzers-taxonomy";
import { createTestEnv } from "../helpers/d1";

const metadataPath = join(process.cwd(), "review-enrichment/analyzer-metadata.json");

describe("GET /v1/mcp/enrichment-analyzers (#6620)", () => {
  it("serves the canonical enrichment analyzer taxonomy without authentication", async () => {
    const app = createApp();
    const env = createTestEnv();

    const response = await app.request("/v1/mcp/enrichment-analyzers", {}, env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(buildEnrichmentAnalyzersTaxonomyDocument());
  });

  it("projects analyzer-metadata.json into the REST taxonomy shape", async () => {
    const raw = JSON.parse(readFileSync(metadataPath, "utf8")) as {
      defaultProfile: string;
      analyzers: Array<{ name: string; category: string; cost: string; profiles: string[] }>;
    };
    const app = createApp();
    const env = createTestEnv();

    const body = (await (await app.request("/v1/mcp/enrichment-analyzers", {}, env)).json()) as {
      defaultProfile: string;
      analyzers: Array<{ name: string; category: string; costClass: string; profiles: string[] }>;
    };
    expect(body.defaultProfile).toBe(raw.defaultProfile);
    expect(body.analyzers).toHaveLength(raw.analyzers.length);
    for (const expected of raw.analyzers) {
      const actual = body.analyzers.find((analyzer) => analyzer.name === expected.name);
      expect(actual).toMatchObject({
        category: expected.category,
        costClass: expected.cost,
        profiles: expected.profiles,
      });
    }
  });
});
