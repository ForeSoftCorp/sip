import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

void test("prebuilt package installs into node_modules with working exports, types, and CLI", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "sip-package-"));
	try {
		const npmPath = process.env["npm_execpath"];
		assert.ok(npmPath, "Run through npm run test:package");
		const packed = JSON.parse(execFileSync(process.execPath, [npmPath,
			"pack", "--json", "--ignore-scripts", "--cache", path.join(directory, "cache"),
			"--pack-destination", directory], { encoding: "utf8" }));
		const archive = path.join(directory, path.basename(packed[0].filename));
		assert.ok(packed[0].files.every((file: { path: string }) => file.path.startsWith("dist/") || ["package.json", "README.md", "LICENSE"].includes(file.path)));
		await writeFile(path.join(directory, "package.json"), JSON.stringify({ private: true, type: "module" }));
		execFileSync(process.execPath, [npmPath, "install", archive,
			"--offline", "--ignore-scripts", "--omit=optional", "--no-audit", "--no-fund", "--cache", path.join(directory, "cache")],
		{ cwd: directory, encoding: "utf8" });
		const root = path.join(directory, "node_modules", "@foresoft", "sip");
		const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
		assert.equal(manifest.scripts.prepare, undefined);
		for (const dependency of Object.keys(manifest.peerDependencies))
			await assert.rejects(access(path.join(directory, "node_modules", dependency)), { code: "ENOENT" });
		for (const [subpath, target] of Object.entries(manifest.exports) as [string, { types: string; import: string }][]) {
			await access(path.join(root, target.types));
			const specifier = subpath === "." ? manifest.name : manifest.name + subpath.slice(1);
			const result = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(specifier)})`], { cwd: directory, encoding: "utf8" });
			assert.equal(result.status, 0, `${specifier}: ${result.stderr}`);
			assert.equal(result.stdout, "");
			assert.equal(result.stderr, "");
		}
		const help = spawnSync(process.execPath, [path.join(root, manifest.bin.sip), "--help"], { cwd: root, encoding: "utf8" });
		assert.equal(help.status, 0, help.stderr);
		assert.match(help.stdout, /Usage: sip/);
		await writeFile(path.join(directory, "taskfile.mts"), `
      import { task, logger, runner, node, npm, npx } from "@foresoft/sip";
      import { node as processNode } from "@foresoft/sip/process";
      import { TaskRunner } from "@foresoft/sip/runner";
      import { Logger, logger as sharedLogger } from "@foresoft/sip/logger";
      if (!(runner instanceof TaskRunner) || !(logger instanceof Logger)) throw new Error("Duplicate module instances");
      if (logger !== sharedLogger || new TaskRunner().logger !== sharedLogger) throw new Error("Logger is not shared");
      if (node !== processNode || typeof npm !== "function" || typeof npx !== "function") throw new Error("Missing process helpers");
      export default task("Smoke", async () => {
        await node(["--version"], { stdio: "ignore" });
        await node(["./worker.mjs"], { worker: true });
        logger.info("compiled package works");
      });
    `);
		await writeFile(path.join(directory, "worker.mjs"), "console.log('compiled worker works');");
		const run = spawnSync(process.execPath, [path.join(root, manifest.bin.sip), "--no-timestamp"], { cwd: directory, encoding: "utf8" });
		assert.equal(run.status, 0, run.stderr);
		assert.match(run.stdout, /compiled package works/);
		assert.match(run.stdout, /compiled worker works/);
		await writeFile(path.join(directory, "consumer.mts"), `
      import { logger, watch, node, npm, npx, type NodeOptions, type ProcessOptions, type WatchSpec, type TaskExecutor } from "@foresoft/sip";
      import { TaskRunner } from "@foresoft/sip/runner";
      const run: TaskExecutor = () => {};
      const specs: WatchSpec[] = [{ src: "*.mts", run }];
      new TaskRunner().run(watch(specs));
      const nodeOptions: NodeOptions = { worker: true };
      const processOptions: ProcessOptions = { cwd: ".", stdio: "ignore" };
      node(["script.mjs"], nodeOptions);
      npm(["run", "build"], processOptions);
      npx(["--no", "--", "tool"], processOptions);
      // @ts-expect-error Arguments must be an array, not a shell command string.
      node("script.mjs --flag");
      // @ts-expect-error Runners always use the shared logger and accept no constructor arguments.
      new TaskRunner(logger);
      // @ts-expect-error A numeric glob is not valid.
      watch([{ src: 42, run }]);
    `);
		// Supply only Node's declarations: core consumers must not need optional handler peers.
		for (const dependency of ["@types/node", "undici-types"])
			await cp(path.resolve("node_modules", dependency), path.join(directory, "node_modules", dependency), { recursive: true });
		await writeFile(path.join(directory, "tsconfig.json"), JSON.stringify({
			compilerOptions: { noEmit: true, strict: true, module: "nodenext", target: "esnext", skipLibCheck: false, types: ["node"] },
			include: ["consumer.mts"],
		}));
		const types = spawnSync(process.execPath, [path.resolve("node_modules/typescript/bin/tsc"), "-p", path.join(directory, "tsconfig.json")], { encoding: "utf8" });
		assert.equal(types.status, 0, types.stdout + types.stderr);

		// Exercise npm's Git-specific preparation rules with prebuilt files only.
		const repository = path.join(directory, "repository");
		const consumer = path.join(directory, "git-consumer");
		await mkdir(repository);
		await mkdir(consumer);
		await cp(path.join(root, "dist"), path.join(repository, "dist"), { recursive: true });
		await cp(path.join(root, "package.json"), path.join(repository, "package.json"));
		for (const args of [["init"], ["add", "."], ["-c", "user.name=Package Test", "-c", "user.email=package-test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "Prebuilt package fixture"]]) {
			execFileSync("git", args, { cwd: repository, encoding: "utf8", stdio: "pipe" });
		}
		await writeFile(path.join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
		execFileSync(process.execPath, [npmPath, "install", `git+${pathToFileURL(repository).href}`,
			"--offline", "--omit=optional", "--no-audit", "--no-fund", "--cache", path.join(directory, "git-cache")],
		{ cwd: consumer, encoding: "utf8" });
		const gitRun = spawnSync(process.execPath, ["--input-type=module", "-e", "import { runner, watch } from '@foresoft/sip'; if (!runner || typeof watch !== 'function') process.exit(1)"], { cwd: consumer, encoding: "utf8" });
		assert.equal(gitRun.status, 0, gitRun.stderr);
	} finally {
		// directory is the exact private temporary directory allocated above.
		await rm(directory, { recursive: true, force: true });
	}
});
