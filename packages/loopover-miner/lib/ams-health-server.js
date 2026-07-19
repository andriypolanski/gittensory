import { createServer } from "node:http";
/** Bare liveness body: the process is up and answering, independent of any backend it depends on. */
export function buildHealthBody() {
    return { status: "ok" };
}
/**
 * Readiness: run every injected probe and report per-probe pass/fail plus how long each took. `ok` is true only
 * when every probe passed -- a container that can't reach a backend it depends on must stop reporting ready so
 * the fleet aggregator can route around it. A probe that throws counts as failed (never crashes readiness), and
 * its duration is still recorded. Mirrors src/selfhost/health.ts's `readiness`/`timedReadinessCheck` behavior.
 */
export async function readiness(probes = []) {
    const checks = {};
    const durationsMs = {};
    let ok = true;
    for (const probe of probes) {
        const startedAt = performance.now();
        let passed = false;
        try {
            passed = (await probe.check()) === true;
        }
        catch {
            passed = false;
        }
        finally {
            durationsMs[probe.name] = Math.max(0, performance.now() - startedAt);
        }
        checks[probe.name] = passed;
        if (!passed)
            ok = false;
    }
    return { ok, checks, durationsMs };
}
function sendJson(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(payload);
}
/**
 * Build the request handler for the AMS health surface: `GET /health` -> 200 liveness, `GET /ready` -> 200/503
 * readiness (503 when any probe fails, so a load balancer stops routing to a degraded container), anything else
 * -> 404. Exported separately from {@link startAmsHealthServer} so it can be exercised without binding a socket.
 */
export function createAmsHealthHandler(probes = []) {
    return async (req, res) => {
        const path = (req.url ?? "").split("?", 1)[0];
        if (req.method === "GET" && path === "/health") {
            sendJson(res, 200, buildHealthBody());
            return;
        }
        if (req.method === "GET" && path === "/ready") {
            const result = await readiness(probes);
            sendJson(res, result.ok ? 200 : 503, result);
            return;
        }
        sendJson(res, 404, { error: "not_found" });
    };
}
/**
 * Start the AMS health HTTP server. Resolves once it is listening. `port: 0` binds an ephemeral port (the caller
 * reads `server.address()`), which is what the tests use. The hosted-container entry point owns the lifecycle and
 * passes the AMS-specific probes (store reachable, loop cycle alive); the returned server is closed on shutdown.
 */
export function startAmsHealthServer(options = {}) {
    const port = Number.isInteger(options.port) ? options.port : 0;
    const host = typeof options.host === "string" && options.host ? options.host : "0.0.0.0";
    const probes = Array.isArray(options.probes) ? options.probes : [];
    const server = createServer(createAmsHealthHandler(probes));
    return new Promise((resolve) => {
        server.listen(port, host, () => resolve(server));
    });
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYW1zLWhlYWx0aC1zZXJ2ZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJhbXMtaGVhbHRoLXNlcnZlci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxPQUFPLEVBQUUsWUFBWSxFQUFlLE1BQU0sV0FBVyxDQUFDO0FBa0J0RCxxR0FBcUc7QUFDckcsTUFBTSxVQUFVLGVBQWU7SUFDN0IsT0FBTyxFQUFFLE1BQU0sRUFBRSxJQUFJLEVBQUUsQ0FBQztBQUMxQixDQUFDO0FBRUQ7Ozs7O0dBS0c7QUFDSCxNQUFNLENBQUMsS0FBSyxVQUFVLFNBQVMsQ0FBQyxTQUEyQixFQUFFO0lBQzNELE1BQU0sTUFBTSxHQUE0QixFQUFFLENBQUM7SUFDM0MsTUFBTSxXQUFXLEdBQTJCLEVBQUUsQ0FBQztJQUMvQyxJQUFJLEVBQUUsR0FBRyxJQUFJLENBQUM7SUFDZCxLQUFLLE1BQU0sS0FBSyxJQUFJLE1BQU0sRUFBRSxDQUFDO1FBQzNCLE1BQU0sU0FBUyxHQUFHLFdBQVcsQ0FBQyxHQUFHLEVBQUUsQ0FBQztRQUNwQyxJQUFJLE1BQU0sR0FBRyxLQUFLLENBQUM7UUFDbkIsSUFBSSxDQUFDO1lBQ0gsTUFBTSxHQUFHLENBQUMsTUFBTSxLQUFLLENBQUMsS0FBSyxFQUFFLENBQUMsS0FBSyxJQUFJLENBQUM7UUFDMUMsQ0FBQztRQUFDLE1BQU0sQ0FBQztZQUNQLE1BQU0sR0FBRyxLQUFLLENBQUM7UUFDakIsQ0FBQztnQkFBUyxDQUFDO1lBQ1QsV0FBVyxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsR0FBRyxJQUFJLENBQUMsR0FBRyxDQUFDLENBQUMsRUFBRSxXQUFXLENBQUMsR0FBRyxFQUFFLEdBQUcsU0FBUyxDQUFDLENBQUM7UUFDdkUsQ0FBQztRQUNELE1BQU0sQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLEdBQUcsTUFBTSxDQUFDO1FBQzVCLElBQUksQ0FBQyxNQUFNO1lBQUUsRUFBRSxHQUFHLEtBQUssQ0FBQztJQUMxQixDQUFDO0lB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