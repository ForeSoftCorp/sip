import assert from "node:assert/strict";
import * as os from "node:os";
import { logger } from "./logger.mts";
import type { Logger } from "./logger.mts";


export type TaskFunction = (this: TaskRunner) => Promise<void> | void;

/** A task executor. */
export type TaskExecutor = {
	(): Promise<void> | void,
	(this: TaskRunner): Promise<void> | void,
	displayName?: string;
};

export type ParallelOptions = { maxDop?: number; }

type Truthy = boolean | string | number | object | null | undefined;

/** Runs named tasks sequentially or concurrently and records their performance. */
export class TaskRunner {

	/** Alias for SIP's shared logger. */
	get logger() : Logger {
		return logger;
	}

	run = async (taskFn: TaskExecutor): Promise<void> => {
		const displayName = taskFn.displayName;
		if(displayName) {
			await logger.withTask(async () => {
				const start = performance.now();
				logger.taskStart(displayName);
				try {
					await taskFn.call(this);
				} finally {
					logger.taskEnd(displayName, performance.now() - start);
				}
			});
		} else {
			await taskFn.call(this);
		}
	}

	/** Wrap an executor with start/end logging. */
	task = (displayName: string, taskFn: TaskExecutor): TaskExecutor => {
		assert.equal(typeof displayName, "string", "displayName must be a string");
		assert.ok(displayName.length > 0, "displayName must be non-empty");
		assert.equal(typeof taskFn, "function", "taskFn must be a function");

		const result = async () => await this.run(taskFn);
		result.displayName = displayName;
		return result;
	}

	/** Execute tasks in order, stopping at the first failure. */
	series = (...taskFns: TaskExecutor[]): TaskExecutor => {
		assert.ok(taskFns.length > 0, "series requires at least one task");
		assert.ok(taskFns.every(fn => typeof fn === "function"), "series tasks must be functions");

		return async () => {
			for (const fn of taskFns)
				await this.run(fn);
		};
	}

	/** Execute tasks concurrently. On failure, stop scheduling and drain active tasks before rejecting. */
	parallel = (...args: [ParallelOptions, ...TaskExecutor[]] | TaskExecutor[]): TaskExecutor => {
		let options: ParallelOptions = {};
		if (typeof args[0] === "object")
			options = { ...(args.shift() as ParallelOptions) };
		const tasks = args as TaskExecutor[];
		assert.ok(tasks.length > 0, "parallel requires at least one task");
		assert.ok(tasks.every((fn) => typeof fn === "function"), "parallel tasks must be functions");
		assert.ok(options.maxDop === undefined || (Number.isInteger(options.maxDop) && options.maxDop > 0), "maxDop must be a positive integer");

		options = { maxDop: os.cpus().length, ...options };

		const result = async () => {
			let next = 0;
			const state = { failed: false };
			// Other workers may change this while the current worker is awaiting a task.
			const hasFailed = () => state.failed;
			let firstError: unknown;
			const worker = async () => {
				while (!hasFailed() && next < tasks.length) {
					const fn = tasks[next++];
					assert.ok(fn, "parallel task index must be in range");
					try {
						await this.run(fn);
					} catch (error) {
						if (!hasFailed())
							firstError = error;
						state.failed = true;
					}
				}
			};
			await Promise.all(Array.from({ length: Math.min(options.maxDop ?? (tasks.length || 1), tasks.length || 1) }, worker));
			if (state.failed)
				throw firstError;
		};
		return result;
	}

	/** Run tasks only when the condition resolves to true. */
	conditional = (condition: Truthy | (() => Truthy | Promise<Truthy>), taskFn: TaskExecutor): TaskExecutor => {
		assert.equal(typeof taskFn, "function", "taskFn must be a function");

		if(typeof condition === "function") {
			return async () => {
				if(await condition()) {
					await this.run(taskFn);
				}
			};
		} else if(condition) {
			return () => this.run(taskFn);
		} else {
			return () => { /* no-op */ };
		}
	}
}
