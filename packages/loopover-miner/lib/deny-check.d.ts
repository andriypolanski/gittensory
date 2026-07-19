export type ParsedDenyCheckArgs = {
    tool: string;
    input: Record<string, unknown>;
    json: boolean;
} | {
    error: string;
};
export declare function parseDenyCheckArgs(args: string[]): ParsedDenyCheckArgs;
export declare function runDenyCheck(args: string[]): number;
