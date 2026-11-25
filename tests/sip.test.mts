import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { after, test } from "node:test";
import { cp as nodeCp, mkdtemp, readFile, rm as removeDirectory, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { main } from "../src/cli.mts";
import { cp, mkdir, mv, rm, rmdir } from "../src/fs.mts";
import { Logger, logger } from "../src/logger.mts";
import { make } from "../src/make.mts";
import { TaskRunner } from "../src/runner.mts";
import { glob, map, resolve } from "../src/utils.mts";
import * as sip from "../src/index.mts";
import { pathToFileURL } from "node:url";

const temporaryDirectories: string[] = [];

void test("copy and move reject basename collisions before changing files", async () => {
	const directory = await temporaryDirectory();
	for (const subdir of ["a", "b"]) {
		await mkdir(path.join(directory, subdir));
		await writeFile(path.join(directory, subdir, "same.txt"), subdir);
	}
	const sources: [string, string] = [path.join(directory, "a", "same.txt"), path.join(directory, "b", "same.txt")];
	for (const operation of [cp, mv]) {
		const dest = path.join(directory, operation.name);
		await assert.rejects(operation(sources, dest + path.sep), /Destination collision/);
		await assert.rejects(stat(dest), { code: "ENOENT" });
		assert.equal(await readFile(sources[0], "utf8"), "a");
		assert.equal(await readFile(sources[1], "utf8"), "b");
	}
	if (process.platform === "win32") {
		const uppercase = path.join(directory, "b", "SAME.txt");
		await assert.rejects(cp([sources[0], uppercase], path.join(directory, "case") + path.sep), /Destination collision/);
	}
});

for (const operation of [cp, mv]) {
	for (const mapping of ["swap", "chain", "case variant"] as const) {
		void test(`${operation.name} rejects source overlaps in a ${mapping} before modifying files`, {
			skip: mapping === "case variant" && process.platform !== "win32",
		}, async () => {
			const cwd = await temporaryDirectory();
			const inputs = ["safe.txt", "a.txt", "b.txt"];
			for (const name of inputs)
				await writeFile(path.join(cwd, name), `original ${name}`);
			await assert.rejects(operation(inputs, source => {
				const name = path.basename(source);
				if (name === "safe.txt")
					return "out/safe.txt";
				if (name === "a.txt")
					return mapping === "case variant" ? "B.TXT" : "unused/../b.txt";
				return mapping === "swap" ? "a.txt" : "out/b.txt";
			}, { cwd }), error => {
				assert.ok(error instanceof Error);
				assert.match(error.message, /Destination overlaps source/);
				assert.ok(error.message.includes(path.join(cwd, "a.txt")));
				assert.ok(error.message.includes(path.join(cwd, "b.txt")));
				return true;
			});
			for (const name of inputs)
				assert.equal(await readFile(path.join(cwd, name), "utf8"), `original ${name}`);
			await assert.rejects(stat(path.join(cwd, "out")), { code: "ENOENT" });
			await assert.rejects(stat(path.join(cwd, "unused")), { code: "ENOENT" });
		});
	}
}

void test("CLI validates options before loading tasks", async () => {
	for (const option of ["-f", "--file", "--logger", "--loglevel", "--set"]) {
		await assert.rejects(main([option]), /Missing value/);
		await assert.rejects(main([option, "--no-perf"]), /Missing value/);
	}
	for (const [argv, message] of [
		[["--file="], /Missing value/],
		[["--logger=unknown"], /Invalid logger/],
		[["--loglevel=toString"], /Invalid log level/],
		[["--set=novalue"], /requires name=value/],
		[["--set==value"], /requires name=value/],
		[["--set=__proto__=value"], /requires name=value/],
		[["--perf=false"], /does not accept a value/],
		[["one", "two"], /Only one task/],
		[["--unknown"], /Unknown argument/],
	] as [string[], RegExp][])
		await assert.rejects(main(argv), message);
});

void test("CLI accepts equals options, preserves set values, and offers standalone help", async () => {
	const directory = await temporaryDirectory();
	const taskFile = path.join(directory, "task file.mjs");
	const importPath = pathToFileURL(path.resolve("src/index.mts")).href;
	await writeFile(taskFile, `
    import { logger, vars } from ${JSON.stringify(importPath)};
    export function selected() { logger.info(JSON.stringify(vars)); }
  `);
	const cli = path.resolve("src/cli.mts");
	for (const equals of [false, true]) {
		const pairs: [string, string][] = [["--file", taskFile], ["--logger", "simple"], ["--loglevel", "normal"],
			["--set", "text=a=b"], ["--set", "empty="], ["--set", "count=12"], ["--set", "flag=false"], ["--set", "nil=null"]];
		const args = pairs.flatMap(([key, value]) => equals ? [`${key}=${value}`] : [key, value]);
		const result = spawnSync(process.execPath, [cli, "selected", ...args, "--no-timestamp"], { encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(JSON.parse(result.stdout), { text: "a=b", empty: "", count: 12, flag: false, nil: null });
	}
	const help = spawnSync(process.execPath, [cli, "--help"], { cwd: directory, encoding: "utf8" });
	assert.equal(help.status, 0, help.stderr);
	assert.match(help.stdout, /Usage: sip/);
});

void test("task IDs isolate parallel logs, inherit through unnamed tasks, and restore after nested failure", async t => {
	const runner = new TaskRunner();
	const events: [number | undefined, string][] = [];
	const record = (message: unknown) => { events.push([logger.taskId, String(message)]); };
	for (const event of ["taskStart", "taskEnd", "info", "warning", "error", "debug"] as const) {
		logger.on(event, record);
		t.after(() => logger.off(event, record));
	}
	const stylesFinished = Promise.withResolvers<undefined>();
	await runner.run(runner.parallel({ maxDop: 2 },
		runner.task("Build", async () => {
			await stylesFinished.promise;
			await runner.run(() => { logger.info("compiling"); });
			await assert.rejects(runner.run(runner.task("Nested", async () => {
				await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 1));
				logger.error("nested error");
				throw new Error("nested failure");
			})), /nested failure/);
			logger.warning("parent resumed");
		}),
		runner.task("Styles", async () => {
			await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
			logger.debug("styling");
			stylesFinished.resolve(undefined);
		}),
	));
	logger.info("outside");
	const firstId = events.find(([, message]) => message === "Build")?.[0];
	assert.ok(firstId !== undefined);
	assert.deepEqual(events.filter(([, message]) => !["Build", "Styles", "Nested"].includes(message)), [
		[firstId + 1, "styling"], [firstId, "compiling"], [firstId + 2, "nested error"], [firstId, "parent resumed"], [undefined, "outside"],
	]);
	for (const [name, id] of [["Build", firstId], ["Styles", firstId + 1], ["Nested", firstId + 2]] as const) {
		assert.deepEqual(events.filter(([, message]) => message === name), [[id, name], [id, name]]);
	}
	const repeated = runner.task("Repeat", () => {});
	await runner.run(repeated);
	await new TaskRunner().run(repeated);
	assert.deepEqual(events.slice(-4), [[firstId + 3, "Repeat"], [firstId + 3, "Repeat"], [firstId + 4, "Repeat"], [firstId + 4, "Repeat"]]);
	assert.equal(logger.taskId, undefined);
});

void test("separate runners and standalone handlers share sinks while preserving task IDs", async t => {
	const cwd = await temporaryDirectory();
	const first = new TaskRunner();
	const second = new TaskRunner();
	assert.equal(first.logger, logger);
	assert.equal(second.logger, logger);
	assert.equal(sip.logger, logger);
	const starts = new Map<string, number | undefined>();
	const messages: [number | undefined, string][] = [];
	const onStart = (name: string) => { starts.set(name, logger.taskId); };
	const onVerbose = (message: string) => { messages.push([logger.taskId, message]); };
	logger.on("taskStart", onStart);
	logger.on("verbose", onVerbose);
	t.after(() => { logger.off("taskStart", onStart); logger.off("verbose", onVerbose); });
	await Promise.all([
		first.run(first.task("First", async () => {
			await new Promise<void>(resolvePromise => setImmediate(resolvePromise));
			await mkdir("first", { cwd });
		})),
		second.run(second.task("Second", () => mkdir("second", { cwd }))),
	]);
	await mkdir("outside", { cwd });
	const firstId = starts.get("First");
	const secondId = starts.get("Second");
	assert.ok(firstId !== undefined && secondId !== undefined);
	assert.notEqual(firstId, secondId);
	for (const [name, id] of [["first", firstId], ["second", secondId], ["outside", undefined]] as const)
		assert.deepEqual(messages.find(([, message]) => message === `mkdir: ${path.join(cwd, name)}`), [id, `mkdir: ${path.join(cwd, name)}`]);
	assert.equal(logger.taskId, undefined);
});

void test("console sinks prefix task messages with compact numeric IDs", async () => {
	const directory = await temporaryDirectory();
	const taskFile = path.join(directory, "task.mjs");
	const importPath = pathToFileURL(path.resolve("src/index.mts")).href;
	await writeFile(taskFile, `
    import { task, parallel, logger } from ${JSON.stringify(importPath)};
    const gate = Promise.withResolvers();
    export default parallel({ maxDop: 2 },
      task('Build', async () => {
        await gate.promise;
        logger.info('Compiling 12 files...');
        logger.warning('warning'); logger.error('error'); logger.debug('debug');
      }),
      task('Styles', async () => {
        await new Promise(resolve => setImmediate(resolve));
        logger.info('Writing styles'); gate.resolve();
      })
    );
  `);
	for (const kind of ["simple", "color", "devops"]) {
		const result = spawnSync(process.execPath, [path.resolve("src/cli.mts"), "--file", taskFile,
			"--logger", kind, "--no-timestamp", "--loglevel", "debug"], { encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
		// ANSI color sequences intentionally begin with the ESC control character.
		// eslint-disable-next-line no-control-regex
		const clean = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "");
		const stdout = clean(result.stdout);
		const stderr = clean(result.stderr);
		assert.match(stdout, /1> Starting Build/);
		assert.match(stdout, /2> Starting Styles/);
		assert.match(stdout, /1> Compiling 12 files\.\.\./);
		assert.match(stdout, /2> Writing styles/);
		assert.match(stdout, /1> Finished Build/);
		assert.match(stdout, /2> Finished Styles/);
		assert.match(stdout, /1> debug/);
		assert.match(stderr, /1> warning/);
		assert.match(stderr, /1> error/);
		if (kind === "devops")
			assert.match(stderr, /##vso\[task.logissue type=error\]1> error/);
	}
});

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(path.join(os.tmpdir(), "sip-test-"));
	temporaryDirectories.push(directory);
	return directory;
}

async function collect<T>(iterator: AsyncIterable<T>): Promise<T[]> {
	const values: T[] = [];
	for await (const value of iterator)
		values.push(value);
	return values;
}

after(async () => {
	await Promise.all(temporaryDirectories.map((directory) => removeDirectory(directory, { recursive: true, force: true })));
});

void test("Logger forwards every event and supports partial sinks", () => {
	const logger = new Logger();
	const events: unknown[][] = [];
	logger.attach({
		taskStart: (...args) => events.push(["taskStart", ...args]),
		taskEnd: (...args) => events.push(["taskEnd", ...args]),
		error: (...args) => events.push(["error", ...args]),
		warning: (...args) => events.push(["warning", ...args]),
		info: (...args) => events.push(["info", ...args]),
		verbose: (...args) => events.push(["verbose", ...args]),
		debug: (...args) => events.push(["debug", ...args]),
	});

	assert.equal(logger.attach({}), logger);
	logger.taskStart("build");
	logger.taskEnd("build", 12.5);
	logger.error("failed", { retry: false });
	logger.warning("slow");
	logger.info("ready");
	logger.verbose("operation");
	logger.debug("details");

	assert.deepEqual(events, [
		["taskStart", "build"],
		["taskEnd", "build", 12.5],
		["error", "failed", { retry: false }],
		["warning", "slow"],
		["info", "ready"],
		["verbose", "operation"],
		["debug", "details"],
	]);
});

void test("TaskRunner task reports completion when the task succeeds or fails", async t => {
	const events: string[] = [];
	const onStart = (name: string) => { events.push(`start:${name}`); };
	const onEnd = (name: string) => { events.push(`end:${name}`); };
	logger.attach({ taskStart: onStart, taskEnd: onEnd });
	t.after(() => { logger.off("taskStart", onStart); logger.off("taskEnd", onEnd); });
	const runner = new TaskRunner();

	await runner.run(runner.task("success", () => { events.push("work"); }));
	await assert.rejects(runner.run(runner.task("failure", () => { throw new Error("boom"); })), /boom/);

	assert.deepEqual(events, ["start:success", "work", "end:success", "start:failure", "end:failure"]);
});

void test("TaskRunner validates task declarations and runs series, parallel, and conditional tasks", async () => {
	const runner = new TaskRunner();
	await assert.rejects(async () => { runner.task("", () => {}) }, /displayName/);
	await assert.rejects(async () => { runner.task("task", undefined as never) }, /taskFn/);
	await assert.rejects(async () => { runner.series() }, /at least one task/);
	await assert.rejects(async () => { runner.parallel({ maxDop: 0 }, () => {}) }, /positive integer/);
	await assert.rejects(async () => { runner.conditional(true, undefined as never) }, /taskFn/);

	const ordered: string[] = [];
	await runner.series(() => { ordered.push("first"); }, () => { ordered.push("second"); })();
	assert.deepEqual(ordered, ["first", "second"]);

	let active = 0;
	let maximumActive = 0;
	await runner.parallel({ maxDop: 2 }, ...Array.from({ length: 5 }, () => async () => {
		active++;
		maximumActive = Math.max(maximumActive, active);
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
		active--;
	}))();
	assert.equal(maximumActive, 2);

	let ran;
	ran = false;
	await runner.conditional(false, () => { ran = true; })();
	assert.equal(ran, false);
	ran = false;
	await runner.conditional(true, () => { ran = true; })();
	assert.equal(ran, true);
	ran = false;
	await runner.conditional(() => false, () => { ran = true; })();
	assert.equal(ran, false);
	ran = false;
	await runner.conditional(() => true, () => { ran = true; })();
	assert.equal(ran, true);
});

void test("map transforms directories, names, extensions, and mapping functions", () => {
	const source = path.join("source", "entry.mts");
	assert.equal(map(source, "output/"), path.join("output", "entry.mts"));
	assert.equal(map(source, "output\\"), path.join("output", "entry.mts"));
	assert.equal(map(source, "output"), "output");
	assert.equal(map(source, () => "output/"), path.join("output", "entry.mts"));
	assert.equal(map(source, { base: "bundle.js" }), path.join("source", "bundle.js"));
	assert.equal(map(source, { dir: "output", prefix: "pre-", suffix: "-min", ext: ".js" }), path.join("output", "pre-entry-min.js"));
	assert.equal(map(source, (file) => `${file}.bak`), `${source}.bak`);
});

void test("glob includes absolute files, honors exclusions, and resolve maps multiple sources", async () => {
	const directory = await temporaryDirectory();
	await mkdir(path.join(directory, "nested"));
	await writeFile(path.join(directory, "one.txt"), "one");
	await writeFile(path.join(directory, "nested", "two.txt"), "two");
	await writeFile(path.join(directory, "nested", "skip.log"), "skip");

	const files = await collect(glob(["**/*", "!**/*.log"], { cwd: directory }));
	assert.deepEqual(files.sort(), [path.join(directory, "nested", "two.txt"), path.join(directory, "one.txt")].sort());

	const pattern = path.join(directory, "**", "*.txt");
	const destinations = await collect(resolve(pattern, `${path.join(directory, "output")}${path.sep}`));
	assert.deepEqual(destinations.sort(), [path.join(directory, "output", "one.txt"), path.join(directory, "output", "two.txt")].sort());
	await assert.rejects(collect(resolve(pattern, path.join(directory, "output"))), /must end/);
	const singleDest = path.join(directory, "renamed.txt");
	assert.deepEqual(await collect(resolve(path.join(directory, "one.txt"), singleDest)), [singleDest]);
});

void test("filesystem helpers create, copy, move, and remove matched files", async () => {
	const directory = await temporaryDirectory();
	const sourceDirectory = path.join(directory, "source");
	const copiedDirectory = path.join(directory, "copied");
	const movedDirectory = path.join(directory, "moved");
	await mkdir(sourceDirectory);
	await writeFile(path.join(sourceDirectory, "item.txt"), "payload");

	await cp(path.join(sourceDirectory, "*.txt"), copiedDirectory + path.sep);
	assert.equal(await readFile(path.join(copiedDirectory, "item.txt"), "utf8"), "payload");
	await mv(path.join(copiedDirectory, "*.txt"), movedDirectory + path.sep);
	assert.equal(await readFile(path.join(movedDirectory, "item.txt"), "utf8"), "payload");
	await rmdir(movedDirectory);
	await assert.rejects(stat(movedDirectory));
});

void test("cp maps destination filenames and validates collisions before creating outputs", async () => {
	const directory = await temporaryDirectory();
	const source = path.join(directory, "source.txt");
	await writeFile(source, "payload");
	const renamed = path.join(directory, "nested", "renamed.txt");
	await cp(source, renamed);
	assert.equal(await readFile(renamed, "utf8"), "payload");
	await cp(source, { dir: path.join(directory, "mapped"), base: "versioned.txt" });
	assert.equal(await readFile(path.join(directory, "mapped/versioned.txt"), "utf8"), "payload");
	const collision = path.join(directory, "collision", "same.txt");
	await assert.rejects(cp([source, renamed], () => collision), /Destination collision/);
	await assert.rejects(stat(path.dirname(collision)), { code: "ENOENT" });
	await assert.rejects(cp([source, renamed], collision), /Destination collision/);
	await assert.rejects(mv([source, renamed], collision), /Destination collision/);
	assert.equal(await readFile(source, "utf8"), "payload");
	const moved = path.join(directory, "moved", "exact");
	await mv(renamed, moved);
	assert.equal(await readFile(moved, "utf8"), "payload");
	await assert.rejects(stat(renamed), { code: "ENOENT" });
	await mv(moved, { dir: path.join(directory, "mapped"), base: "moved.txt" });
	assert.equal(await readFile(path.join(directory, "mapped/moved.txt"), "utf8"), "payload");
});

void test("rm and rmdir validate all matches before deleting and preserve link targets", async () => {
	const directory = await temporaryDirectory();
	const file = path.join(directory, "file.txt");
	const folder = path.join(directory, "folder");
	const nested = path.join(folder, "nested.txt");
	await mkdir(folder);
	await writeFile(file, "file");
	await writeFile(nested, "nested");
	await assert.rejects(rm([file, folder]), /rm requires a file/);
	await assert.rejects(rmdir([folder, file]), /rmdir requires a directory/);
	assert.equal(await readFile(file, "utf8"), "file");
	assert.equal(await readFile(nested, "utf8"), "nested");
	const link = path.join(directory, "link");
	await symlink(folder, link, process.platform === "win32" ? "junction" : "dir");
	await assert.rejects(rmdir(link), /rmdir requires a directory/);
	await rm(link);
	assert.equal(await readFile(nested, "utf8"), "nested");
	await rm(path.join(directory, "*.txt"));
	await assert.rejects(stat(file), { code: "ENOENT" });
	await rmdir(path.join(directory, "fold*"));
	await assert.rejects(stat(folder), { code: "ENOENT" });
	await rm(path.join(directory, "missing*"));
	await rmdir(path.join(directory, "missing*"));
	assert.equal(sip.rmdir, rmdir);
});

void test("overlapping cleanup tasks tolerate missing files and directories", async () => {
	const directory = await temporaryDirectory();
	const files = Array.from({ length: 40 }, (_, i) => path.join(directory, `${i}.txt`));
	assert.ok(files[0]);
	await Promise.all(files.map(file => writeFile(file, "data")));
	await Promise.all([rm(files), rm(files[0]), rm(path.join(directory, "*.txt"))]);
	await rm(files[0]);
	const folders = Array.from({ length: 10 }, (_, i) => path.join(directory, `folder-${i}`));
	assert.ok(folders[0]);
	await Promise.all(folders.map(async folder => {
		await mkdir(folder);
		await writeFile(path.join(folder, "nested.txt"), "data");
	}));
	await Promise.all([rmdir(folders), rmdir(folders[0]), rmdir(path.join(directory, "folder-*"))]);
	await rmdir(folders[0]);
	assert.deepEqual(await collect(glob(path.join(directory, "*"), { onlyFiles: false })), []);
});

void test("make allowEmpty skips only when sources are absent", async () => {
	const directory = await temporaryDirectory();
	const runner = new TaskRunner();
	let calls = 0;
	const spec = { cwd: directory, src: "optional.txt", dest: "out.txt" };
	const executor = () => { calls++; };
	await assert.rejects(runner.run(make(spec, executor)), /make found no source files/);
	await assert.rejects(runner.run(make({ ...spec, allowEmpty: false }, executor)), /make found no source files/);
	const optional = make({ ...spec, allowEmpty: true }, executor);
	await runner.run(optional);
	assert.equal(calls, 0);
	await writeFile(path.join(directory, "optional.txt"), "source");
	await runner.run(optional);
	assert.equal(calls, 1);
});

void test("filesystem options resolve cwd and protect existing destinations", async () => {
	const cwd = await temporaryDirectory();
	const originalCwd = process.cwd();
	assert.equal(sip.mkdir, mkdir);
	assert.equal("md" in sip, false);
	await mkdir("inputs", { cwd });
	await writeFile(path.join(cwd, "inputs/a.txt"), "new");
	await writeFile(path.join(cwd, "inputs/b.txt"), "second");
	await cp("inputs/a.txt", "out/a.txt", { cwd, overwrite: false });
	await writeFile(path.join(cwd, "out/a.txt"), "old");
	for (const operation of [cp, mv]) {
		await assert.rejects(operation("inputs/*.txt", "out/", { cwd, overwrite: false }), { code: "EEXIST" });
		assert.equal(await readFile(path.join(cwd, "out/a.txt"), "utf8"), "old");
		await assert.rejects(stat(path.join(cwd, "out/b.txt")), { code: "ENOENT" });
	}
	await cp("inputs/a.txt", "out/a.txt", { cwd });
	assert.equal(await readFile(path.join(cwd, "out/a.txt"), "utf8"), "new");
	await mv("inputs/b.txt", "moved/b.txt", { cwd, overwrite: false });
	assert.equal(await readFile(path.join(cwd, "moved/b.txt"), "utf8"), "second");
	await assert.rejects(stat(path.join(cwd, "inputs/b.txt")), { code: "ENOENT" });
	await mv("inputs/a.txt", "out/a.txt", { cwd, overwrite: true });
	await rm("out/*.txt", { cwd });
	await rmdir(["out/", "inputs/", "moved/"], { cwd });
	assert.deepEqual(await collect(glob("*", { cwd, onlyFiles: false })), []);
	assert.equal(process.cwd(), originalCwd);
});

void test("make force marks current outputs changed without bypassing source requirements", async () => {
	const cwd = await temporaryDirectory();
	await writeFile(path.join(cwd, "input.txt"), "input");
	await writeFile(path.join(cwd, "output.txt"), "output");
	const future = new Date(Date.now() + 2_000);
	await utimes(path.join(cwd, "output.txt"), future, future);
	const runner = new TaskRunner();
	let calls = 0;
	const spec = { cwd, src: "input.txt", dest: "output.txt", force: true };
	const forced = make(spec, ({ resolved }) => { assert.equal(resolved[0]?.changed, true); calls++; });
	await runner.run(forced);
	await runner.run(forced);
	assert.equal(calls, 2);
	await assert.rejects(runner.run(make({ ...spec, src: "absent" }, () => {})), /make found no source files/);
	await runner.run(make({ ...spec, src: "absent", allowEmpty: true }, () => assert.fail("Must skip")));
});

void test("make runs for a missing or stale destination but skips an up-to-date destination", async () => {
	const directory = await temporaryDirectory();
	const source = path.join(directory, "source.txt");
	const destination = path.join(directory, "destination.txt");
	await writeFile(source, "source");
	let executions = 0;
	const runner = new TaskRunner();
	const build = make({ src: source, dest: destination }, async function () {
		assert.equal(this, runner);
		executions++;
		await nodeCp(source, destination);
	});

	await runner.run(build);
	await runner.run(build);
	const future = new Date(Date.now() + 2_000);
	await utimes(source, future, future);
	await runner.run(build);

	assert.equal(executions, 2);
	assert.throws(() => make({ src: "", dest: destination }, () => {}), /requires src/);
});

void test("make resolves cwd and mapped destinations, tracks changed files and dependencies", async t => {
	const directory = await temporaryDirectory();
	await mkdir(path.join(directory, "src"));
	await mkdir(path.join(directory, "out"));
	await writeFile(path.join(directory, "src/a.txt"), "a");
	await writeFile(path.join(directory, "src/b.txt"), "b");
	const dependency = path.join(directory, "settings.json");
	await writeFile(dependency, "{}");
	const past = new Date(Date.now() - 2_000);
	for (const file of [dependency, path.join(directory, "src/a.txt"), path.join(directory, "src/b.txt")])
		await utimes(file, past, past);
	const changed: string[][] = [];
	const runner = new TaskRunner();
	const diagnostics: { message: string; details: any }[] = [];
	const onDebug = (message: string, details: any) => { diagnostics.push({ message, details }); };
	const verbose: string[] = [];
	const onVerbose = (message: string) => { verbose.push(message); };
	logger.on("debug", onDebug);
	logger.on("verbose", onVerbose);
	t.after(() => { logger.off("debug", onDebug); logger.off("verbose", onVerbose); });
	const build = make({
		cwd: directory, src: "src/*.txt", dest: src => map(src, { dir: "out", suffix: "-copy" }), deps: "settings.json",
	}, async function ({ cwd, resolved }) {
		assert.equal(this, runner);
		assert.equal(cwd, directory);
		assert.equal(resolved.length, 2);
		changed.push(resolved.filter(file => file.changed).map(file => path.basename(file.src)).sort());
		for (const file of resolved.filter(file => file.changed)) {
			assert.equal(file.dest, path.join(directory, "out", `${path.parse(file.src).name}-copy.txt`));
			await nodeCp(file.src, file.dest);
		}
	});
	await runner.run(build);
	await runner.run(build);
	await removeDirectory(path.join(directory, "out/a-copy.txt"));
	await runner.run(build);
	const future = new Date(Date.now() + 2_000);
	await utimes(dependency, future, future);
	await runner.run(build);
	assert.deepEqual(changed, [["a.txt", "b.txt"], ["a.txt"], ["a.txt", "b.txt"]]);
	assert.ok(verbose.includes(`make: ${path.join(directory, "out/a-copy.txt")} (skipped, up to date)`));
	assert.ok(verbose.includes(`make: ${path.join(directory, "out/b-copy.txt")} (skipped, up to date)`));
	assert.ok(diagnostics.some(({ message }) => message.includes("destination missing")));
	assert.ok(diagnostics.some(({ message }) => message === "make: skipping executor (0/2 changed)"));
	const dependencyRebuild = diagnostics.find(({ message }) => message.includes("dependency newer than destination"));
	assert.equal(dependencyRebuild?.details.newestDependency, dependency);
	assert.ok(dependencyRebuild.details.dependencyMtimeMs > dependencyRebuild.details.destinationMtimeMs);
	await assert.rejects(runner.run(make({ cwd: directory, src: "missing.txt", dest: "out.txt" }, () => {
		assert.fail("Missing sources must not invoke the executor");
	})), /make found no source files/);
});

void test("the public entry point exposes the default task helpers", () => {
	assert.ok(sip.logger instanceof Logger);
	assert.equal(sip.runner.logger, sip.logger);
	assert.equal(typeof sip.task, "function");
	assert.equal(typeof sip.series, "function");
	assert.equal(typeof sip.parallel, "function");
	assert.equal(typeof sip.conditional, "function");
	assert.equal(typeof sip.make, "function");
});

void test("CLI loads the selected task, applies environment settings, and filters sink output", async () => {
	const directory = await temporaryDirectory();
	const taskFile = path.join(directory, "task.mjs");
	const importPath = pathToFileURL(path.resolve(`${process.cwd()}/src/index.mts`)).href;
	await writeFile(taskFile, `
    import { logger, vars } from "${importPath}";
	export async function selected() {
      logger.info(\`setting:\${vars.SIP_TEST_VALUE}\`);
      logger.debug('hidden');
    }`);
	const output: unknown[][] = [];
	const originalLog = console.log;
	const originalDebug = console.debug;
	console.log = (...args: unknown[]) => { output.push(args); };
	console.debug = (...args: unknown[]) => { output.push(["debug", ...args]); };
	try {
		await main(["selected", "--file", taskFile, "--no-timestamp", "--logger", "simple", "--loglevel", "normal", "--set", "SIP_TEST_VALUE=present"]);
		assert.deepEqual(output, [["setting:present"]]);
		await assert.rejects(main(["--file", taskFile, "--loglevel", "invalid"]), /Invalid log level/);
		await assert.rejects(main(["--file", taskFile, "missing"]), /Task not found/);
	} finally {
		console.log = originalLog;
		console.debug = originalDebug;
	}
});

void test("parallel drains active tasks and skips queued tasks after failure", async () => {
	const runner = new TaskRunner();
	const release = Promise.withResolvers<undefined>();
	const started = Promise.withResolvers<undefined>();
	const failure = new Error("first failure");
	const events: string[] = [];
	let settled = false;
	const execution = runner.run(runner.parallel({ maxDop: 2 },
		async () => { await started.promise; throw failure; },
		async () => {
			started.resolve(undefined);
			await release.promise;
			events.push("active finished");
			throw new Error("second failure");
		},
		() => { events.push("queued started"); },
	));
	const checked = assert.rejects(execution, (error) => {
		settled = true;
		assert.equal(error, failure);
		assert.deepEqual(events, ["active finished"]);
		return true;
	});
	await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
	const settledBeforeRelease = settled;
	release.resolve(undefined);
	await checked;
	assert.equal(settledBeforeRelease, false);

	// State belongs to an invocation, including when a task throws undefined.
	const retry = runner.parallel({ maxDop: 1 }, () => { throw undefined; });
	for (let i = 0; i < 2; i++) {
		await assert.rejects(async () => { await retry(); }, (error) => error === undefined);
	}
});

void test("runner package subpath resolves to the public runner", async () => {
	const exported = await import("@foresoft/sip/runner");
	const entry = await import("@foresoft/sip");
	assert.ok(entry.runner instanceof exported.TaskRunner);
});

void test("CLI import is inert and executable reports success and failures", async () => {
	const directory = await temporaryDirectory();
	const cliPath = path.resolve("src/cli.mts");
	const cliUrl = pathToFileURL(cliPath).href;
	const imported = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(cliUrl)})`], { cwd: directory, encoding: "utf8" });
	assert.equal(imported.status, 0, imported.stderr);
	assert.equal(imported.stdout, "");
	assert.equal(imported.stderr, "");
	const taskFile = path.join(directory, "task.mjs");
	await writeFile(taskFile, `
    export default function () { console.log('executed'); }
    export function failure() { throw new Error('task exploded'); }
  `);
	const invoke = (...args: string[]) => spawnSync(process.execPath, [cliPath, "--file", taskFile, ...args], { cwd: directory, encoding: "utf8" });
	const success = invoke();
	assert.equal(success.status, 0, success.stderr);
	assert.equal(success.stdout.trim(), "executed");
	for (const [args, message] of [
		[["failure"], "task exploded"],
		[["missing"], "Task not found"],
		[["--file", path.join(directory, "absent.mts")], "Task file not found"],
		[["--loglevel", "invalid"], "Invalid log level"],
		[["failure", "--loglevel", "quiet"], "task exploded"],
	] as [string[], string][]) {
		const result = invoke(...args);
		assert.equal(result.status, 1, result.stderr);
		assert.ok(result.stderr.includes(message), result.stderr);
		assert.equal(result.stderr.split(message).length - 1, 1);
	}
});

void test("CLI detaches only its own listeners after success and failures", async () => {
	const directory = await temporaryDirectory();
	const taskFile = path.join(directory, "task.mjs");
	const importPath = pathToFileURL(path.resolve("src/index.mts")).href;
	await writeFile(taskFile, `
    import { logger } from ${JSON.stringify(importPath)};
    export default function () { logger.info('info'); logger.verbose('verbose'); logger.debug('debug'); logger.error('error'); }
    export function failure() { throw new Error('failure'); }
  `);
	const output: string[] = [];
	const external: unknown[] = [];
	const listener = (message: unknown) => { external.push(message); };
	sip.logger.on("info", listener);
	const events = ["taskStart", "taskEnd", "error", "warning", "info", "verbose", "debug"];
	const listeners = () => events.map((event) => sip.logger.listeners(event));
	const baseline = listeners();
	const original = { log: console.log, debug: console.debug, error: console.error };
	console.log = (message) => { output.push(String(message)); };
	console.debug = (message) => { output.push(String(message)); };
	console.error = (message) => { output.push(String(message)); };
	try {
		for (const [level, expected] of [
			["debug", ["info", "verbose", "debug", "error"]],
			["verbose", ["info", "verbose", "error"]],
			["normal", ["info", "error"]],
			["quiet", []],
		] as [string, string[]][]) {
			output.length = 0;
			await main(["--file", taskFile, "--loglevel", level, "--no-timestamp"]);
			assert.deepEqual(output, expected);
			assert.deepEqual(listeners(), baseline);
		}
		assert.deepEqual(external, ["info", "info", "info", "info"]);
		await assert.rejects(main(["--file", taskFile, "failure"]), /failure/);
		assert.deepEqual(listeners(), baseline);
		await assert.rejects(main(["--file", path.join(directory, "absent.mts")]), /Task file not found/);
		assert.deepEqual(listeners(), baseline);
	} finally {
		console.log = original.log;
		console.debug = original.debug;
		console.error = original.error;
		sip.logger.off("info", listener);
	}
});
