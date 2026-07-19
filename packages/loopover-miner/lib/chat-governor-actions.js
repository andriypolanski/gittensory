// Governor pause/resume chat-action registrations (#6521).
//
// Child issue of the chat action-dispatch scaffolding (#6519). Registers `governor_pause` /
// `governor_resume` into a chat-action registry. Handlers MUST be wired to the miner-ui clients
// `pauseGovernor` / `resumeGovernor` (apps/loopover-miner-ui/src/lib/governor.ts) — never to
// governor-state.js and never via a hand-rolled fetch. The miner-ui wire module passes those clients
// in; this module only owns the registration contract + params validators.
//
// Pause/resume is administrative control, not a chokepoint content-write. The registry still requires
// a `governorGatedHandler` brand, so we supply an allow-stage evaluateGate rather than routing through
// governor-chokepoint.js. Execution stays behind the shared LOOPOVER_MINER_CHAT_ACTIONS flag via
// `dispatchChatAction`.
import { governorGatedHandler, chatActionRegistry } from "./chat-action-registry.js";
export const GOVERNOR_PAUSE_CHAT_ACTION = "governor_pause";
export const GOVERNOR_RESUME_CHAT_ACTION = "governor_resume";
/** Administrative pause/resume is not a chokepoint content-write (#6521); satisfy the registry brand only. */
const allowAdministrativeGate = () => ({ decision: { stage: "allow" } });
/** Optional `{ reason?: string }` — absent/empty params are valid; a non-string reason is rejected. */
export function isGovernorPauseChatParams(params) {
    if (params == null)
        return true;
    if (typeof params !== "object" || Array.isArray(params))
        return false;
    const keys = Object.keys(params);
    if (keys.length === 0)
        return true;
    if (keys.length === 1 && keys[0] === "reason") {
        const reason = params.reason;
        return reason === undefined || typeof reason === "string";
    }
    return false;
}
/** Resume takes no arguments — only nullish or an empty object is valid. */
export function isGovernorResumeChatParams(params) {
    if (params == null)
        return true;
    if (typeof params !== "object" || Array.isArray(params))
        return false;
    return Object.keys(params).length === 0;
}
function readOptionalPauseReason(params) {
    if (params == null || typeof params !== "object" || Array.isArray(params))
        return undefined;
    const reason = params.reason;
    // Mirror LedgersPage: empty string → undefined so pauseGovernor omits the body field.
    return typeof reason === "string" && reason ? reason : undefined;
}
/** Idempotently register `governor_pause` / `governor_resume`. */
export function registerGovernorChatActions(options) {
    const pauseGovernor = options?.pauseGovernor;
    const resumeGovernor = options?.resumeGovernor;
    if (typeof pauseGovernor !== "function") {
        throw new TypeError("registerGovernorChatActions: pauseGovernor must be a function");
    }
    if (typeof resumeGovernor !== "function") {
        throw new TypeError("registerGovernorChatActions: resumeGovernor must be a function");
    }
    const registry = options.registry ?? chatActionRegistry;
    const evaluateGate = options.evaluateGate ?? allowAdministrativeGate;
    if (!registry.has(GOVERNOR_PAUSE_CHAT_ACTION)) {
        registry.register(GOVERNOR_PAUSE_CHAT_ACTION, {
            paramsValidator: isGovernorPauseChatParams,
            handler: governorGatedHandler(async (request) => pauseGovernor(readOptionalPauseReason(request?.params)), {
                evaluateGate,
            }),
        });
    }
    if (!registry.has(GOVERNOR_RESUME_CHAT_ACTION)) {
        registry.register(GOVERNOR_RESUME_CHAT_ACTION, {
            paramsValidator: isGovernorResumeChatParams,
            handler: governorGatedHandler(async () => resumeGovernor(), { evaluateGate }),
        });
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2hhdC1nb3Zlcm5vci1hY3Rpb25zLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiY2hhdC1nb3Zlcm5vci1hY3Rpb25zLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLDJEQUEyRDtBQUMzRCxFQUFFO0FBQ0YsNEZBQTRGO0FBQzVGLGdHQUFnRztBQUNoRyw2RkFBNkY7QUFDN0YscUdBQXFHO0FBQ3JHLDJFQUEyRTtBQUMzRSxFQUFFO0FBQ0Ysc0dBQXNHO0FBQ3RHLHVHQUF1RztBQUN2RyxpR0FBaUc7QUFDakcsd0JBQXdCO0FBRXhCLE9BQU8sRUFBRSxvQkFBb0IsRUFBRSxrQkFBa0IsRUFBRSxNQUFNLDJCQUEyQixDQUFDO0FBR3JGLE1BQU0sQ0FBQyxNQUFNLDBCQUEwQixHQUFHLGdCQUFnQixDQUFDO0FBQzNELE1BQU0sQ0FBQyxNQUFNLDJCQUEyQixHQUFHLGlCQUFpQixDQUFDO0FBRTdELDhHQUE4RztBQUM5RyxNQUFNLHVCQUF1QixHQUFHLEdBQUcsRUFBRSxDQUFDLENBQUMsRUFBRSxRQUFRLEVBQUUsRUFBRSxLQUFLLEVBQUUsT0FBTyxFQUFFLEVBQUUsQ0FBQyxDQUFDO0FBRXpFLHVHQUF1RztBQUN2RyxNQUFNLFVBQVUseUJBQXlCLENBQUMsTUFBZTtJQUN2RCxJQUFJLE1BQU0sSUFBSSxJQUFJO1FBQUUsT0FBTyxJQUFJLENBQUM7SUFDaEMsSUFBSSxPQUFPLE1BQU0sS0FBSyxRQUFRLElBQUksS0FBSyxDQUFDLE9BQU8sQ0FBQyxNQUFNLENBQUM7UUFBRSxPQUFPLEtBQUssQ0FBQztJQUN0RSxNQUFNLElBQUksR0FBRyxNQUFNLENBQUMsSUFBSSxDQUFDLE1BQWdCLENBQUMsQ0FBQztJQUMzQyxJQUFJLElBQUksQ0FBQyxNQUFNLEtBQUssQ0FBQztRQUFFLE9BQU8sSUFBSSxDQUFDO0lBQ25DLElBQUksSUFBSSxDQUFDLE1BQU0sS0FBSyxDQUFDLElBQUksSUFBSSxDQUFDLENBQUMsQ0FBQyxLQUFLLFFBQVEsRUFBRSxD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