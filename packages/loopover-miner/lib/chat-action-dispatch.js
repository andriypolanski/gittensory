// Chat action-dispatch chokepoint (#6519).
//
// SINGLE ENTRY POINT, NEVER BYPASS: every action a miner-chat message issues MUST go through
// `dispatchChatAction` here -- never a parallel or direct call into a registered handler, an HTTP endpoint,
// or a local-write tool. This function is the one place the config flag is checked and the one place a
// registered handler is looked up and invoked. It adds NO second safety check of its own: the real
// fail-closed enforcement lives in packages/loopover-engine/src/governor/chokepoint.ts (the precedence
// ladder) reached through the packages/loopover-miner/lib/governor-chokepoint.js stateful wrapper, which the
// registry's `governorGatedHandler` contract forces every registered handler through. Dispatch only gates on
// the flag, rejects unknown actions, and runs the registered params-validator before invoking the handler.
//
// Disabled by default: the flag fails closed (off unless explicitly enabled), and the shared registry
// (chat-action-registry.js) ships empty, so no action can execute until a child issue registers a handler
// AND an operator flips the flag on.
import { chatActionRegistry } from "./chat-action-registry.js";
/** Env var an operator sets to turn the chat-action dispatch layer on. */
export const CHAT_ACTION_DISPATCH_FLAG = "LOOPOVER_MINER_CHAT_ACTIONS";
/** The one and only value that enables dispatch. Anything else (unset, empty, "true", "1", ...) stays off. */
export const CHAT_ACTION_DISPATCH_ENABLE_VALUE = "enabled";
/**
 * Fail-closed config-flag gate: enabled only when the flag is set to exactly the enable value (trimmed).
 * Unset, empty, or any other value -- including truthy-looking ones like "true"/"1" -- reads as disabled.
 */
export function isChatActionDispatchEnabled(env = process.env) {
    const raw = env?.[CHAT_ACTION_DISPATCH_FLAG];
    return typeof raw === "string" && raw.trim() === CHAT_ACTION_DISPATCH_ENABLE_VALUE;
}
/**
 * The single entry point every chat-issued action goes through. In order:
 *   1. Check the config flag FIRST -- before touching the registry or validating params. When disabled,
 *      return a clearly-typed `"disabled"` result and look up nothing.
 *   2. Reject an unknown (unregistered) action.
 *   3. Run the action's own registered params-validator; reject on failure without coercing or dropping
 *      fields (the caller's `params` is passed through unchanged).
 *   4. Invoke the registered (governor-gated) handler and return its result.
 */
export async function dispatchChatAction(request, options = {}) {
    const env = options.env ?? process.env;
    // Flag first -- before touching the registry or validating params. Fail closed.
    if (!isChatActionDispatchEnabled(env)) {
        return { ok: false, status: "disabled", action: readAction(request) };
    }
    const registry = options.registry ?? chatActionRegistry;
    const action = readAction(request);
    if (action === null || !registry.has(action)) {
        return { ok: false, status: "unknown_action", action };
    }
    const registered = registry.get(action);
    let valid;
    try {
        valid = registered.paramsValidator(request?.params) === true;
    }
    catch (error) {
        // A validator that throws is treated as a rejection (fail closed), not as a dispatch error.
        return { ok: false, status: "invalid_params", action, error: error instanceof Error ? error.message : String(error) };
    }
    if (!valid) {
        return { ok: false, status: "invalid_params", action };
    }
    let result;
    try {
        result = await registered.handler(request);
    }
    catch {
        // A handler that throws fails closed with the module's typed result shape (#6989), consistent with the
        // paramsValidator catch above. The thrown value is deliberately NOT echoed back: a handler wraps
        // arbitrary action work (e.g. a network call), so its error could carry external detail -- the sibling
        // fail-closed paths (sentry.js, pretooluse-hook.js) likewise swallow rather than surface it. A distinct
        // "handler_error" status still lets a caller tell an execution failure from a params-validation failure.
        return { ok: false, status: "handler_error", action };
    }
    return { ok: true, status: "dispatched", action, result };
}
/** The requested action name, or null when the request omits a string action. */
function readAction(request) {
    return request && typeof request.action === "string" ? request.action : null;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2hhdC1hY3Rpb24tZGlzcGF0Y2guanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJjaGF0LWFjdGlvbi1kaXNwYXRjaC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSwyQ0FBMkM7QUFDM0MsRUFBRTtBQUNGLDZGQUE2RjtBQUM3Riw0R0FBNEc7QUFDNUcsdUdBQXVHO0FBQ3ZHLG1HQUFtRztBQUNuRyx1R0FBdUc7QUFDdkcsNkdBQTZHO0FBQzdHLDZHQUE2RztBQUM3RywyR0FBMkc7QUFDM0csRUFBRTtBQUNGLHNHQUFzRztBQUN0RywwR0FBMEc7QUFDMUcscUNBQXFDO0FBRXJDLE9BQU8sRUFBRSxrQkFBa0IsRUFBRSxNQUFNLDJCQUEyQixDQUFDO0FBRy9ELDBFQUEwRTtBQUMxRSxNQUFNLENBQUMsTUFBTSx5QkFBeUIsR0FBRyw2QkFBNkIsQ0FBQztBQUN2RSw4R0FBOEc7QUFDOUcsTUFBTSxDQUFDLE1BQU0saUNBQWlDLEdBQUcsU0FBUyxDQUFDO0FBRTNEOzs7R0FHRztBQUNILE1BQU0sVUFBVSwyQkFBMkIsQ0FBQyxNQUEwQyxPQUFPLENBQUMsR0FBRztJQUMvRixNQUFNLEdBQUcsR0FBRyxHQUFHLEVBQUUsQ0FBQyx5QkFBeUIsQ0FBQyxDQUFDO0lBQzdDLE9BQU8sT0FBTyxHQUFHLEtBQUssUUFBUSxJQUFJLEdBQUcsQ0FBQyxJQUFJLEVBQUUsS0FBSyxpQ0FBaUMsQ0FBQztBQUNyRixDQUFDO0FBU0Q7Ozs7Ozs7O0dBUUc7QUFDSCxNQUFNLENBQUMsS0FBSyxVQUFVLGtCQUFrQixDQUN0QyxPQUEwQixFQUMxQixVQUdJLEVBQUU7SUFFTixNQUFNLEdBQUcsR0FBRyxPQUFPLENBQUMsR0FBRyxJQUFJLE9BQU8sQ0FBQyxHQUFHLENBQUM7SUFFdkMsZ0ZBQWdGO0lBQ2hGLElBQUksQ0FBQywyQkFBMkIsQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDO1FBQ3RDLE9BQU8sRUFBRSxFQUFFLEVBQUUsS0FBSyxFQUFFLE1BQU0sRUFBRSxVQUFVLEVBQUUsTUFBTSxFQUFFLFVBQVUsQ0FBQyxPQUFPLENBQUMsRUFBRSxDQUFDO0lBQ3hFLENBQUM7SUFFRCxNQUFNLFFBQVEsR0FBRyxPQUFPLENBQUMsUUFBUSxJQUFJLGtCQUFrQixDQUFDO0lBQ3hELE1BQU0sTUFBTSxHQUFHLFVBQVUsQ0FBQyxPQUFPLENBQUMsQ0FBQztJQUNuQyxJQUFJLE1BQU0sS0FBSyxJQUFJLElBQUksQ0FBQyxRQUFRLENBQUMsR0FBRyxDQUFDLE1BQU0sQ0FBQyxFQUFFLENBQUM7UUFDN0MsT0FBTyxFQUFFLEVBQUUsRUFBRSxLQUFLLEVBQUUsTUFBTSxFQUFFLGdCQUFnQixFQUFFLE1BQU0sRUFBRSxDQUFDO0lBQ3pELENBQUM7SUFFRCxNQUFNLFVBQVUsR0FBRyxRQUFRLENBQUMsR0FBRyxDQUFDLE1BQU0sQ0FBRSxDQUFDO0lBQ3pDLElBQUksS0FBSyxDQUFDO0lBQ1YsSUFBSSxDQUFDO1FBQ0gsS0FBSyxHQUFHLFVBQVUsQ0FBQyxlQUFlLENBQUMsT0FBTyxFQUFFLE1BQU0sQ0FBQyxLQUFLLElBQUksQ0FBQztJQUMvRCxDQUFDO0lBQUMsT0FBTyxLQUFLLEVBQUUsQ0FBQztRQUNmLDRGQUE0RjtRQUM1RixPQUFPLEVBQUUsRUFBRSxFQUFFLEtBQUssRUFBRSxNQUFNLEVBQUUsZ0JBQWdCLEVBQUUsTUFBTSxFQUFFLEtBQUssRUFBRSxLQUFLLFlBQVksS0FBSyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUFDLEVBQUUsQ0FBQztJQUN4SCxDQUFDO0lBQ0QsSUFBSSxDQUFDLEtBQUssRUFBRSxDQUFDO1FBQ1gsT0FBTyxFQUFFLEVBQUUsRUFBRSxLQUFLLEVBQUUsTUFBTSxFQUFFLGdCQUFnQixFQUFFLE1BQU0sRUFBRSxDQUFDO0lBQ3pELENBQUM7SUFFRCxJQUFJLE1BQU0sQ0FBQztJQUNYLElBQUksQ0FBQztRQUNILE1BQU0sR0FBRyxNQUFNLFVBQVUsQ0FBQyxPQUFPLENBQUMsT0FBTyxDQUFDLENBQUM7SUFDN0MsQ0FBQztJQUFDLE1BQU0sQ0FBQztRQUNQLHVHQUF1RztRQUN2RyxpR0FBaUc7UUFDakcsdUdBQXVHO1FBQ3ZHLHdHQUF3RztRQUN4Ryx5R0FBeUc7UUFDekcsT0FBTyxFQUFFLEVBQUUsRUFBRSxLQUFLLEVBQUUsTUFBTSxFQUFFLGVBQWUsRUFBRSxNQUFNLEVBQUUsQ0FBQztJQUN4RCxDQUFDO0lBQ0QsT0FBTyxFQUFFLEVBQUUsRUFBRSxJQUFJLEVBQUUsTUFBTSxFQUFFLFlBQVksRUFBRSxNQUFNLEVBQUUsTUFBTSxFQUFFLENBQUM7QUFDNUQsQ0FBQztBQUVELGlGQUFpRjtBQUNqRixTQUFTLFVBQVUsQ0FBQyxPQUEwQjtJQUM1QyxPQUFPLE9BQU8sSUFBSSxPQUFPLE9BQU8sQ0FBQyxNQUFNLEtBQUssUUFBUSxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUM7QUFDL0UsQ0FBQyJ9