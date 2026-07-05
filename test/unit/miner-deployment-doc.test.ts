import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DEPLOYMENT_PATH = join(process.cwd(), "packages/gittensory-miner/DEPLOYMENT.md");
const README_PATH = join(process.cwd(), "packages/gittensory-miner/README.md");

describe("miner deployment guide (#2330)", () => {
  it("documents laptop and fleet modes with required walkthrough sections", () => {
    const doc = readFileSync(DEPLOYMENT_PATH, "utf8");
    expect(doc).toContain("Laptop mode");
    expect(doc).toContain("Fleet mode");
    expect(doc).toContain("gittensory-miner status");
    expect(doc).toContain("gittensory-miner doctor");
    expect(doc).toContain("GITTENSORY_MINER_CONFIG_DIR");
    expect(doc).toContain("100% client-side");
    expect(doc).toContain("credentials");
    expect(doc).toContain("docker run");
    expect(doc).toContain("docker-compose.yml");
  });

  it("is linked from the miner package README", () => {
    const readme = readFileSync(README_PATH, "utf8");
    expect(readme).toContain("DEPLOYMENT.md");
  });
});
