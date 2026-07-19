// Allowlist registry + governor-gated handler contract for chat-issued miner actions (#6519).
//
// Shared scaffolding ONLY: this module ships with ZERO registered actions. The three action-family child
// issues (portfolio release/requeue, governor pause/resume, discover/attempt) register their handlers into
// this registry -- none are added here, and the default `chatActionRegistry` instance starts empty.
//
// The registration contract is the safety boundary. `register` refuses any handler that was not produced by
// `governorGatedHandler()`, and `governorGatedHandler()` routes every invocation through
// `evaluateGovernorChokepointGate` (packages/loopover-miner/lib/governor-chokepoint.js) and, through it, the
// fail-closed precedence ladder in packages/loopover-engine/src/governor/chokepoint.ts. Because a raw
// function can never be registered, a chat action can never perform a write on a path that bypasses the
// Governor chokepoint -- the contract enforces it structurally, not by review discipline. This module adds
// no second, competing safety check; it only forces every registered handler onto the existing one.
import { evaluateGovernorChokepointGate } from "./governor-chokepoint.js";
// Private brand. Not exported, so external code cannot forge a "gated" marker onto a raw function: the only
// way to obtain a handler that passes `isGovernorGatedHandler` is to build it through `governorGatedHandler`.
const GOVERNOR_GATED = Symbol("loopover.chat-action.governor-gated");
/**
 * Wrap a local-write `run` function into a Governor-gated chat-action handler. The returned handler
 * evaluates the write against the full precedence ladder (via `evaluateGovernorChokepointGate`) BEFORE
 * running `run`, and only invokes `run` on a final `"allow"` verdict -- any other stage returns a gated
 * result and `run` never executes. This is the ONLY factory that produces a handler `register` accepts.
 */
export function governorGatedHandler(run, options = {}) {
    if (typeof run !== "function") {
        throw new TypeError("governorGatedHandler(run): run must be a function");
    }
    // Widen the default chokepoint evaluator to the registry's `unknown` input contract (chat requests carry
    // opaque governorInput); runtime still passes the same value through unchanged.
    const evaluateGate = options.evaluateGate ?? evaluateGovernorChokepointGate;
    if (typeof evaluateGate !== "function") {
        throw new TypeError("governorGatedHandler: options.evaluateGate must be a function when supplied");
    }
    const handler = (async (request) => {
        const gate = evaluateGate(request?.governorInput, options.gateOptions);
        if (gate?.decision?.stage !== "allow") {
            return { ok: false, status: "gated", decision: gate?.decision ?? null };
        }
        const result = await run(request, gate);
        return { ok: true, status: "executed", decision: gate.decision, result };
    });
    Object.defineProperty(handler, GOVERNOR_GATED, { value: true });
    return handler;
}
/** True only for a handler produced by {@link governorGatedHandler}. */
export function isGovernorGatedHandler(handler) {
    return typeof handler === "function" && handler[GOVERNOR_GATED] === true;
}
/**
 * Build an isolated chat-action registry. Child issues register into the shared {@link chatActionRegistry};
 * this factory exists so tests (and any future multi-registry consumer) can register without polluting it.
 */
export function createChatActionRegistry() {
    const actions = new Map();
    function register(name, definition = {}) {
        if (typeof name !== "string" || name.trim() === "") {
            throw new TypeError("registerChatAction(name): name must be a non-empty string");
        }
        if (actions.has(name)) {
            throw new Error(`registerChatAction: action "${name}" is already registered`);
        }
        const { paramsValidator, handler } = definition;
        if (typeof paramsValidator !== "function") {
            throw new TypeError(`registerChatAction("${name}"): paramsValidator must be a function`);
        }
        if (!isGovernorGatedHandler(handler)) {
            throw new Error(`registerChatAction("${name}"): handler must be produced by governorGatedHandler() so every ` +
                "chat-triggered write routes through governor-chokepoint.js -- a raw handler is rejected.");
        }
        const entry = { paramsValidator, handler };
        actions.set(name, entry);
        return entry;
    }
    return {
        register,
        get: (name) => actions.get(name),
        has: (name) => actions.has(name),
        names: () => [...actions.keys()],
        get size() {
            return actions.size;
        },
    };
}
/** The single shared registry the dispatch layer reads. Ships EMPTY (#6519); child issues register into it. */
export const chatActionRegistry = createChatActionRegistry();
/** Register a chat action on the shared {@link chatActionRegistry}. */
export function registerChatAction(name, definition) {
    return chatActionRegistry.register(name, definition);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2hhdC1hY3Rpb24tcmVnaXN0cnkuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJjaGF0LWFjdGlvbi1yZWdpc3RyeS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSw4RkFBOEY7QUFDOUYsRUFBRTtBQUNGLHlHQUF5RztBQUN6RywyR0FBMkc7QUFDM0csb0dBQW9HO0FBQ3BHLEVBQUU7QUFDRiw0R0FBNEc7QUFDNUcseUZBQXlGO0FBQ3pGLDZHQUE2RztBQUM3RyxzR0FBc0c7QUFDdEcsd0dBQXdHO0FBQ3hHLDJHQUEyRztBQUMzRyxvR0FBb0c7QUFFcEcsT0FBTyxFQUFFLDhCQUE4QixFQUFFLE1BQU0sMEJBQTBCLENBQUM7QUE2QjFFLDRHQUE0RztBQUM1Ryw4R0FBOEc7QUFDOUcsTUFBTSxjQUFjLEdBQUcsTUFBTSxDQUFDLHFDQUFxQyxDQUFDLENBQUM7QUFRckU7Ozs7O0dBS0c7QUFDSCxNQUFNLFVBQVUsb0JBQW9CLENBQ2xDLEdBQTJELEVBQzNELFVBR0ksRUFBRTtJQUVOLElBQUksT0FBTyxHQUFHLEtBQUssVUFBVSxFQUFFLENBQUM7UUFDOUIsTUFBTSxJQUFJLFNBQVMsQ0FBQyxtREFBbUQsQ0FBQyxDQUFDO0lBQzNFLENBQUM7SUFDRCx5R0FBeUc7SUFDekcsZ0ZBQWdGO0lBQ2hGLE1BQU0sWUFBWSxHQUNoQixPQUFPLENBQUMsWUFBWSxJQUFLLDhCQUFxRixDQUFDO0lBQ2pILElBQUksT0FBTyxZQUFZLEtBQUssVUFBVSxFQUFFLENBQUM7UUFDdkMsTUFBTSxJQUFJLFNBQVMsQ0FBQyw2RUFBNkUsQ0FBQyxDQUFDO0lBQ3JHLENBQUM7SUFFRCxNQUFNLE9BQU8sR0FBRyxDQUFDLEtBQUssRUFBRSxPQUEwQixFQUFvQyxFQUFFO1FBQ3RGLE1BQU0sSUFBSSxHQUFHLFlBQVksQ0FBQyxPQUFPLEVBQUUsYUFBYSxFQUFFLE9BQU8sQ0FBQyxXQUFXLENBQXlCLENBQUM7UUFDL0YsSUFBSSxJQUFJLEVBQUUsUUFBUSxFQUFFLEtB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