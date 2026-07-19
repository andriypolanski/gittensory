import { type Server } from "node:http";
export type ReadinessProbe = {
    name: string;
    check: () => Promise<boolean>;
};
export type Readiness = {
    ok: boolean;
    checks: Record<string, boolean>;
    durationsMs: Record<string, number>;
};
/** Bare liveness body: the process is up and answering, independent of any backend it depends on. */
export declare function buildHealthBody(): {
    status: "ok";
};
/**
 * Readiness: run every injected probe and report per-probe pass/fail plus how long each took. `ok` is true only
 * when every probe passed -- a container that can't reach a backend it depends on must stop reporting ready so
 * the fleet aggregator can route around it. A probe that throws counts as failed (never crashes readiness), and
 * its duration is still recorded. Mirrors src/selfhost/health.ts's `readiness`/`timedReadinessCheck` behavior.
 */
export declare function readiness(probes?: ReadinessProbe[]): Promise<Readiness>;
/**
 * Build the request handler for the AMS health surface: `GET /health` -> 200 liveness, `GET /ready` -> 200/503
 * readiness (503 when any probe fails, so a load balancer stops routing to a degraded container), anything else
 * -> 404. Exported separately from {@link startAmsHealthServer} so it can be exercised without binding a socket.
 */
export declare function createAmsHealthHandler(probes?: ReadinessProbe[]): (req: {
    method?: string | undefined;
    url?: string | undefined;
}, res: {
    writeHead: (status: number, headers: Record<string, string>) => void;
    end: (body: string) => void;
}) => Promise<void>;
/**
 * Start the AMS health HTTP server. Resolves once it is listening. `port: 0` binds an ephemeral port (the caller
 * reads `server.address()`), which is what the tests use. The hosted-container entry point owns the lifecycle and
 * passes the AMS-specific probes (store reachable, loop cycle alive); the returned server is closed on shutdown.
 */
export declare function startAmsHealthServer(options?: {
    port?: number;
    host?: string;
    probes?: ReadinessProbe[];
}): Promise<Server>;
