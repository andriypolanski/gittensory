import type { ChatActionRegistry } from "./chat-action-registry.js";
export declare const GOVERNOR_PAUSE_CHAT_ACTION = "governor_pause";
export declare const GOVERNOR_RESUME_CHAT_ACTION = "governor_resume";
/** Optional `{ reason?: string }` — absent/empty params are valid; a non-string reason is rejected. */
export declare function isGovernorPauseChatParams(params: unknown): boolean;
/** Resume takes no arguments — only nullish or an empty object is valid. */
export declare function isGovernorResumeChatParams(params: unknown): boolean;
/** Idempotently register `governor_pause` / `governor_resume`. */
export declare function registerGovernorChatActions(options: {
    pauseGovernor: (reason?: string) => Promise<unknown>;
    resumeGovernor: () => Promise<unknown>;
    registry?: ChatActionRegistry;
    evaluateGate?: () => {
        decision: {
            stage: string;
        };
    };
}): void;
