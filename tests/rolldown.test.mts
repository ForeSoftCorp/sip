import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { logger } from "../src/index.mts";
import { TaskRunner } from "../src/runner.mts";
import { rolldown } from "../src/rolldown.mts";

void test("rolldown bundles entries concurrently with independent working directories", async t => {
	const originalCwd = process.cwd();
	await Promise.all([17, 29].map(async value => {
		const cwd = await mkdtemp(path.join(os.tmpdir(), "sip-rolldown-"));
		t.after(() => rm(cwd, { recursive: true, force: true }));
		await writeFile(path.join(cwd, "value.mts"), `export const value: number = ${value};`);
		await writeFile(path.join(cwd, "entry.mts"), 'export { value } from "./value.mts";');
		await rolldown("entry.mts", "out/bundle.mjs", { cwd, output: { sourcemap: true } });
		const bundle = await import(pathToFileURL(path.join(cwd, "out/bundle.mjs")).href);
		assert.equal(bundle.value, value);
		assert.ok((await stat(path.join(cwd, "out/bundle.mjs.map"))).isFile());
	}));
	assert.equal(process.cwd(), originalCwd);
});

void test("rolldown loads TypeScript config functions and merges options without mutating them", async t => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "sip-rolldown-config-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	await writeFile(path.join(cwd, "entry.mts"), "export const value: number = 42;");
	await writeFile(path.join(cwd, "config.mts"), `
        export default async (args: { input: string }) => ({
            input: "missing.mts",
            output: { dir: "wrong", format: "cjs", banner: "/* config banner */", sourcemap: true },
            plugins: [{ name: "check-input", buildStart() {
                if (!args.input.endsWith("entry.mts")) throw new Error("Missing entry argument");
            } }],
        });
    `);
	const output = Object.freeze({ format: "esm" as const, file: "wrong.mjs" });
	const options = Object.freeze({ cwd, configPath: "config.mts", input: "also-missing.mts", output });
	await rolldown("entry.mts", "out/bundle.mjs", options);
	assert.match(await readFile(path.join(cwd, "out/bundle.mjs"), "utf8"), /config banner/);
	assert.equal((await import(pathToFileURL(path.join(cwd, "out/bundle.mjs")).href)).value, 42);
	assert.ok((await stat(path.join(cwd, "out/bundle.mjs.map"))).isFile());
	assert.equal(output.file, "wrong.mjs");
	await assert.rejects(stat(path.join(cwd, "wrong")), { code: "ENOENT" });
});

void test("rolldown routes logs through SIP with task IDs and supports logging hooks", async t => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "sip-rolldown-logs-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	await writeFile(path.join(cwd, "entry.js"), "export const value = 1;");
	const messages: [string, unknown, number | undefined, unknown[]][] = [];
	for (const level of ["warning", "info", "debug"] as const) {
		const listener = (message: unknown, ...args: unknown[]) => messages.push([level, message, logger.taskId, args]);
		logger.on(level, listener);
		t.after(() => logger.off(level, listener));
	}
	const runner = new TaskRunner();
	await runner.run(runner.task("Bundle", () => rolldown("entry.js", "bundle.js", {
		cwd,
		plugins: [{ name: "messages", buildStart() {
			this.warn("warning message");
			this.info("info message");
			this.debug("debug message");
			this.warn("suppressed");
		} }],
		onLog(level, log, next) {
			if (log.message === "suppressed")
				return;
			next(level, level === "warn" ? { ...log, message: `handled: ${log.message}` } : log);
		},
	})));
	// Console sinks print every argument: normal logs must not repeat the raw diagnostic.
	assert.deepEqual(messages.filter(([level]) => level !== "debug").map(([level, message, , args]) => [level, message, ...args]), [
		["warning", "handled: warning message"], ["info", "info message"],
	]);
	const diagnostics = messages.filter(([level, message]) => level === "debug" && message === "rolldown: diagnostic");
	assert.deepEqual(diagnostics.map(([, , , args]) => args[0]), [
		{ code: "PLUGIN_WARNING", plugin: "messages", message: "handled: warning message" },
		{ code: "PLUGIN_LOG", plugin: "messages", message: "info message" },
	]);
	assert.deepEqual(messages.map(([level, message]) => [level, message]), [
		["debug", "rolldown: effective build options"],
		["warning", "handled: warning message"], ["debug", "rolldown: diagnostic"],
		["info", "info message"], ["debug", "rolldown: diagnostic"], ["debug", "debug message"],
	]);
	assert.ok(messages.length > 0);
	assert.ok(messages.every(([, , id]) => id !== undefined && id === messages[0]?.[2]));
});

void test("rolldown propagates build/config failures and respects write: false", async t => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "sip-rolldown-errors-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	await writeFile(path.join(cwd, "entry.js"), "export const value = 1;");
	await assert.rejects(rolldown("", "out.js", { cwd }), /entry file/);
	await assert.rejects(rolldown("entry.js", "out.js", {
		cwd,
		// @ts-expect-error The removed hook is rejected by the public type and at runtime.
		onwarn() {},
	}), /onwarn is no longer supported; use onLog instead/);
	await writeFile(path.join(cwd, "legacy.mjs"), "export default { onwarn() {} };");
	await assert.rejects(rolldown("entry.js", "out.js", { cwd, configPath: "legacy.mjs" }), /onwarn is no longer supported; use onLog instead/);
	await assert.rejects(rolldown("entry.js", "", { cwd }), /destination file/);
	await assert.rejects(rolldown("missing.js", "out.js", { cwd }));
	await assert.rejects(rolldown("entry.js", "out.js", { cwd, configPath: "missing.mjs" }));
	await writeFile(path.join(cwd, "array.mjs"), "export default [{}, {}];");
	await assert.rejects(rolldown("entry.js", "out.js", { cwd, configPath: "array.mjs" }), /single Rolldown configuration/);
	await writeFile(path.join(cwd, "outputs.mjs"), "export default { output: [{}, {}] };");
	await assert.rejects(rolldown("entry.js", "out.js", { cwd, configPath: "outputs.mjs" }), /single output/);
	await assert.rejects(rolldown("entry.js", "out.js", { cwd,
		plugins: [{ name: "fail", buildStart() { this.warn("fatal warning"); } }],
		onLog(_level, log, next) { next("error", log); },
	}), /fatal warning/);
	await rolldown("entry.js", "out.js", { cwd, write: false });
	await assert.rejects(stat(path.join(cwd, "out.js")), { code: "ENOENT" });
});
