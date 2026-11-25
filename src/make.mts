import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import path from "node:path";
import { logger } from "./logger.mts";
import { glob, map } from "./utils.mts";
import type { GlobPattern, Destination } from "./utils.mts";
import type { TaskExecutor, TaskFunction, TaskRunner } from "./runner.mts";

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

export type MakeContext = { cwd: string; resolved: { src: string; dest: string; changed: boolean }[] };
export type MakeExecutor = (this: TaskRunner, context: MakeContext) => Promise<void> | void;

async function modified(file: string): Promise<number | undefined> {
	try { return (await stat(file)).mtimeMs; }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			return undefined;
		throw error;
	}
}

/** Create an incremental task that runs when a source/dependency is newer than its destination. */
export function make(display: string, spec: MakeSpec, executor: MakeExecutor): TaskFunction;
export function make(spec: MakeSpec, executor: MakeExecutor): TaskFunction;
export function make(displayOrSpec: string | MakeSpec, specOrExecutor: MakeSpec | MakeExecutor, maybeExecutor?: MakeExecutor): TaskFunction {
	const display = typeof displayOrSpec === "string" ? displayOrSpec : undefined;
	const label = display === undefined ? "make" : `make (${display})`;
	const spec = typeof displayOrSpec === "string" ? specOrExecutor as MakeSpec : displayOrSpec;
	const executor = typeof displayOrSpec === "string" ? maybeExecutor! : specOrExecutor as MakeExecutor;
	
	assert.ok(spec, "make requires a specification");
	assert.ok(spec.src, "make requires src");
	assert.ok(spec.dest, "make requires dest");
	assert.equal(typeof executor, "function", "make requires executor");
	assert.ok(spec.allowEmpty === undefined || typeof spec.allowEmpty === "boolean", "allowEmpty must be a boolean");
	assert.ok(spec.force === undefined || typeof spec.force === "boolean", "force must be a boolean");
	
	const result = async function (this: TaskRunner) {
		const cwd = path.resolve(spec.cwd ?? process.cwd());
		logger.debug("make: checking inputs", { cwd, src: spec.src, dest: spec.dest, deps: spec.deps });
		let dependencyTime = -Infinity;
		let newestDependency: string | undefined;
		for await (const dependency of glob(spec.deps ?? [], { cwd })) {
			const time = (await stat(dependency)).mtimeMs;
			if (time > dependencyTime) { dependencyTime = time; newestDependency = dependency; }
		}
		
		const resolved: MakeContext["resolved"] = [];
		
		for await (const src of glob(spec.src, { cwd })) {
			const dest = path.resolve(cwd, map(src, spec.dest));
			const destinationTime = await modified(dest);
			const sourceTime = (await stat(src)).mtimeMs;
			const reasons: string[] = [];
			
			if (spec.force)
				reasons.push("force enabled");
			
			if (destinationTime === undefined)
				reasons.push("destination missing");
			else {
				if (sourceTime > destinationTime)
					reasons.push("source newer than destination");
				if (dependencyTime > destinationTime)
					reasons.push("dependency newer than destination");
			}
			
			const changed = reasons.length > 0;
			
			logger.debug(`make: ${changed ? "rebuild" : "up to date"}: ${dest}${changed ? ` (${reasons.join("; ")})` : ""}`, {
				src, dest, sourceMtimeMs: sourceTime, destinationMtimeMs: destinationTime,
				newestDependency, dependencyMtimeMs: newestDependency === undefined ? undefined : dependencyTime,
			});
			
			resolved.push({ src, dest, changed });
		}
		
		if (resolved.length === 0) {
			assert.ok(spec.allowEmpty, `make found no source files: ${[spec.src].flat().join(", ")} (cwd: ${cwd})`);
			
			logger.verbose(`${label}: skipped, no source files matched (allowEmpty)`);
			logger.debug("make: skipping executor (no sources, allowEmpty)");
			
			return;
		}
		
		const changedCount = resolved.filter(file => file.changed).length;
		logger.debug(`make: ${changedCount ? "running executor" : "skipping executor"} (${changedCount}/${resolved.length} changed)`);
		
		if (changedCount) {
			const run: TaskExecutor = async () => {
				for (const dest of new Set(resolved.filter(file => file.changed).map(file => file.dest)))
					logger.verbose(`${label}: ${dest}`);
				await executor.call(this, { cwd, resolved });
			};
			if (display !== undefined) run.displayName = display;
			await this.run(run);
		} else {
			for (const dest of new Set(resolved.map(file => file.dest)))
				logger.verbose(`${label}: ${dest} (skipped, up to date)`);
		}
	};

	return result;
}
