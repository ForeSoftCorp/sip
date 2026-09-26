import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { after, test } from "node:test";
import { cp as nodeCp, mkdtemp, readFile, rm as removeDirectory, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { main } from "../src/cli.ts";
import { cp, md, mv, rm } from "../src/fs.ts";
import { Logger } from "../src/logger.ts";
import { make } from "../src/make.ts";
import { TaskRunner } from "../src/runner.ts";
import { glob, map, resolve } from "../src/utils.ts";
import * as sip from "../src/index.ts";
import { pathToFileURL } from "node:url";

const temporaryDirectories: string[] = [];

void test("task IDs isolate parallel logs, inherit through unnamed tasks, and restore after nested failure", async () => {
  const logger = new Logger();
  const runner = new TaskRunner(logger);
  const events: [number | undefined, string][] = [];
  const record = (message: unknown) => { events.push([logger.taskId, String(message)]); };
  logger.attach({ taskStart: record, taskEnd: record, info: record, warning: record, error: record, debug: record });
  const stylesFinished = Promise.withResolvers<void>();
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
      stylesFinished.resolve();
    }),
  ));
  logger.info("outside");
  assert.deepEqual(events.filter(([, message]) => !["Build", "Styles", "Nested"].includes(message)), [
    [2, "styling"], [1, "compiling"], [3, "nested error"], [1, "parent resumed"], [undefined, "outside"],
  ]);
  for (const [name, id] of [["Build", 1], ["Styles", 2], ["Nested", 3]] as const) {
    assert.deepEqual(events.filter(([, message]) => message === name), [[id, name], [id, name]]);
  }
  const repeated = runner.task("Repeat", () => {});
  await runner.run(repeated);
  await new TaskRunner(logger).run(repeated);
  assert.deepEqual(events.slice(-4), [[4, "Repeat"], [4, "Repeat"], [5, "Repeat"], [5, "Repeat"]]);
  assert.equal(logger.taskId, undefined);
});

void test("console sinks prefix task messages with compact numeric IDs", async () => {
  const directory = await temporaryDirectory();
  const taskFile = path.join(directory, "task.mjs");
  const importPath = pathToFileURL(path.resolve("src/index.ts")).href;
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
    const result = spawnSync(process.execPath, [path.resolve("src/cli.ts"), "--file", taskFile,
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
    if (kind === "devops") assert.match(stderr, /##vso\[task.logissue type=error\]1> error/);
  }
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sip-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function collect<T>(iterator: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterator) values.push(value);
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
    debug: (...args) => events.push(["debug", ...args]),
  });

  assert.equal(logger.attach({}), logger);
  logger.taskStart("build");
  logger.taskEnd("build", 12.5);
  logger.error("failed", { retry: false });
  logger.warning("slow");
  logger.info("ready");
  logger.debug("details");

  assert.deepEqual(events, [
    ["taskStart", "build"],
    ["taskEnd", "build", 12.5],
    ["error", "failed", { retry: false }],
    ["warning", "slow"],
    ["info", "ready"],
    ["debug", "details"],
  ]);
});

void test("TaskRunner task reports completion when the task succeeds or fails", async () => {
  const events: string[] = [];
  const logger = new Logger().attach({
    taskStart: (name) => events.push(`start:${name}`),
    taskEnd: (name) => events.push(`end:${name}`),
  });
  const runner = new TaskRunner(logger);

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
  const source = path.join("source", "entry.ts");
  assert.equal(map(source, "output"), path.join("output", "entry.ts"));
  assert.equal(map(source, { base: "bundle.js" }), path.join("source", "bundle.js"));
  assert.equal(map(source, { dir: "output", prefix: "pre-", suffix: "-min", ext: ".js" }), path.join("output", "pre-entry-min.js"));
  assert.equal(map(source, (file) => `${file}.bak`), `${source}.bak`);
});

void test("glob includes absolute files, honors exclusions, and resolve maps multiple sources", async () => {
  const directory = await temporaryDirectory();
  await md(path.join(directory, "nested"));
  await writeFile(path.join(directory, "one.txt"), "one");
  await writeFile(path.join(directory, "nested", "two.txt"), "two");
  await writeFile(path.join(directory, "nested", "skip.log"), "skip");

  const files = await collect(glob(["**/*", "!**/*.log"], { cwd: directory }));
  assert.deepEqual(files.sort(), [path.join(directory, "nested", "two.txt"), path.join(directory, "one.txt")].sort());

  const pattern = path.join(directory, "**", "*.txt");
  const destinations = await collect(resolve(pattern, `${path.join(directory, "output")}${path.sep}`));
  assert.deepEqual(destinations.sort(), [path.join(directory, "output", "one.txt"), path.join(directory, "output", "two.txt")].sort());
  await assert.rejects(collect(resolve(pattern, path.join(directory, "output"))), /must end/);
});

void test("filesystem helpers create, copy, move, and remove matched files", async () => {
  const directory = await temporaryDirectory();
  const sourceDirectory = path.join(directory, "source");
  const copiedDirectory = path.join(directory, "copied");
  const movedDirectory = path.join(directory, "moved");
  await md(sourceDirectory);
  await writeFile(path.join(sourceDirectory, "item.txt"), "payload");

  await cp(path.join(sourceDirectory, "*.txt"), copiedDirectory);
  assert.equal(await readFile(path.join(copiedDirectory, "item.txt"), "utf8"), "payload");
  await mv(path.join(copiedDirectory, "*.txt"), movedDirectory);
  assert.equal(await readFile(path.join(movedDirectory, "item.txt"), "utf8"), "payload");
  await rm(movedDirectory);
  await assert.rejects(stat(movedDirectory));
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
  const importPath = pathToFileURL(path.resolve(`${process.cwd()}/src/index.ts`)).href;
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
  const release = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const failure = new Error("first failure");
  const events: string[] = [];
  let settled = false;
  const execution = runner.run(runner.parallel({ maxDop: 2 },
    async () => { await started.promise; throw failure; },
    async () => {
      started.resolve();
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
  release.resolve();
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
  assert.equal(exported.TaskRunner, TaskRunner);
});

void test("CLI import is inert and executable reports success and failures", async () => {
  const directory = await temporaryDirectory();
  const cliPath = path.resolve("src/cli.ts");
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
    [["--file", path.join(directory, "absent.ts")], "Task file not found"],
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
  const importPath = pathToFileURL(path.resolve("src/index.ts")).href;
  await writeFile(taskFile, `
    import { logger } from ${JSON.stringify(importPath)};
    export default function () { logger.info('info'); logger.debug('debug'); logger.error('error'); }
    export function failure() { throw new Error('failure'); }
  `);
  const output: string[] = [];
  const external: unknown[] = [];
  const listener = (message: unknown) => { external.push(message); };
  sip.logger.on("info", listener);
  const events = ["taskStart", "taskEnd", "error", "warning", "info", "debug"];
  const listeners = () => events.map((event) => sip.logger.listeners(event));
  const baseline = listeners();
  const original = { log: console.log, debug: console.debug, error: console.error };
  console.log = (message) => { output.push(String(message)); };
  console.debug = (message) => { output.push(String(message)); };
  console.error = (message) => { output.push(String(message)); };
  try {
    for (const [level, expected] of [
      ["debug", ["info", "debug", "error"]],
      ["normal", ["info", "error"]],
      ["quiet", []],
    ] as [string, string[]][]) {
      output.length = 0;
      await main(["--file", taskFile, "--loglevel", level, "--no-timestamp"]);
      assert.deepEqual(output, expected);
      assert.deepEqual(listeners(), baseline);
    }
    assert.deepEqual(external, ["info", "info", "info"]);
    await assert.rejects(main(["--file", taskFile, "failure"]), /failure/);
    assert.deepEqual(listeners(), baseline);
    await assert.rejects(main(["--file", path.join(directory, "absent.ts")]), /Task file not found/);
    assert.deepEqual(listeners(), baseline);
  } finally {
    console.log = original.log;
    console.debug = original.debug;
    console.error = original.error;
    sip.logger.off("info", listener);
  }
});
