import { TaskRunner } from "./runner.ts";
import { Logger } from "./logger.ts";
/** The default task runner. */
export const logger = new Logger();
export const runner = new TaskRunner(logger);
export const vars: Record<string, any> = {};
export type { TaskFunction, ParallelOptions } from "./runner.ts";
export { glob, map, resolve } from "./utils.ts";
export { cp, mv, rm, md } from "./fs.ts";
export { make } from "./make.ts";
export const task = runner.task.bind(runner);
export const series = runner.series.bind(runner);
export const parallel = runner.parallel.bind(runner);
export const conditional = runner.conditional.bind(runner);
