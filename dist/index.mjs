import { TaskRunner } from "./runner.mjs";
export { logger } from "./logger.mjs";
/** The default task runner. */
export const runner = new TaskRunner();
export const vars = {};
export { glob, map, resolve } from "./utils.mjs";
export { cp, mv, rm, rmdir, mkdir } from "./fs.mjs";
export { make } from "./make.mjs";
export { watch, stopWatch } from "./watch.mjs";
export const task = runner.task.bind(runner);
export const series = runner.series.bind(runner);
export const parallel = runner.parallel.bind(runner);
export const conditional = runner.conditional.bind(runner);
