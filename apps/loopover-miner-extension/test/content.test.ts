import { afterEach, describe, expect, it, vi } from "vitest";

type BadgeContainer = { remove: () => void; hidden?: boolean; innerHTML?: string };
type ContentInternals = {
  loadOpportunityBadge: (container: BadgeContainer, target: unknown) => Promise<void>;
};

const TARGET = { owner: "JSONbored", repo: "loopover", issueNumber: 145 };

// content.js mounts the badge at import time only when location.pathname is a GitHub issue URL, so importing it
// on a non-issue path loads the module without any DOM side effects. That keeps this focused on the
// sendMessage failure path and needs none of the jsdom mount harness the README defers.
async function loadContentInternals(sendMessage: () => Promise<unknown>): Promise<ContentInternals> {
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.stubGlobal("location", { pathname: "/" });
  vi.stubGlobal("chrome", { runtime: { sendMessage } });
  vi.stubGlobal("__LOOPOVER_MINER_EXTENSION_TEST__", true);
  await import("../content.js");
  return globalThis.__loopoverMinerContentInternals as ContentInternals;
}

describe("content.js loadOpportunityBadge (#6189)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("removes the badge container when sendMessage rejects, rather than rejecting itself", async () => {
    // The real MV3 failure: the service worker is asleep/restarting, or the context was invalidated.
    const sendMessage = vi.fn().mockRejectedValue(new Error("Extension context invalidated"));
    const { loadOpportunityBadge } = await loadContentInternals(sendMessage);
    const container: BadgeContainer = { remove: vi.fn() };

    // Must settle, not reject: mountOpportunityBadge calls this as a floating `void` promise, so a rejection
    // here surfaces as an unhandled rejection in the page.
    await expect(loadOpportunityBadge(container, TARGET)).resolves.toBeUndefined();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(container.remove).toHaveBeenCalledTimes(1);
  });

  it("still removes the container on a not-ok response, the pre-existing failure path", async () => {
    const sendMessage = vi.fn().mockResolvedValue({ ok: false, error: "nope" });
    const { loadOpportunityBadge } = await loadContentInternals(sendMessage);
    const container: BadgeContainer = { remove: vi.fn() };

    await expect(loadOpportunityBadge(container, TARGET)).resolves.toBeUndefined();
    expect(container.remove).toHaveBeenCalledTimes(1);
  });

  it("does not remove the container when the message resolves ok", async () => {
    // payload is unwatched, so renderOpportunityBadge's own guard owns the cleanup decision -- this asserts the
    // new catch does not swallow a success into a removal.
    const sendMessage = vi.fn().mockResolvedValue({ ok: true, payload: { watched: true, badge: null } });
    const { loadOpportunityBadge } = await loadContentInternals(sendMessage);
    const container: BadgeContainer = { remove: vi.fn() };

    await expect(loadOpportunityBadge(container, TARGET)).resolves.toBeUndefined();
    expect(sendMessage).toHaveBeenCalledWith({
      type: "loopover-miner:issue-context",
      owner: TARGET.owner,
      repo: TARGET.repo,
      issueNumber: TARGET.issueNumber,
    });
  });
});
