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
export declare function loadMinerFileSecrets(env?: Record<string, string | undefined>, readFile?: (path: string) => string): void;
