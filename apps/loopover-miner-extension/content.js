const badgeApi = globalThis.__loopoverMinerOpportunityBadge;

const target = matchGitHubIssueTarget(location.pathname);

if (target?.kind === "issue") {
  mountOpportunityBadge(target);
}

function matchGitHubIssueTarget(pathname) {
  const match = String(pathname ?? "").match(/^\/([^/]+)\/([^/]+)\/issues\/(\d+)(?:\/|$)/);
  if (!match) return null;
  const [, owner, repo, number] = match;
  return { kind: "issue", owner, repo, issueNumber: Number(number) };
}

function mountOpportunityBadge(target) {
  if (document.querySelector("[data-loopover-miner-opportunity-badge]")) return;
  const host = findIssueSidebar();
  const container = document.createElement("aside");
  container.className = host
    ? "loopover-miner-opportunity-badge"
    : "loopover-miner-opportunity-badge loopover-miner-opportunity-badge--floating";
  container.dataset.loopoverMinerOpportunityBadge = "true";
  container.hidden = true;
  if (host) {
    host.prepend(container);
  } else {
    document.body.appendChild(container);
  }
  void loadOpportunityBadge(container, target);
}

function findIssueSidebar() {
  return (
    document.querySelector("#partial-discussion-sidebar") ||
    document.querySelector("[data-testid='issue-sidebar']") ||
    document.querySelector(".Layout-sidebar") ||
    document.querySelector(".discussion-sidebar")
  );
}

async function loadOpportunityBadge(container, target) {
  let response;
  try {
    response = await chrome.runtime.sendMessage({
      type: "loopover-miner:issue-context",
      owner: target.owner,
      repo: target.repo,
      issueNumber: target.issueNumber,
    });
  } catch {
    // sendMessage genuinely rejects under MV3 (service worker asleep/restarting, "Extension context
    // invalidated"). Clean up the same way every other failure path here does, instead of leaving an
    // unhandled rejection and a permanently-hidden orphan <aside> in the page.
    container.remove();
    return;
  }
  if (!response?.ok) {
    container.remove();
    return;
  }
  renderOpportunityBadge(container, response.payload);
}

function renderOpportunityBadge(container, payload, nowMs = Date.now()) {
  if (!payload?.watched || !payload?.badge) {
    container.remove();
    return;
  }
  const lastSyncedLabel = badgeApi?.formatLastSyncedLabel?.(payload.savedAt, nowMs) ?? null;
  const markup = badgeApi?.renderOpportunityBadgeMarkup?.(payload.badge, lastSyncedLabel);
  if (!markup) {
    container.remove();
    return;
  }
  container.hidden = false;
  container.innerHTML = markup;
}

if (globalThis.__LOOPOVER_MINER_EXTENSION_TEST__) {
  globalThis.__loopoverMinerContentInternals = {
    matchGitHubIssueTarget,
    findIssueSidebar,
    loadOpportunityBadge,
    renderOpportunityBadge,
  };
}
