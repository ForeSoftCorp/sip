import type { GlobPattern, Destination } from "./utils.mts";
import type { TaskFunction, TaskRunner } from "./runner.mts";
export type MakeSpec = {
    src: GlobPattern;
    dest: Destination;
    deps?: GlobPattern;
    cwd?: string;
    /** Skip the executor when no sources match. Defaults to false. */
    allowEmpty?: boolean;
    /** Run regardless of destination timestamps. Sources are still required unless allowEmpty is set. */
    force?: boolean;
};
export type MakeContext = {
    cwd: string;
    resolved: {
        src: string;
        dest: string;
        changed: boolean;
    }[];
};
export type MakeExecutor = (this: TaskRunner, context: MakeContext) => Promise<void> | void;
/** Create an incremental task that runs when a source/dependency is newer than its destination. */
export declare function make(display: string, spec: MakeSpec, executor: MakeExecutor): TaskFunction;
export declare function make(spec: MakeSpec, executor: MakeExecutor): TaskFunction;
