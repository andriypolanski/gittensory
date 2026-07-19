import type { ChatActionRegistry, ChatActionRequest } from "./chat-action-registry.js";
/** Env var an operator sets to turn the chat-action dispatch layer on. */
export declare const CHAT_ACTION_DISPATCH_FLAG = "LOOPOVER_MINER_CHAT_ACTIONS";
/** The one and only value that enables dispatch. Anything else (unset, empty, "true", "1", ...) stays off. */
export declare const CHAT_ACTION_DISPATCH_ENABLE_VALUE = "enabled";
/**
 * Fail-closed config-flag gate: enabled only when the flag is set to exactly the enable value (trimmed).
 * Unset, empty, or any other value -- including truthy-looking ones like "true"/"1" -- reads as disabled.
 */
export declare function isChatActionDispatchEnabled(env?: Record<string, string | undefined>): boolean;
export type ChatActionDispatchResult = {
    ok: boolean;
    status: string;
    action: string | null;
    [key: string]: unknown;
};
/**
 * The single entry point every chat-issued action goes through. In order:
 *   1. Check the config flag FIRST -- before touching the registry or validating params. When disabled,
 *      return a clearly-typed `"disabled"` result and look up nothing.
 *   2. Reject an unknown (unregistered) action.
 *   3. Run the action's own registered params-validator; reject on failure without coercing or dropping
 *      fields (the caller's `params` is passed through unchanged).
 *   4. Invoke the registered (governor-gated) handler and return its result.
 */
export declare function dispatchChatAction(request: ChatActionRequest, options?: {
    env?: Record<string, string | undefined>;
    registry?: ChatActionRegistry;
}): Promise<ChatActionDispatchResult>;
