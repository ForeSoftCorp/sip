import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import type { BuildOptions, LogOrStringHandler, RolldownOptions } from "rolldown";
import { logger } from "./logger.mts";

export type RolldownOptionsWithConfig = Omit<BuildOptions, "onwarn"> & {
	/** Base directory for src, dest, configPath, and Rolldown options. Defaults to process.cwd(). */
	cwd?: string;
	/** Load a single Rolldown configuration before applying explicit options. */
	configPath?: string;
};

/** Bundle an entry file immediately. Explicit options override config; src and dest always win. */
export async function rolldown(src: string, dest: string, options: RolldownOptionsWithConfig = {}): Promise<void> {
	assert.ok(typeof src === "string" && src.length > 0, "rolldown requires an entry file");
	assert.ok(typeof dest === "string" && dest.length > 0, "rolldown requires a destination file");
	assert.ok(options.cwd === undefined || (typeof options.cwd === "string" && options.cwd.length > 0), "cwd must be a non-empty string");
	assert.ok(options.configPath === undefined || (typeof options.configPath === "string" && options.configPath.length > 0), "configPath must be a non-empty string");
	const { configPath, cwd: baseDirectory, ...overrides } = options;
	const cwd = path.resolve(baseDirectory ?? process.cwd());
	const input = path.resolve(cwd, src);
	const file = path.resolve(cwd, dest);
	let config: RolldownOptions = {};
	if (configPath !== undefined) {
		const { loadConfig } = await import("rolldown/config");
		const loaded = await loadConfig(path.resolve(cwd, configPath));
		const resolved = typeof loaded === "function"
			? await loaded({ ...overrides, cwd, input, output: { ...overrides.output, file } })
			: loaded;
		assert.ok(resolved, "configPath must export a single Rolldown configuration");
		assert.ok(typeof resolved === "object" && !Array.isArray(resolved), "configPath must export a single Rolldown configuration");
		config = resolved;
	}
	assert.ok(!Array.isArray(config.output), "configPath must specify a single output");
	const merged = { ...config, ...overrides };
	assert.ok(!("onwarn" in merged), "onwarn is no longer supported; use onLog instead");
	const output = { ...config.output, ...overrides.output, file };
	// A destination file supersedes a directory supplied by the configuration.
	delete output.dir;

	const emit: LogOrStringHandler = (level, log) => {
		const message = typeof log === "string" ? log : log.message;
		if (level === "error")
			throw Object.assign(new Error(message), typeof log === "string" ? {} : log);
		const details = typeof log === "string" ? [] : [log];
		if (level === "warn")
			logger.warning(message);
		else if (level === "info")
			logger.info(message);
		else
			logger.debug(message, ...details);
		// Keep structured diagnostics out of normal console output, which already has the message.
		if (level !== "debug" && typeof log !== "string")
			logger.debug("rolldown: diagnostic", log);
	};
	const { build } = await import("rolldown");
	const buildOptions: BuildOptions = {
		...merged,
		cwd,
		input,
		output,
		// Let SIP's sinks filter messages, including debug logs, unless explicitly overridden.
		logLevel: merged.logLevel ?? "debug",
		onLog: AsyncLocalStorage.bind<NonNullable<BuildOptions["onLog"]>>((level, log) => {
			if (merged.onLog)
				merged.onLog(level, log, emit);
			else
				emit(level, log);
		}),
	};
	logger.verbose(`rolldown: ${file}`);
	logger.debug("rolldown: effective build options", buildOptions);
	await build(buildOptions);
}
