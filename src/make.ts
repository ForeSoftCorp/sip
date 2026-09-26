import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { glob } from "./utils.ts";
import type { GlobPattern } from "./utils.ts";
import type { TaskFunction, TaskRunner } from "./runner.ts";

export type MakeSpec = {
	src: GlobPattern;
	dest: string;
	deps?: GlobPattern;
};

/** Create an incremental task that runs when a source/dependency is newer than its destination. */
export function make(display: string, spec: MakeSpec, executor: TaskFunction): TaskFunction;
export function make(spec: MakeSpec, executor: TaskFunction): TaskFunction;
export function make(displayOrSpec: string | MakeSpec, specOrExecutor: MakeSpec | TaskFunction, maybeExecutor?: TaskFunction): TaskFunction {
	const display = typeof displayOrSpec === "string" ? displayOrSpec : "make";
	const spec = typeof displayOrSpec === "string" ? specOrExecutor as MakeSpec : displayOrSpec;
	const executor = typeof displayOrSpec === "string" ? maybeExecutor! : specOrExecutor as TaskFunction;
	assert.ok(spec?.src, "make requires src");
	assert.ok(spec.dest, "make requires dest");
	assert.equal(typeof executor, "function", "make requires executor");
	const result = async function (this: TaskRunner) {
		const inputs: string[] = [];
		for await (const input of glob([spec.src].flat().concat([spec.deps ?? []].flat()))) 
			inputs.push(input);
		let destination: Awaited<ReturnType<typeof stat>> | undefined;
		try { destination = await stat(spec.dest); } catch { /* destination does not exist */ }
		if (!destination || (await Promise.all(inputs.map(async (file) => (await stat(file)).mtimeMs))).some((time) => time > destination!.mtimeMs)) await executor.call(this);
	};
	result.displayName = display;
	return result;
}
