// Portfolio release/requeue chat-action registrations (#6838).
//
// Child issue of the chat action-dispatch scaffolding (#6519). Registers `portfolio_release` /
// `portfolio_requeue` into a chat-action registry. Handlers MUST be wired to the miner-ui clients
// `releasePortfolioQueueItem` / `requeuePortfolioQueueItem` (apps/loopover-miner-ui/src/lib/
// portfolio-queue-actions.ts), so chat POSTs the SAME `/api/portfolio-queue/{release,requeue}` routes the
// dashboard's existing buttons already call — never portfolio-queue.js directly, and never a hand-rolled
// fetch. The miner-ui wire module passes those clients in; this module only owns the registration contract
// + params validators. That is what keeps chat from becoming a parallel write path (#6504's design).
//
// Release/requeue is local queue administration, not a chokepoint content-write: the route it lands on is a
// thin bridge to the same store methods the CLI's `queue release` / `queue requeue` already use
// (vite-portfolio-queue-actions-api.ts → reclaimStuckItem / requeueItem), and it invokes no chokepoint of its
// own. Requiring one only for the chat path would gate chat MORE strictly than the button beside it, which
// #6838 forbids ("No changes to the existing route or button-triggered flow"). So, exactly like
// chat-governor-actions.js's administrative pause/resume, we satisfy the registry's `governorGatedHandler`
// brand with an allow-stage evaluateGate rather than routing through governor-chokepoint.js. Execution still
// stays behind the shared LOOPOVER_MINER_CHAT_ACTIONS flag via `dispatchChatAction`.
import { governorGatedHandler, chatActionRegistry } from "./chat-action-registry.js";
export const PORTFOLIO_RELEASE_CHAT_ACTION = "portfolio_release";
export const PORTFOLIO_REQUEUE_CHAT_ACTION = "portfolio_requeue";
/** Local queue administration is not a chokepoint content-write (#6838); satisfy the registry brand only. */
const allowAdministrativeGate = () => ({ decision: { stage: "allow" } });
/**
 * Params for both actions: the queue item to act on. `repoFullName` + `identifier` are required non-empty
 * strings; `apiBaseUrl` is optional (the route defaults it, mirroring the client's own
 * `Pick<PortfolioQueueActionItem, "repoFullName" | "identifier" | "apiBaseUrl">` shape, where the buttons
 * always pass one but the CLI path does not). Unknown keys are rejected rather than ignored: a typo'd param
 * from a model-authored call must fail loudly, not silently act on the wrong item.
 */
export function isPortfolioItemChatParams(params) {
    if (params == null || typeof params !== "object" || Array.isArray(params))
        return false;
    const record = params;
    for (const key of Object.keys(record)) {
        if (key !== "repoFullName" && key !== "identifier" && key !== "apiBaseUrl")
            return false;
    }
    if (typeof record.repoFullName !== "string" || record.repoFullName.trim() === "")
        return false;
    if (typeof record.identifier !== "string" || record.identifier.trim() === "")
        return false;
    if (record.apiBaseUrl !== undefined && typeof record.apiBaseUrl !== "string")
        return false;
    return true;
}
/**
 * Narrow validated params to the client's item shape. `apiBaseUrl` is only forwarded when present, so an
 * omitted one stays omitted rather than becoming an explicit `undefined` in the POST body.
 */
function readPortfolioItem(params) {
    const record = params;
    const item = { repoFullName: record.repoFullName, identifier: record.identifier };
    return typeof record.apiBaseUrl === "string" ? { ...item, apiBaseUrl: record.apiBaseUrl } : item;
}
/** Idempotently register `portfolio_release` / `portfolio_requeue`. */
export function registerPortfolioChatActions(options) {
    const releaseItem = options?.releaseItem;
    const requeueItem = options?.requeueItem;
    if (typeof releaseItem !== "function") {
        throw new TypeError("registerPortfolioChatActions: releaseItem must be a function");
    }
    if (typeof requeueItem !== "function") {
        throw new TypeError("registerPortfolioChatActions: requeueItem must be a function");
    }
    const registry = options.registry ?? chatActionRegistry;
    const evaluateGate = options.evaluateGate ?? allowAdministrativeGate;
    if (!registry.has(PORTFOLIO_RELEASE_CHAT_ACTION)) {
        registry.register(PORTFOLIO_RELEASE_CHAT_ACTION, {
            paramsValidator: isPortfolioItemChatParams,
            handler: governorGatedHandler(async (request) => releaseItem(readPortfolioItem(request?.params)), {
                evaluateGate,
            }),
        });
    }
    if (!registry.has(PORTFOLIO_REQUEUE_CHAT_ACTION)) {
        registry.register(PORTFOLIO_REQUEUE_CHAT_ACTION, {
            paramsValidator: isPortfolioItemChatParams,
            handler: governorGatedHandler(async (request) => requeueItem(readPortfolioItem(request?.params)), {
                evaluateGate,
            }),
        });
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2hhdC1wb3J0Zm9saW8tYWN0aW9ucy5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImNoYXQtcG9ydGZvbGlvLWFjdGlvbnMudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsK0RBQStEO0FBQy9ELEVBQUU7QUFDRiwrRkFBK0Y7QUFDL0Ysa0dBQWtHO0FBQ2xHLDZGQUE2RjtBQUM3RiwwR0FBMEc7QUFDMUcseUdBQXlHO0FBQ3pHLDJHQUEyRztBQUMzRyxxR0FBcUc7QUFDckcsRUFBRTtBQUNGLDRHQUE0RztBQUM1RyxnR0FBZ0c7QUFDaEcsOEdBQThHO0FBQzlHLDJHQUEyRztBQUMzRyxnR0FBZ0c7QUFDaEcsMkdBQTJHO0FBQzNHLDZHQUE2RztBQUM3RyxxRkFBcUY7QUFFckYsT0FBTyxFQUFFLG9CQUFvQixFQUFFLGtCQUFrQixFQUFFLE1BQU0sMkJBQTJCLENBQUM7QUFHckYsTUFBTSxDQUFDLE1BQU0sNkJBQTZCLEdBQUcsbUJBQW1CLENBQUM7QUFDakUsTUFBTSxDQUFDLE1BQU0sNkJBQTZCLEdBQUcsbUJBQW1CLENBQUM7QUFRakUsNkdBQTZHO0FBQzdHLE1BQU0sdUJBQXVCLEdBQUcsR0FBRyxFQUFFLENBQUMsQ0FBQyxFQUFFLFFBQVEsRUFBRSxFQUFFLEtBQUssRUFBRSxPQUFPLEVBQUUsRUFBRSxDQUFDLENBQUM7QUFFekU7Ozs7OztHQU1HO0FBQ0gsTUFBTSxVQUFVLHlCQUF5QixDQUFDLE1BQWU7SUFDdkQsSUFBSSxNQUFNLElBQUksSUFBSSxJQUFJLE9BQU8sTUFBTSxLQUFLLFFBQVEsSUFBSSxLQUFLLENBQUMsT0FBTyxDQUFDLE1BQU0sQ0FBQztRQUFFLE9BQU8sS0FBSyxDQUFDO0lBQ3hGLE1BQU0sTUFBTSxHQUFHLE1BQWlDLENBQUM7SUFDakQsS0FBSyxNQUFNLEdBQUcsSUFBSSxNQUFNLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxFQUFFLENBQUM7UUFDdEMsSUFBSSxHQUFHLEtBQUssY0FBYyxJQUFJLEdBQUcsS0FBSyxZQUFZLElBQUksR0FBRyxLQUFLLFlBQVk7WUFBRSxPQUFPLEtBQUssQ0FBQztJQUMzRixDQUFDO0lBQ0QsSUFBSSxPQUFPLE1BQU0sQ0FBQyxZQUFZLEtBQUssUUFBUSxJQUFJLE1BQU0sQ0FBQyxZQUFZLENBQUMsSUFBSSxFQUFFLEtBQUssRUFBRTtRQUFFLE9BQU8sS0FBSyxDQUFDO0lBQy9GLElBQUksT0FBTyxNQUFNLENBQUMsVUFBVSxLQUFLLFFBQVEsSUFBSSxNQUFNLENBQUMsVUFBVSxDQUFDLElBQUksRUFBRSxLQUFLLEVBQUU7UUFBRSxPQUFPLEtBQUssQ0FBQztJQUMzRixJQUFJLE1BQU0sQ0FBQyxVQUFVLEtBQUssU0FBUyxJQUFJLE9BQU8sTUFBTSxDQUFDLFVBQVUsS0FBSyxRQUFRO1FBQUUsT0FBTyxLQUFLLENBQUM7SUFDM0YsT0FBTyxJQUFJLENBQUM7QUFDZCxDQUFDO0FBRUQ7OztHQUdHO0FBQ0gsU0FBUyxpQkFBaUIsQ0FBQyxNQUFlO0lBQ3hDLE1BQU0sTUFBTSxHQUFHLE1BQTRFLENBQUM7SUFDNUYsTUFBTSxJQUFJLEdBQUcsRUFBRSxZQUFZLEVBQUUsTUFBTSxDQUFDLFlBQVksRUFBRSxVQUFVLEVBQUUsTUFBTSxDQUFDLFVBQVUsRUFBRSxDQUFDO0lBQ2xGLE9BQU8sT0FBTyxNQUFNLENBQUMsVUFBVSxLQUFLLFFBQVEsQ0FBQyxDQUFDLENBQUMsRUFBRSxHQUFHLElBQUksRUFBRSxVQUFVLEVBQUUsTUFBTSxDQUFDLFVBQVUsRUFBRSxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUM7QUFDbkcsQ0FBQztBQUVELHVFQUF1RTtBQUN2RSxNQUFNLFVBQVUsNEJBQTRCLENBQUMsT0FLNUM7SUFDQyxNQUFNLFdBQVcsR0FBRyxPQUFPLEVBQUUsV0FBVyxDQUFDO0lBQ3pDLE1BQU0sV0FBVyxHQUFHLE9BQU8sRUFBRSxXQUFXLENBQUM7SUFDekMsSUFBSSxPQUFPLFdBQVcsS0FBSyxVQUFVLEVBQUUsQ0FBQztRQUN0QyxNQUFNLElBQUksU0FBUyxDQUFDLDhEQUE4RCxDQUFDLENBQUM7SUFDdEYsQ0FBQztJQUNELElBQUksT0FBTyxXQUFXLEtBQUssVUFBVSxFQUFFLENBQUM7UUFDdEMsTUFBTSxJQUFJLFNBQVMsQ0FBQyw4REFBOEQsQ0FBQyxDQUFDO0lBQ3RGLENBQUM7SUFFRCxNQUFNLFFBQVEsR0FBRyxPQUFPLENBQUMsUUFBUSxJQUFJLGtCQUFrQixDQUFDO0lBQ3hELE1BQU0sWUFBWSxHQUFHLE9BQU8sQ0FBQyxZQUFZLElBQUksdUJBQXVCLENBQUM7SUFFckUsSUFBSSxDQUFDLFFBQVEsQ0FBQyxHQUFHLENBQUMsNkJBQTZCLENBQUMsRUFBRSxDQUFDO1FBQ2pELFFBQVEsQ0FBQyxRQUFRLENBQUMsNkJBQTZCLEVBQUU7WUFDL0MsZUFBZSxFQUFFLHlCQUF5QjtZQUMxQyxPQUFPLEVBQUUsb0JBQW9CLENBQUMsS0FBSyxFQUFFLE9BQU8sRUFBRSxFQUFFLENBQUMsV0FBVyxDQUFDLGlCQUFpQixDQUFDLE9BQU8sRUFBRSxNQUFNLENBQUMsQ0FBQyxFQUFFO2dCQUNoRyxZQUFZO2FBQ2IsQ0FBQztTQUNILENBQUMsQ0FBQztJQUNMLENBQUM7SUFFRCxJQUFJLENBQUMsUUFBUSxDQUFDLEdBQUcsQ0FBQyw2QkFBNkIsQ0FBQyxFQUFFLENBQUM7UUFDakQsUUFBUSxDQUFDLFFBQVEsQ0FBQyw2QkFBNkIsRUFBRTtZQUMvQyxlQUFlLEVBQUUseUJBQXlCO1lBQzFDLE9BQU8sRUFBRSxvQkFBb0IsQ0FBQyxLQUFLLEVBQUUsT0FBTyxFQUFFLEVBQUUsQ0FBQyxXQUFXLENBQUMsaUJBQWlCLENBQUMsT0FBTyxFQUFFLE1BQU0sQ0FBQyxDQUFDLEVBQUU7Z0JBQ2hHLFlBQVk7YUFDYixDQUFDO1NBQ0gsQ0FBQyxDQUFDO0lBQ0wsQ0FBQztBQUNILENBQUMifQ==