import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { node, npm, npx, ProcessError, parallel, runner, series, task } from "../src/index.mts";
import { logger } from "../src/logger.mts";

async function fixture(t: TestContext): Promise<string> {
	const directory = await mkdtemp(path.join(os.tmpdir(), "sip-process test-"));
	// Remove only the exact private directory allocated by mkdtemp.
	t.after(() => rm(directory, { recursive: true, force: true }));
	return directory;
}

const argumentsToPreserve = ["two words", "", 'quote"inside', "apostrophe'", "& echo injected", "%PATH%", "$HOME", "`whoami`", "a=b", "last\\"];
const reportScript = `
import { writeFileSync } from "node:fs";
writeFileSync(process.argv[2], JSON.stringify({
  args: process.argv.slice(3), cwd: process.cwd(), pid: process.pid,
  value: process.env.SIP_TEST_VALUE, inherited: !!process.env.PATH || !!process.env.Path
}));
process.env.SIP_TEST_VALUE = "changed in child";
`;

for (const worker of [false, true]) {
	void test(`node preserves arguments and isolates environment (${worker ? "worker" : "process"})`, async t => {
		const directory = await fixture(t);
		const script = path.join(directory, "script with spaces.mjs");
		await writeFile(script, reportScript);
		const parentValue = process.env["SIP_TEST_VALUE"];
		const parentArgs = [...process.argv];
		// Two simultaneous runs must not share argv, exit state, or per-run environment.
		await runner.run(parallel(...["first", "second"].map(value => async () => {
			const output = path.join(directory, `${value}.json`);
			await node([script, output, ...argumentsToPreserve], { worker, env: { SIP_TEST_VALUE: value }, stdio: "ignore" });
			const result = JSON.parse(await readFile(output, "utf8"));
			assert.deepEqual(result.args, argumentsToPreserve);
			assert.equal(result.cwd, process.cwd());
			assert.equal(result.value, value);
			assert.equal(result.inherited, true);
			assert.equal(result.pid === process.pid, worker);
		})));
		assert.equal(process.env["SIP_TEST_VALUE"], parentValue);
		assert.deepEqual(process.argv, parentArgs);
	});

	void test(`node rejects failures and stops series (${worker ? "worker" : "process"})`, async t => {
		const directory = await fixture(t);
		const script = path.join(directory, "failure.mjs");
		await writeFile(script, "process.exit(7);");
		let continued = false;
		await assert.rejects(runner.run(series(
			() => node([script], { worker, stdio: "ignore" }),
			() => { continued = true; },
		)), error => {
			assert.ok(error instanceof ProcessError);
			assert.equal(error.exitCode, 7);
			assert.equal(error.command, "node");
			return true;
		});
		assert.equal(continued, false);
		await writeFile(script, "throw new Error('script failed');");
		await assert.rejects(node([script], { worker, stdio: "ignore" }));
		await assert.rejects(node([path.join(directory, "missing.mjs")], { worker, stdio: "ignore" }));
	});

	void test(`node cancels running work and rejects pre-aborted work (${worker ? "worker" : "process"})`, async t => {
		const directory = await fixture(t);
		const script = path.join(directory, "wait.mjs");
		await writeFile(script, "setInterval(() => {}, 1000);");
		const controller = new AbortController();
		const result = node([script], { worker, signal: controller.signal, stdio: "ignore" });
		const timer = setTimeout(() => controller.abort(), 100);
		try { await assert.rejects(result, { name: "AbortError" }); }
		finally { clearTimeout(timer); }
		await assert.rejects(node([script], { worker, signal: controller.signal }), { name: "AbortError" });
	});
}

void test("node supports CLI flags and cwd without changing the parent; worker rejects unsupported forms", async t => {
	const directory = await fixture(t);
	const output = path.join(directory, "cwd.txt");
	await node(["--eval", "require('node:fs').writeFileSync(process.argv[1], process.cwd())", output], { cwd: directory });
	assert.equal(await readFile(output, "utf8"), directory);
	await assert.rejects(node(["--eval", ""], { worker: true }), /requires a script path/);
	await assert.rejects(node(["script.mjs"], { worker: true, cwd: directory }), /cannot change cwd/);
	await assert.rejects(node(["--version"], { cwd: path.join(directory, "missing") }), { code: "ENOENT" });
	await assert.rejects(node([]), /requires a script/);
	await assert.rejects(node(["bad\0arg"]), /null bytes/);
});

void test("node logging retains its surrounding task ID", async () => {
	const events: (number | undefined)[] = [];
	const listener = (message: string) => { if (message === "node: starting") events.push(logger.taskId); };
	logger.on("verbose", listener);
	try { await runner.run(task("Process", () => node(["--version"], { stdio: "ignore" }))); }
	finally { logger.off("verbose", listener); }
	assert.equal(events.length, 1);
	assert.equal(typeof events[0], "number");
});

void test("worker executes ESM and CommonJS scripts as entry points", async t => {
	const directory = await fixture(t);
	for (const [extension, code] of [
		["mjs", 'import { writeFileSync } from "node:fs"; if (!import.meta.main) throw new Error("Not the entry point"); writeFileSync(process.argv[2], "esm");'],
		["cjs", 'if (require.main !== module) throw new Error("Not the entry point"); require("node:fs").writeFileSync(process.argv[2], "cjs");'],
	] as const) {
		const script = path.join(directory, `script.${extension}`);
		const output = path.join(directory, `${extension}.txt`);
		await writeFile(script, code);
		await node([script, output], { worker: true });
		assert.equal(await readFile(output, "utf8"), extension === "mjs" ? "esm" : "cjs");
	}
});

void test("npm and npx locate active npm CLI files and preserve literal arguments and cwd", async t => {
	const directory = await fixture(t);
	const npmPath = path.join(directory, "npm-cli.js");
	await writeFile(path.join(directory, "package.json"), '{"type":"module"}');
	await writeFile(npmPath, reportScript);
	await writeFile(path.join(directory, "npx-cli.js"), reportScript);
	for (const command of [npm, npx]) {
		const output = path.join(directory, `${command.name}.json`);
		await command([output, ...argumentsToPreserve], { cwd: directory, env: { npm_execpath: npmPath, SIP_TEST_VALUE: command.name }, stdio: "ignore" });
		const result = JSON.parse(await readFile(output, "utf8"));
		assert.deepEqual(result.args, argumentsToPreserve);
		assert.equal(result.cwd, directory);
		assert.equal(result.value, command.name);
		assert.notEqual(result.pid, process.pid);
	}
	await writeFile(npmPath, "process.exit(3);");
	await assert.rejects(npm(["run", "build"], { env: { npm_execpath: npmPath }, stdio: "ignore" }), error => {
		assert.ok(error instanceof ProcessError);
		assert.equal(error.command, "npm");
		assert.equal(error.exitCode, 3);
		return true;
	});
});

void test("npm works outside npm scripts and npx runs an installed binary offline", async () => {
	await npm(["--version"], { env: { npm_execpath: undefined }, stdio: "ignore" });
	await npx(["--offline", "--no", "--", "tsc", "--version"], { stdio: "ignore" });
	await assert.rejects(npx(["--offline", "--no", "--", "tsc", "--sip-invalid-option"], { stdio: "ignore" }), ProcessError);
	await assert.rejects(npx([]), /requires arguments/);
});
