import type { Logger } from "./logger.mts";
export type TaskFunction = (this: TaskRunner) => Promise<void> | void;
/** A task executor. */
export type TaskExecutor = {
    (): Promise<void> | void;
    (this: TaskRunner): Promise<void> | void;
    displayName?: string;
};
export type ParallelOptions = {
    maxDop?: number;
};
type Truthy = boolean | string | number | object | null | undefined;
/** Runs named tasks sequentially or concurrently and records their performance. */
export declare class TaskRunner {
    /** Alias for SIP's shared logger. */
    get logger(): Logger;
    run: (taskFn: TaskExecutor) => Promise<void>;
    /** Wrap an executor with start/end logging. */
    task: (displayName: string, taskFn: TaskExecutor) => TaskExecutor;
    /** Execute tasks in order, stopping at the first failure. */
    series: (...taskFns: TaskExecutor[]) => TaskExecutor;
    /** Execute tasks concurrently. On failure, stop scheduling and drain active tasks before rejecting. */
    parallel: (...args: [ParallelOptions, ...TaskExecutor[]] | TaskExecutor[]) => TaskExecutor;
    /** Run tasks only when the condition resolves to true. */
    conditional: (condition: Truthy | (() => Truthy | Promise<Truthy>), taskFn: TaskExecutor) => TaskExecutor;
}
export {};
