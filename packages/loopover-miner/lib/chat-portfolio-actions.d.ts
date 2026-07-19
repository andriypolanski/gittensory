import type { ChatActionRegistry } from "./chat-action-registry.js";
export declare const PORTFOLIO_RELEASE_CHAT_ACTION = "portfolio_release";
export declare const PORTFOLIO_REQUEUE_CHAT_ACTION = "portfolio_requeue";
export type PortfolioChatActionItem = {
    repoFullName: string;
    identifier: string;
    apiBaseUrl?: string;
};
/**
 * Params for both actions: the queue item to act on. `repoFullName` + `identifier` are required non-empty
 * strings; `apiBaseUrl` is optional (the route defaults it, mirroring the client's own
 * `Pick<PortfolioQueueActionItem, "repoFullName" | "identifier" | "apiBaseUrl">` shape, where the buttons
 * always pass one but the CLI path does not). Unknown keys are rejected rather than ignored: a typo'd param
 * from a model-authored call must fail loudly, not silently act on the wrong item.
 */
export declare function isPortfolioItemChatParams(params: unknown): boolean;
/** Idempotently register `portfolio_release` / `portfolio_requeue`. */
export declare function registerPortfolioChatActions(options: {
    releaseItem: (item: PortfolioChatActionItem) => Promise<unknown>;
    requeueItem: (item: PortfolioChatActionItem) => Promise<unknown>;
    registry?: ChatActionRegistry;
    evaluateGate?: () => {
        decision: {
            stage: string;
        };
    };
}): void;
