import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  F1_COMPLEX_IDEA_EXAMPLE,
  F1_SIMPLE_IDEA_EXAMPLE,
} from "../../packages/gittensory-engine/src/idea-intake-bridge";
import { GittensoryMcp } from "../../src/mcp/server";
import { createTestEnv } from "../helpers/d1";

const bin = join(process.cwd(), "packages/gittensory-mcp/bin/gittensory-mcp.js");

async function connectHosted() {
  const server = new GittensoryMcp(createTestEnv()).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "gittensory-idea-intake-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

describe("gittensory_translate_idea_to_task_graph hosted MCP (#4798)", () => {
  it("translates F1 simple and complex worked examples", async () => {
    const client = await connectHosted();

    const simple = await client.callTool({
      name: "gittensory_translate_idea_to_task_graph",
      arguments: F1_SIMPLE_IDEA_EXAMPLE,
    });
    expect(simple.isError).toBeFalsy();
    expect(simple.structuredContent).toMatchObject({
      ok: true,
      taskGraph: {
        repoFullName: "acme/widgets",
        tasks: [{ id: "task-1" }],
      },
    });

    const complex = await client.callTool({
      name: "gittensory_translate_idea_to_task_graph",
      arguments: F1_COMPLEX_IDEA_EXAMPLE,
    });
    expect(complex.isError).toBeFalsy();
    const graph = complex.structuredContent as { ok: boolean; taskGraph?: { tasks: Array<{ id: string }> } };
    expect(graph.ok).toBe(true);
    expect(graph.taskGraph?.tasks.map((task) => task.id)).toEqual(["task-1", "task-2", "task-3"]);
  });

  it("returns a clear actionable error for malformed submissions", async () => {
    const client = await connectHosted();
    const result = await client.callTool({
      name: "gittensory_translate_idea_to_task_graph",
      arguments: { repoFullName: "acme/widgets", idea: "   " },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      errors: [{ code: "idea_required", field: "idea" }],
    });
  });
});

describe("gittensory_translate_idea_to_task_graph stdio MCP (#4798)", () => {
  let client: Client;
  let transport: StdioClientTransport;
  let configDir: string;

  beforeEach(async () => {
    configDir = mkdtempSync(join(tmpdir(), "gittensory-idea-intake-"));
    transport = new StdioClientTransport({
      command: "node",
      args: [bin, "--stdio"],
      env: { ...process.env, GITTENSORY_CONFIG_DIR: configDir },
    });
    client = new Client({ name: "idea-intake-stdio-test", version: "0.0.1" });
    await client.connect(transport);
  });

  afterEach(async () => {
    await client.close().catch(() => undefined);
    if (configDir) rmSync(configDir, { recursive: true, force: true });
  });

  it("registers the tool in the stdio server tool list", async () => {
    const { tools } = await client.listTools();
    expect(tools.some((tool) => tool.name === "gittensory_translate_idea_to_task_graph")).toBe(true);
  });

  it("translates a trivial idea without an API round-trip", async () => {
    const result = await client.callTool({
      name: "gittensory_translate_idea_to_task_graph",
      arguments: F1_SIMPLE_IDEA_EXAMPLE,
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ ok: true, taskGraph: { tasks: [{ id: "task-1" }] } });
  });
});
