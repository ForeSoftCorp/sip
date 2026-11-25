import { TaskRunner } from "./runner.mts";
export { logger } from "./logger.mts";
/** The default task runner. */
export const runner = new TaskRunner();
export const vars: Record<string, any> = {};
export type { TaskFunction, TaskExecutor, ParallelOptions } from "./runner.mts";
export type { Destination, GlobOptions, GlobPattern, MapOptions, MapFunction } from "./utils.mts";
export type { FileSystemOptions, TransferOptions } from "./fs.mts";
export { glob, map, resolve } from "./utils.mts";
export { cp, mv, rm, rmdir, mkdir } from "./fs.mts";
export { make } from "./make.mts";
export { watch, stopWatch } from "./watch.mts";
export type { WatchSpec, WatchOptions, WatchAddress } from "./watch.mts";
export type { MakeSpec, MakeContext, MakeExecutor } from "./make.mts";
export const task = runner.task.bind(runner);
export const series = runner.series.bind(runner);
export const parallel = runner.parallel.bind(runner);
export const conditional = runner.conditional.bind(runner);
