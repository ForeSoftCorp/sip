import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { logger } from "../src/logger.mts";
import { TaskRunner } from "../src/runner.mts";
import { watch, stopWatch } from "../src/index.mts";
import type { WatchSpec } from "../src/watch.mts";

async function temporary(t: TestContext): Promise<string> {
	const directory = await mkdtemp(path.join(os.tmpdir(), "sip-watch-test-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	return directory;
}

async function until(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 5000;
	while (!predicate()) {
		assert.ok(Date.now() < deadline, "Timed out waiting for watcher");
		await delay(10);
	}
}

async function start(t: TestContext, cwd: string, specs: WatchSpec[]) {
	const controller = new AbortController();
	const runner = new TaskRunner();
	const ready = once(logger, "info", { signal: controller.signal });
	const completion = runner.run(watch(specs, { cwd, signal: controller.signal, interval: 20 }));
	// Keep unexpected failures handled until the test awaits completion.
	void completion.catch(() => {});
	t.after(async () => { controller.abort(); await completion.catch(() => {}); });
	await Promise.race([ready, completion.then(() => { throw new Error("Watch exited before ready"); })]);
	return { completion, controller, runner };
}

void test("watch detects edits, additions in new directories, renames and deletions with cwd and exclusions", { timeout: 10000 }, async t => {
	const cwd = await temporary(t);
	await mkdir(path.join(cwd, "src"));
	const source = path.join(cwd, "src", "a.txt");
	await writeFile(source, "initial");
	let runs = 0;
	let otherRuns = 0;
	const session = await start(t, cwd, [
		{ src: ["**/*.txt", "!**/ignored.txt"], cwd: "src", run: function () { assert.equal(this, session.runner); runs++; } },
		{ src: "**/*.css", run: () => { otherRuns++; } },
	]);
	await delay(80);
	assert.equal(runs, 0, "no initial run");
	await writeFile(path.join(cwd, "src", "ignored.txt"), "excluded");
	await writeFile(path.join(cwd, "src", "unmatched.js"), "excluded");
	await delay(80);
	assert.equal(runs, 0);
	for (const change of [
		() => writeFile(source, "edited content"),
		async () => { await mkdir(path.join(cwd, "src", "nested")); await writeFile(path.join(cwd, "src", "nested", "new.txt"), "new"); },
		() => rename(source, path.join(cwd, "src", "renamed.txt")),
		() => rm(path.join(cwd, "src", "renamed.txt")),
	]) {
		const before = runs;
		await change();
		await until(() => runs > before);
	}
	assert.equal(otherRuns, 0);
	await writeFile(path.join(cwd, "new.css"), "css");
	await until(() => otherRuns === 1);
	session.controller.abort();
	await session.completion;
});

void test("watch coalesces edits during a build and drains active work on cancellation", { timeout: 10000 }, async t => {
	const cwd = await temporary(t);
	const source = path.join(cwd, "input.txt");
	const gates = [Promise.withResolvers<undefined>(), Promise.withResolvers<undefined>()] as const;
	let runs = 0;
	let active = 0;
	let maxActive = 0;
	t.after(() => gates.forEach(gate => gate.resolve(undefined)));
	const session = await start(t, cwd, [{ src: "*.txt", run: async () => {
		const index = runs++;
		maxActive = Math.max(maxActive, ++active);
		await gates[index]?.promise;
		active--;
	} }]);
	await writeFile(source, "first");
	await until(() => runs === 1);
	await writeFile(source, "second");
	await writeFile(source, "third");
	await delay(80);
	assert.equal(runs, 1);
	gates[0].resolve(undefined);
	await until(() => runs === 2);
	await writeFile(source, "fourth");
	await stopWatch({ cwd });
	let finished = false;
	void session.completion.then(() => { finished = true; });
	await delay(80);
	assert.equal(finished, false);
	gates[1].resolve(undefined);
	await session.completion;
	assert.equal(runs, 2);
	assert.equal(maxActive, 1);
	await stopWatch({ cwd }); // idempotent when no watcher exists
});

void test("executor failures reject and release the watch address for reuse", { timeout: 10000 }, async t => {
	const cwd = await temporary(t);
	const session = await start(t, cwd, [{ src: "*.txt", run: () => { throw new Error("build failed"); } }]);
	await writeFile(path.join(cwd, "input.txt"), "new");
	await assert.rejects(session.completion, /build failed/);
	const next = await start(t, cwd, [{ src: "*.txt", run: () => {} }]);
	await assert.rejects(next.runner.run(watch([{ src: "*.txt", run: () => {} }], { cwd })), /EADDRINUSE/);
	await stopWatch({ cwd });
	await next.completion;
});

void test("pre-aborted watch returns without running tasks or opening a control endpoint", async t => {
	const cwd = await temporary(t);
	const runner = new TaskRunner();
	await runner.run(watch([{ src: "**/*", run: () => assert.fail("unexpected run") }], { cwd, signal: AbortSignal.abort() }));
	await stopWatch({ cwd });
	assert.throws(() => watch([]), /at least one/);
	assert.throws(() => watch([{ src: "", run: () => {} }]), /non-empty/);
	assert.throws(() => watch([{ src: "*", run: () => {} }], { interval: 0 }), /interval/);
});

void test("a separate CLI invocation can stop a watcher and both processes exit cleanly", { timeout: 15000 }, async t => {
	const cwd = await temporary(t);
	const taskFile = path.join(cwd, "taskfile.mjs");
	await writeFile(taskFile, `
        import { watch, stopWatch } from ${JSON.stringify(pathToFileURL(path.resolve("src/index.mts")).href)};
        export default watch([{ src: "*.txt", run() {} }]);
        export const stop = () => stopWatch();
    `);
	const cli = path.resolve("src/cli.mts");
	const watcher = spawn(process.execPath, [cli, "--file", taskFile, "--no-timestamp"], { cwd, windowsHide: true });
	const exited = once(watcher, "exit");
	t.after(() => { if (watcher.exitCode === null)
		watcher.kill(); });
	let output = "";
	let errors = "";
	watcher.stdout.on("data", chunk => { output += chunk; });
	watcher.stderr.on("data", chunk => { errors += chunk; });
	await Promise.race([until(() => output.includes("watch: ready")), exited.then(() => { throw new Error(`Watcher exited before ready: ${errors}`); })]);
	const stopper = spawn(process.execPath, [cli, "stop", "--file", taskFile, "--no-timestamp"], { cwd, windowsHide: true });
	t.after(() => { if (stopper.exitCode === null)
		stopper.kill(); });
	assert.deepEqual(await once(stopper, "exit"), [0, null]);
	assert.deepEqual(await exited, [0, null], errors);
});
