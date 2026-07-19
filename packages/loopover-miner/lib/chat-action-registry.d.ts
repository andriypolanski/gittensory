export type ChatActionRequest = {
    action?: string;
    params?: unknown;
    governorInput?: unknown;
};
/** A handler produced by {@link governorGatedHandler}; the only shape {@link ChatActionRegistry.register} accepts. */
export type GovernorGatedHandler = (request: ChatActionRequest) => Promise<Record<string, unknown>>;
export type ChatActionDefinition = {
    paramsValidator: (params: unknown) => boolean;
    handler: GovernorGatedHandler;
};
export type ChatActionEntry = {
    paramsValidator: (params: unknown) => boolean;
    handler: GovernorGatedHandler;
};
export type ChatActionRegistry = {
    register(name: string, definition: ChatActionDefinition): ChatActionEntry;
    get(name: string): ChatActionEntry | undefined;
    has(name: string): boolean;
    names(): string[];
    readonly size: number;
};
/**
 * Wrap a local-write `run` function into a Governor-gated chat-action handler. The returned handler
 * evaluates the write against the full precedence ladder (via `evaluateGovernorChokepointGate`) BEFORE
 * running `run`, and only invokes `run` on a final `"allow"` verdict -- any other stage returns a gated
 * result and `run` never executes. This is the ONLY factory that produces a handler `register` accepts.
 */
export declare function governorGatedHandler(run: (request: ChatActionRequest, gate: unknown) => unknown, options?: {
    evaluateGate?: (input: unknown, gateOptions?: unknown) => unknown;
    gateOptions?: unknown;
}): GovernorGatedHandler;
/** True only for a handler produced by {@link governorGatedHandler}. */
export declare function isGovernorGatedHandler(handler: unknown): boolean;
/**
 * Build an isolated chat-action registry. Child issues register into the shared {@link chatActionRegistry};
 * this factory exists so tests (and any future multi-registry consumer) can register without polluting it.
 */
export declare function createChatActionRegistry(): ChatActionRegistry;
/** The single shared registry the dispatch layer reads. Ships EMPTY (#6519); child issues register into it. */
export declare const chatActionRegistry: ChatActionRegistry;
/** Register a chat action on the shared {@link chatActionRegistry}. */
export declare function registerChatAction(name: string, definition: ChatActionDefinition): ChatActionEntry;
