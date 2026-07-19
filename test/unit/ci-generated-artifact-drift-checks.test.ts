import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

function readYaml(path: string): Record<string, unknown> {
  return record(parse(readFileSync(path, "utf8")), path);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function recordArray(value: unknown, label: string): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((entry, index) => record(entry, `${label}[${index}]`));
}

// Generated-artifact drift guard: selfhost:env-reference:check, command-reference:check, and docs:drift-check
// were each part of the local `npm run test:ci` aggregate script, but none were wired into
// .github/workflows/ci.yml's validate-code job -- only local discipline enforced them, so a merged PR could (and
// did, twice in one day) leave the corresponding generated reference file or docs page stale with zero CI
// signal. Mirrors ci-cf-typegen-check.test.ts's own assertion shape for the same class of drift guard.
describe("generated-artifact drift checks are wired into CI, not just local test:ci", () => {
  const checks: Array<{ script: string; command: string; stepName: string }> = [
    { script: "selfhost:env-reference:check", command: "npm run selfhost:env-reference:check", stepName: "Selfhost env-reference drift check" },
    { script: "command-reference:check", command: "npm run command-reference:check", stepName: "Command reference drift check" },
    { script: "docs:drift-check", command: "npm run docs:drift-check", stepName: "Docs drift check" },
  ];

  it.each(checks)("package.json defines $script and wires it into test:ci", ({ script, command }) => {
    const pkg = record(JSON.parse(readFileSync("package.json", "utf8")), "package.json");
    const scripts = record(pkg.scripts, "package.json.scripts");

    expect(scripts[script]).toBeDefined();
    expect(String(scripts["test:ci"])).toContain(command);
  });

  it.each(checks)("ci.yml's validate-code job runs a step for $script, gated on backend OR ui changes", ({ command, stepName }) => {
    const workflow = readYaml(".github/workflows/ci.yml");
    const validateCode = record(record(workflow.jobs, "workflow.jobs")["validate-code"], "workflow.jobs.validate-code");
    const steps = recordArray(validateCode.steps, "jobs.validate-code.steps");

    const step = steps.find((entry) => entry.name === stepName);
    expect(step).toBeDefined();
    expect(String(step!.run)).toBe(command);
    // Gated on backend OR ui (not backend alone): the generated artifact each check validates lives under
    // apps/loopover-ui/**, so a UI-only edit that hand-desyncs it from its source of truth must still
    // re-trigger the check, not just a backend source change (#loopover-pr-3254-review).
    const condition = String(step!.if);
    expect(condition).toContain("needs.changes.outputs.backend == 'true'");
    expect(condition).toContain("needs.changes.outputs.ui == 'true'");
  });

  // Docs drift check additionally reads packages/loopover-engine/src/focus-manifest.ts (cross-checked
  // against .loopover.yml.example), a dependency its two siblings don't share -- so its condition is a
  // deliberate superset (backend || ui || engine) rather than byte-identical to theirs. The invariant this
  // test enforces is "every check still fires on backend OR ui at minimum" (already covered by the
  // it.each above), not "all three conditions are identical" -- padding `engine` onto the other two just
  // to preserve exact-string uniformity would misrepresent what they actually depend on.
  it("Docs drift check's condition is engine-widened; its two siblings stay on backend||ui only", () => {
    const workflow = readYaml(".github/workflows/ci.yml");
    const validateCode = record(record(workflow.jobs, "workflow.jobs")["validate-code"], "workflow.jobs.validate-code");
    const steps = recordArray(validateCode.steps, "jobs.validate-code.steps");

    const conditionFor = (stepName: string) => {
      const step = steps.find((entry) => entry.name === stepName);
      expect(step).toBeDefined();
      return String(step!.if);
    };

    expect(conditionFor("Docs drift check")).toContain("needs.changes.outputs.engine == 'true'");
    expect(conditionFor("Selfhost env-reference drift check")).not.toContain("needs.changes.outputs.engine");
    expect(conditionFor("Command reference drift check")).not.toContain("needs.changes.outputs.engine");
  });
});
