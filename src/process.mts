import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { logger } from "./logger.mts";

export type ProcessOptions = {
	/** Working directory for the child; never changes the calling process's directory. */
	cwd?: string;
	/** Overrides merged into the current environment. Undefined removes a variable. */
	env?: NodeJS.ProcessEnv;
	/** Forward output (default) or discard it. Worker mode has no interactive stdin. */
	stdio?: "inherit" | "ignore";
	signal?: AbortSignal;
};

export type NodeOptions = ProcessOptions & {
	/** Run a script in a fresh worker instead of a child process. Requires the current cwd. */
	worker?: boolean;
};

/** A command started successfully but exited with a failure code or signal. */
export class ProcessError extends Error {
	readonly command: string;
	readonly exitCode: number | null;
	readonly signal: NodeJS.Signals | null;

	constructor(command: string, exitCode: number | null, signal: NodeJS.Signals | null = null) {
		super(`${command} failed (${signal ?? `exit code ${exitCode}`})`);
		this.name = "ProcessError";
		this.command = command;
		this.exitCode = exitCode;
		this.signal = signal;
	}
}

function validate(args: readonly string[], options: ProcessOptions): void {
	assert.ok(Array.isArray(args) && args.every(arg => typeof arg === "string" && !arg.includes("\0")), "args must be an array of strings without null bytes");
	assert.ok(options.cwd === undefined || (typeof options.cwd === "string" && options.cwd.length > 0), "cwd must be a non-empty string");
	assert.ok([undefined, "inherit", "ignore"].includes(options.stdio), "stdio must be inherit or ignore");
	options.signal?.throwIfAborted();
}

function environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const result = { ...process.env };
	for (const [key, value] of Object.entries(overrides)) {
		// Windows environment keys are case insensitive, even when the caller uses a plain object.
		if (process.platform === "win32") {
			for (const existing of Object.keys(result)) {
				if (existing.toLowerCase() === key.toLowerCase()) delete result[existing];
			}
		}
		if (value === undefined) delete result[key];
		else result[key] = value;
	}
	return result;
}

function variable(env: NodeJS.ProcessEnv, key: string): string | undefined {
	const actual = process.platform === "win32"
		? Object.keys(env).find(candidate => candidate.toLowerCase() === key.toLowerCase())
		: key;
	return actual === undefined ? undefined : env[actual];
}

async function run(command: string, executable: string, args: readonly string[], options: ProcessOptions): Promise<void> {
	validate(args, options);
	logger.verbose(`${command}: starting`);
	await new Promise<void>((resolve, reject) => {
		const child = spawn(executable, args, {
			cwd: options.cwd,
			env: environment(options.env),
			stdio: options.stdio ?? "inherit",
			windowsHide: true,
			signal: options.signal,
			shell: false,
		});
		// Wait for close even after an error/abort so the command has actually stopped.
		let failure: Error | undefined;
		child.once("error", error => { failure = error; });
		child.once("close", (code, signal) => {
			if (failure) reject(failure);
			else if (code !== 0) reject(new ProcessError(command, code, signal));
			else resolve();
		});
	});
}

async function runWorker(args: readonly string[], options: NodeOptions): Promise<void> {
	const [script, ...argv] = args;
	assert.ok(script && !script.startsWith("-"), "worker mode requires a script path followed by its arguments, without Node CLI flags");
	const cwd = await realpath(options.cwd ?? process.cwd());
	assert.equal(cwd, await realpath(process.cwd()), "worker mode cannot change cwd; use a child process instead");
	options.signal?.throwIfAborted();
	logger.verbose("node: starting worker");
	await new Promise<void>((resolve, reject) => {
		const file = path.resolve(cwd, script);
		// Execute the actual entry point so require.main/import.meta.main work.
		// Omit execArgv: Node handles inherited process-only flags, permission
		// settings, and loaders differently from explicitly supplied flags.
		const worker = new Worker(file, {
			argv,
			env: environment(options.env),
			stdout: options.stdio === "ignore",
			stderr: options.stdio === "ignore",
		});
		if (options.stdio === "ignore") {
			worker.stdout.resume();
			worker.stderr.resume();
		}
		let failure: unknown;
		let failed = false;
		const abort = () => {
			failed = true;
			failure = options.signal?.reason;
			void worker.terminate();
		};
		options.signal?.addEventListener("abort", abort, { once: true });
		worker.once("error", error => { failed = true; failure = error; });
		worker.once("exit", code => {
			options.signal?.removeEventListener("abort", abort);
			if (failed) reject(failure);
			else if (code !== 0) reject(new ProcessError("node", code));
			else resolve();
		});
	});
}

/** Run the current Node executable with literal arguments; rejects unsuccessful exits. */
export async function node(args: readonly string[], options: NodeOptions = {}): Promise<void> {
	validate(args, options);
	assert.ok(args.length > 0, "node requires a script path or Node CLI arguments");
	assert.ok(options.worker === undefined || typeof options.worker === "boolean", "worker must be a boolean");
	if (options.worker) await runWorker(args, options);
	else await run("node", process.execPath, args, options);
}

async function isFile(file: string): Promise<boolean> {
	try { return (await stat(file)).isFile(); }
	catch (error) {
		if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
		throw error;
	}
}

async function npmCli(name: "npm" | "npx", options: ProcessOptions): Promise<string> {
	const env = environment(options.env);
	const cwd = path.resolve(options.cwd ?? process.cwd());
	const cliName = `${name}-cli.js`;
	const activeNpm = variable(env, "npm_execpath");
	if (activeNpm && path.basename(activeNpm).toLowerCase() === "npm-cli.js") {
		const candidate = path.resolve(cwd, path.dirname(activeNpm), cliName);
		if (await isFile(candidate)) return candidate;
	}
	for (const directory of (variable(env, "PATH") ?? "").split(path.delimiter).filter(Boolean)) {
		const base = path.resolve(cwd, directory.replace(/^"(.*)"$/, "$1"));
		// Unix installs commonly expose npm/npx as symlinks to their JavaScript CLIs.
		try {
			const target = await realpath(path.join(base, name));
			if (path.basename(target) === cliName && await isFile(target)) return target;
		} catch (error) {
			if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
		}
		const candidate = path.join(base, "node_modules", "npm", "bin", cliName);
		if (await isFile(candidate)) return candidate;
	}
	const nodeDirectory = path.dirname(process.execPath);
	for (const candidate of [
		path.join(nodeDirectory, "node_modules", "npm", "bin", cliName),
		path.resolve(nodeDirectory, "../lib/node_modules/npm/bin", cliName),
	]) {
		if (await isFile(candidate)) return candidate;
	}
	throw new Error(`Cannot locate ${cliName}. Install npm alongside Node.js or run sip through npm.`);
}

/** Run npm's CLI using the current Node executable, without a shell wrapper. */
export async function npm(args: readonly string[], options: ProcessOptions = {}): Promise<void> {
	validate(args, options);
	await run("npm", process.execPath, [await npmCli("npm", options), ...args], options);
}

/** Run npx with its normal local-package, download, and prompt behavior. */
export async function npx(args: readonly string[], options: ProcessOptions = {}): Promise<void> {
	validate(args, options);
	assert.ok(args.length > 0, "npx requires arguments");
	await run("npx", process.execPath, [await npmCli("npx", options), ...args], options);
}
