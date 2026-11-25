export type ProcessOptions = {
    /** Working directory for the child; never changes the calling process's directory. */
    cwd?: string;
    /** Overrides merged into the current environment. Undefined removes a variable. */
    env?: NodeJS.ProcessEnv;
    /** Forward output (default) or discard it. Worker mode has no interactive stdin. */
    stdio?: "inherit" | "ignore";
    signal?: AbortSignal;
};
export type NodeOptions = ProcessOptions & {
    /** Run a script in a fresh worker instead of a child process. Requires the current cwd. */
    worker?: boolean;
};
/** A command started successfully but exited with a failure code or signal. */
export declare class ProcessError extends Error {
    readonly command: string;
    readonly exitCode: number | null;
    readonly signal: NodeJS.Signals | null;
    constructor(command: string, exitCode: number | null, signal?: NodeJS.Signals | null);
}
/** Run the current Node executable with literal arguments; rejects unsuccessful exits. */
export declare function node(args: readonly string[], options?: NodeOptions): Promise<void>;
/** Run npm's CLI using the current Node executable, without a shell wrapper. */
export declare function npm(args: readonly string[], options?: ProcessOptions): Promise<void>;
/** Run npx with its normal local-package, download, and prompt behavior. */
export declare function npx(args: readonly string[], options?: ProcessOptions): Promise<void>;
