import assert from "node:assert/strict";
import { test } from "node:test";

import {
  F1_SIMPLE_IDEA_EXAMPLE,
  translateIdeaToTaskGraph,
  validateIdeaSubmission,
} from "../dist/index.js";

test("barrel: the public entrypoint re-exports idea-intake bridge (#4798)", () => {
  assert.equal(typeof translateIdeaToTaskGraph, "function");
  assert.equal(typeof validateIdeaSubmission, "function");
});

test("translateIdeaToTaskGraph: F1 simple example produces a valid task graph", () => {
  const result = translateIdeaToTaskGraph(F1_SIMPLE_IDEA_EXAMPLE);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.taskGraph.tasks.length, 1);
  assert.equal(result.taskGraph.repoFullName, "acme/widgets");
});
