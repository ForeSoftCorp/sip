import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import path from "node:path";
import { logger } from "./logger.mjs";
import { glob, map } from "./utils.mjs";
async function modified(file) {
    try {
        return (await stat(file)).mtimeMs;
    }
    catch (error) {
        if (error.code === "ENOENT")
            return undefined;
        throw error;
    }
}
export function make(displayOrSpec, specOrExecutor, maybeExecutor) {
    const display = typeof displayOrSpec === "string" ? displayOrSpec : undefined;
    const label = display === undefined ? "make" : `make (${display})`;
    const spec = typeof displayOrSpec === "string" ? specOrExecutor : displayOrSpec;
    const executor = typeof displayOrSpec === "string" ? maybeExecutor : specOrExecutor;
    assert.ok(spec, "make requires a specification");
    assert.ok(spec.src, "make requires src");
    assert.ok(spec.dest, "make requires dest");
    assert.equal(typeof executor, "function", "make requires executor");
    assert.ok(spec.allowEmpty === undefined || typeof spec.allowEmpty === "boolean", "allowEmpty must be a boolean");
    assert.ok(spec.force === undefined || typeof spec.force === "boolean", "force must be a boolean");
    const result = async function () {
        const cwd = path.resolve(spec.cwd ?? process.cwd());
        logger.debug("make: checking inputs", { cwd, src: spec.src, dest: spec.dest, deps: spec.deps });
        let dependencyTime = -Infinity;
        let newestDependency;
        for await (const dependency of glob(spec.deps ?? [], { cwd })) {
            const time = (await stat(dependency)).mtimeMs;
            if (time > dependencyTime) {
                dependencyTime = time;
                newestDependency = dependency;
            }
        }
        const resolved = [];
        for await (const src of glob(spec.src, { cwd })) {
            const dest = path.resolve(cwd, map(src, spec.dest));
            const destinationTime = await modified(dest);
            const sourceTime = (await stat(src)).mtimeMs;
            const reasons = [];
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
            const run = async () => {
                for (const dest of new Set(resolved.filter(file => file.changed).map(file => file.dest)))
                    logger.verbose(`${label}: ${dest}`);
                await executor.call(this, { cwd, resolved });
            };
            if (display !== undefined)
                run.displayName = display;
            await this.run(run);
        }
        else {
            for (const dest of new Set(resolved.map(file => file.dest)))
                logger.verbose(`${label}: ${dest} (skipped, up to date)`);
        }
    };
    return result;
}
