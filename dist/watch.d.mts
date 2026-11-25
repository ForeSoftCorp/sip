import type { GlobPattern } from "./utils.mts";
import type { TaskExecutor, TaskFunction } from "./runner.mts";
export type WatchSpec = {
    src: GlobPattern;
    cwd?: string;
    run: TaskExecutor;
};
export type WatchAddress = {
    /** Watch group name, scoped to cwd and the current user. Defaults to "default". */
    id?: string;
    /** Project directory used to identify the watcher. Defaults to process.cwd(). */
    cwd?: string;
};
export type WatchOptions = WatchAddress & {
    /** Milliseconds between glob scans. Defaults to 250. */
    interval?: number;
    /** Stop watching gracefully when aborted. Active executors are allowed to finish. */
    signal?: AbortSignal;
};
/**
 * Create a long-running task that polls glob matches for additions, edits, and removals.
 * Executors run sequentially through the calling runner, only after changes. A failure
 * rejects the watch task and releases its resources. Use stopWatch() from another process
 * or abort options.signal to stop gracefully; cancellation does not interrupt executors.
 */
export declare function watch(specs: WatchSpec[], options?: WatchOptions): TaskFunction;
/** Request graceful cancellation from this or another process. An absent watcher is a no-op.
 * Resolves once the request is acknowledged; an active executor may still be finishing.
 */
export declare function stopWatch(options?: WatchAddress): Promise<void>;
