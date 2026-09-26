#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { runner, vars } from "./index.ts";
import type { Logger, LoggerSink } from "./logger.ts";

type ConsoleSinkKind = "simple" | "color" | "devops";
type LogLevel = "quiet" | "minimal" | "normal" | "verbose" | "debug";

interface ConsoleSinkOptions {
	loggerKind?: ConsoleSinkKind;
	level: LogLevel;
	timestamp: boolean;
	perf: boolean;
}

const rank: Record<LogLevel, number> = {
	quiet: 0,
	minimal: 1,
	normal: 2,
	verbose: 3,
	debug: 4
};

function printTimestamp({ timestamp }: Partial<ConsoleSinkOptions>) {
	/* print time part only if timestamp is true */
	return timestamp ? `[${new Date().toLocaleTimeString()}]` : "";
}

function printTaskId(logger: Logger): string {
	return logger.taskId === undefined ? "" : `${logger.taskId}> `;
}

function printTime(ms: number) {
	if(ms > 60 * 1000) return `${(ms / 1000 / 60).toFixed(1)}m`;
	if(ms > 1000) return `${(ms / 1000).toFixed(0)}s`;
	if(ms > 1) return `${ms.toFixed(1)}ms`;
	return `${ms.toFixed(3)}ms`;
}

/** Applies CLI log-level and performance settings to a sink. */
function configureSink(sink: LoggerSink, { level, perf }: ConsoleSinkOptions): LoggerSink {
	const enabled = (minimum: number) => rank[level] >= minimum;
	return {
		taskStart: enabled(1) ? (name) => sink.taskStart?.(name) : undefined,
		taskEnd: perf && enabled(1) ? (name, ms) => sink.taskEnd?.(name, ms) : undefined,
		error: (message, ...args) => { if (enabled(1)) sink.error?.(message, ...args); },
		warning: enabled(2) ? (message, ...args) => sink.warning?.(message, ...args) : undefined,
		info: enabled(2) ? (message, ...args) => sink.info?.(message, ...args) : undefined,
		debug: enabled(4) ? (message, ...args) => sink.debug?.(message, ...args) : undefined,
	};
}

/** Creates the plain-text console logger sink used by the CLI. */
function createSimpleConsoleSink({ timestamp }: ConsoleSinkOptions, logger: Logger): LoggerSink {
	const prefix = () => printTaskId(logger) + printTimestamp({ timestamp });
	return {
		taskStart: (n: string) => console.log(`${prefix()}Starting ${n} task`),
		taskEnd: (n: string, ms: number) => console.log(`${prefix()}Finished ${n} task in ${printTime(ms)}`),
		error: (m: string, ...a) => console.error(`${prefix()}${m}`, ...a),
		warning: (m: string, ...a) => console.warn(`${prefix()}${m}`, ...a),
		info: (m: string, ...a) => console.log(`${prefix()}${m}`, ...a),
		debug: (m: string, ...a) => console.debug(`${prefix()}${m}`, ...a),
	};
}

/** Creates the ANSI-colored console logger sink used by the CLI. */
function createColorConsoleSink({ timestamp }: ConsoleSinkOptions, logger: Logger): LoggerSink {
	const prefix = () => printTaskId(logger) + printTimestamp({ timestamp });
	const paint = (code: string, value: unknown) => `\x1b[${code}m${String(value)}\x1b[0m`;
	return {
		taskStart: (n: string) => console.log(`${prefix()}${paint("36", `Starting ${n} task`)}`),
		taskEnd: (n: string, ms: number) => console.log(`${prefix()}${paint("32", `Finished ${n} task in ${printTime(ms)}`)}`),
		error: (m: string, ...a) => console.error(`${prefix()}${paint("31", m)}`, ...a),
		warning: (m: string, ...a) => console.warn(`${prefix()}${paint("33", m)}`, ...a),
		info: (m: string, ...a) => console.log(`${prefix()}${m}`, ...a),
		debug: (m: string, ...a) => console.debug(`${prefix()}${paint("90", m)}`, ...a),
	};
}

/** Creates the Azure DevOps console logger sink used by the CLI. */
function createDevOpsConsoleSink(_options: ConsoleSinkOptions, logger: Logger): LoggerSink {
	const prefix = () => printTaskId(logger);
	return {
		taskStart: (n: string) => console.log(`##[command]${prefix()}Starting ${n} task`),
		taskEnd: (n: string, ms) => console.log(`${prefix()}Finished ${n} task in ${printTime(ms)}`),
		error: (m: string, ...a) => console.error(`##vso[task.logissue type=error]${prefix()}${m}`, ...a),
		warning: (m: string, ...a) => console.warn(`##vso[task.logissue type=warning]${prefix()}${m}`, ...a),
		info: (m: string, ...a) => console.log(`${prefix()}${m}`, ...a),
		debug: (m: string, ...a) => console.debug(`##[debug]${prefix()}${m}`, ...a),
	};
}

function parseCli(argv: string[]) {
	let taskName = "default";
	let file = "taskfile.ts";
	let level: LogLevel = "normal";
	let loggerKind: ConsoleSinkKind | undefined;
	let timestamp = true;
	let perf = true;
	const vars: Record<string, string> = {};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		switch (arg) {
			case "-f":
			case "--file":
				file = argv[++i];
				break;
			case "--loglevel":
				level = argv[++i] as LogLevel;
				if (!(level in rank))
					throw new Error(`Invalid log level "${level}", valid are: ${Object.keys(rank).join(", ")}`);
				break;
			case "--perf":
				perf = true;
				break;
			case "--no-perf":
				perf = false;
				break;
			case "--timestamp":
				timestamp = true;
				break;
			case "--no-timestamp":
				timestamp = false;
				break;
			case "--logger":
				loggerKind = argv[++i] as ConsoleSinkKind;
				break;
			case "--set":
				const [key, ...value] = (argv[++i] ?? "").split("=");
				vars[key] = value.join("=");
				break;
			default:
				if (arg.startsWith("-"))
					throw new Error(`Unknown argument: ${arg}`);
				taskName = arg;
				break;
		}
	}

	return { taskName, file, level, loggerKind, timestamp, perf, vars };
}

function configureLoggerSink(logger: Logger, { loggerKind, level, timestamp, perf } : ConsoleSinkOptions) {
	const sinkKind = loggerKind ?? (process.stdout.isTTY ? "color" : "simple");
	const sinkOptions: ConsoleSinkOptions = { level, timestamp, perf };
	const outputSink = sinkKind === "color" ? 
		createColorConsoleSink(sinkOptions, logger) : 
		sinkKind === "devops" ? createDevOpsConsoleSink(sinkOptions, logger) :
		createSimpleConsoleSink(sinkOptions, logger);
	
	const sink = configureSink(outputSink, sinkOptions);
	logger.attach(sink);
	return () => {
		for (const [event, handler] of Object.entries(sink)) {
			if (handler) logger.off(event, handler);
		}
	};
}

/** Parse CLI arguments, load a task file, and execute the selected task. */
export async function main(argv = process.argv.slice(2)): Promise<void> {
	const { taskName, file, level, loggerKind, timestamp, perf, vars: cliVars } = parseCli(argv);
	for(var [k, v] of Object.entries(cliVars)) {
		vars[k] = 
			v === "true" ? true :
			v === "false" ? false :
			v === "null" ? null :
			!isNaN(Number(v)) ? Number(v) :
			v;
	}
	const logger = runner.logger;
	const detachSink = configureLoggerSink(logger, { loggerKind, level, timestamp, perf });
	try {
		const resolvedTaskFile = path.resolve(file);
		if (!fs.existsSync(resolvedTaskFile))
			throw new Error(`Task file not found: ${resolvedTaskFile}`);
		const module = await import(pathToFileURL(resolvedTaskFile).href);
		const task = module[taskName];
		if (typeof task !== "function") 
			throw new Error(`Task not found: ${taskName}`);
		await runner.run(task);
	} finally {
		detachSink();
	}
}
	
if (import.meta.main) {
	main().catch(error => { 
		console.error(error); 
		process.exitCode = 1; 
	});
}
