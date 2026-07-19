// Resolve `<NAME>_FILE` env vars (Docker/Swarm/K8s secret mounts) into `<NAME>` at miner startup (#5178).
// Ports src/selfhost/load-file-secrets.ts's pattern into the miner package -- the miner is a separate
// deployable (its own process/container per DEPLOYMENT.md's fleet mode), so it never runs through ORB's own
// server-startup resolver. Deliberately diverges from that analogue in one way: an unreadable/missing
// `<NAME>_FILE` here THROWS rather than logging and continuing, so a broken secret mount fails a miner
// container fast and loud (never silently proceeds with an unset/empty credential the next real GitHub call
// would then fail on anyway, with a far less specific error).
import { readFileSync } from "node:fs";
// Docker Compose's OWN reserved `_FILE`-suffixed environment variables -- never loopover's secret-file
// convention, so they must never be dereferenced below (mirrors src/selfhost/load-file-secrets.ts's own
// exclusion and rationale: `COMPOSE_FILE` is a colon-delimited list of compose file paths, never a single
// readable file itself, and `COMPOSE_ENV_FILE` points at an operator's own .env file, not a secret).
const COMPOSE_RESERVED_FILE_VARS = new Set(["COMPOSE_FILE", "COMPOSE_ENV_FILE"]);
/**
 * Scan `env` for `<NAME>_FILE` vars and resolve each into `<NAME>` in place, reading the referenced file's
 * contents (trimmed). An explicit `<NAME>` value always wins over `<NAME>_FILE` (mirrors the ORB analogue's
 * precedence rule exactly) -- a `_FILE` var is only consulted when its plain counterpart is unset. Throws a
 * clear, actionable error identifying the offending `<NAME>_FILE` var and its file path when the file is
 * missing or unreadable -- this never silently leaves a credential empty/undefined. Never logs or returns any
 * resolved secret value itself; only the (non-secret) var name and file path ever appear in a thrown message.
 *
 * `env` and `readFile` are injectable purely for testability -- every real caller uses the defaults
 * (`process.env`, `node:fs`'s `readFileSync`), so this is byte-identical to a hardcoded version at runtime.
 */
export function loadMinerFileSecrets(env = process.env, readFile = (path) => readFileSync(path, "utf8")) {
    for (const key of Object.keys(env)) {
        if (!key.endsWith("_FILE") || !env[key] || COMPOSE_RESERVED_FILE_VARS.has(key))
            continue;
        const target = key.slice(0, -"_FILE".length);
        if (env[target])
            continue; // an explicit <NAME> value always wins over <NAME>_FILE
        try {
            env[target] = readFile(env[key]).trim();
        }
        catch (error) {
            throw new Error(`Failed to read secret file for ${key} (${env[key]}): ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZW52LWZpbGUtaW5kaXJlY3Rpb24uanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJlbnYtZmlsZS1pbmRpcmVjdGlvbi50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSwwR0FBMEc7QUFDMUcsc0dBQXNHO0FBQ3RHLDRHQUE0RztBQUM1RyxzR0FBc0c7QUFDdEcsdUdBQXVHO0FBQ3ZHLDRHQUE0RztBQUM1Ryw4REFBOEQ7QUFDOUQsT0FBTyxFQUFFLFlBQVksRUFBRSxNQUFNLFNBQVMsQ0FBQztBQUV2Qyx1R0FBdUc7QUFDdkcsd0dBQXdHO0FBQ3hHLDBHQUEwRztBQUMxRyxxR0FBcUc7QUFDckcsTUFBTSwwQkFBMEIsR0FBRyxJQUFJLEdBQUcsQ0FBQyxDQUFDLGNBQWMsRUFBRSxrQkFBa0IsQ0FBQyxDQUFDLENBQUM7QUFFakY7Ozs7Ozs7Ozs7R0FVRztBQUNILE1BQU0sVUFBVSxvQkFBb0IsQ0FDbEMsTUFBMEMsT0FBTyxDQUFDLEdBQUcsRUFDckQsV0FBcUMsQ0FBQyxJQUFJLEVBQUUsRUFBRSxDQUFDLFlBQVksQ0FBQyxJQUFJLEVBQUUsTUFBTSxDQUFDO0lBRXpFLEtBQUssTUFBTSxHQUFHLElBQUksTUFBTSxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDO1FBQ25DLElBQUksQ0FBQyxHQUFHLENBQUMsUUFBUSxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxJQUFJLDBCQUEwQixDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUM7WUFBRSxTQUFTO1FBQ3pGLE1BQU0sTUFBTSxHQUFHLEdBQUcsQ0FBQyxLQUFLLENBQUMsQ0FBQyxFQUFFLENBQUMsT0FBTyxDQUFDLE1BQU0sQ0FBQyxDQUFDO1FBQzdDLElBQUksR0FBRyxDQUFDLE1BQU0sQ0FBQztZQUFFLFNBQVMsQ0FBQyx3REFBd0Q7UUFDbkYsSUFBSSxDQUFDO1lBQ0gsR0FBRyxDQUFDLE1BQU0sQ0FBQyxHQUFHLFFBQVEsQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxJQUFJLEVBQUUsQ0FBQztRQUMxQyxDQUFDO1FBQUMsT0FBTyxLQUFLLEVBQUUsQ0FBQztZQUNmLE1BQU0sSUFBSSxLQUFLLENBQ2Isa0NBQWtDLEdBQUcsS0FBSyxHQUFHLENBQUMsR0FBRyxDQUFDLE1BQ2hELEtBQUssWUFBWSxLQUFLLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQ3ZELEVBQUUsQ0FDSCxDQUFDO1FBQ0osQ0FBQztJQUNILENBQUM7QUFDSCxDQUFDIn0=