#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { runner, vars } from "./index.mts";
import { logger } from "./logger.mts";
import type { Logger, LoggerSink } from "./logger.mts";

type ConsoleSinkKind = "simple" | "color" | "devops";
type LogLevel = "quiet" | "minimal" | "normal" | "verbose" | "debug";

type ConsoleSinkOptions = {
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
	return timestamp ? `[${new Date().toLocaleTimeString()}] ` : "";
}

function printTaskId(logger: Logger): string {
	return logger.taskId === undefined ? "" : `${logger.taskId}> `;
}

function printTime(ms: number) {
	if(ms > 60 * 1000)
		return `${(ms / 1000 / 60).toFixed(1)}m`;
	if(ms > 1000)
		return `${(ms / 1000).toFixed(0)}s`;
	if(ms > 1)
		return `${ms.toFixed(1)}ms`;
	return `${ms.toFixed(3)}ms`;
}

/** Applies CLI log-level and performance settings to a sink. */
function configureSink(sink: LoggerSink, { level, perf }: ConsoleSinkOptions): LoggerSink {
	const enabled = (minimum: number) => rank[level] >= minimum;
	const configured: LoggerSink = {
		error: (message, ...args) => { if (enabled(1))
			sink.error?.(message, ...args); },
	};
	if (enabled(1))
		configured.taskStart = name => sink.taskStart?.(name);
	if (perf && enabled(1))
		configured.taskEnd = (name, ms) => sink.taskEnd?.(name, ms);
	if (enabled(2)) {
		configured.warning = (message, ...args) => sink.warning?.(message, ...args);
		configured.info = (message, ...args) => sink.info?.(message, ...args);
	}
	if (enabled(3))
		configured.verbose = (message, ...args) => sink.verbose?.(message, ...args);
	if (enabled(4))
		configured.debug = (message, ...args) => sink.debug?.(message, ...args);
	return configured;
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
		verbose: (m: string, ...a) => console.log(`${prefix()}${m}`, ...a),
	};
}

/** Creates the ANSI-colored console logger sink used by the CLI. */
function createColorConsoleSink({ timestamp }: ConsoleSinkOptions, logger: Logger): LoggerSink {
	const paint = (code: string, value: unknown) => `\x1b[${code}m${String(value)}\x1b[0m`;
	const prefix = () => printTaskId(logger) + (timestamp ? paint("90", printTimestamp({ timestamp })) : "");
	return {
		taskStart: (n: string) => console.log(`${prefix()}${paint("36", `Starting ${n} task`)}`),
		taskEnd: (n: string, ms: number) => console.log(`${prefix()}${paint("32", `Finished ${n} task in ${printTime(ms)}`)}`),
		error: (m: string, ...a) => console.error(`${prefix()}${paint("31", m)}`, ...a),
		warning: (m: string, ...a) => console.warn(`${prefix()}${paint("33", m)}`, ...a),
		info: (m: string, ...a) => console.log(`${prefix()}${m}`, ...a),
		debug: (m: string, ...a) => console.debug(`${prefix()}${paint("90", m)}`, ...a),
		verbose: (m: string, ...a) => console.log(`${prefix()}${paint("90", m)}`, ...a),
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
		verbose: (m: string, ...a) => console.log(`${prefix()}${m}`, ...a),
	};
}

function parseCli(argv: string[]) {
	let taskName = "default";
	let hasTask = false;
	let help = false;
	let file = "taskfile.mts";
	let level: LogLevel = "normal";
	let loggerKind: ConsoleSinkKind | undefined;
	let timestamp = true;
	let perf = true;
	const vars: Record<string, string> = Object.create(null);

	for (let i = 0; i < argv.length; i++) {
		const raw = argv[i];
		if (raw === undefined)
			throw new Error("Missing argument");
		const separator = raw.startsWith("--") ? raw.indexOf("=") : -1;
		const arg = separator < 0 ? raw : raw.slice(0, separator);
		const inline = separator < 0 ? undefined : raw.slice(separator + 1);
		if (inline !== undefined && !["--file", "--loglevel", "--logger", "--set"].includes(arg))
			throw new Error(`Argument does not accept a value: ${arg}`);
		const value = () => {
			const result = inline ?? argv.at(++i);
			if (result === undefined || result === "" || (inline === undefined && result.startsWith("-")))
				throw new Error(`Missing value for ${arg}`);
			return result;
		};
		switch (arg) {
		case "-h":
		case "--help":
			help = true;
			break;
		case "-f":
		case "--file":
			file = value();
			break;
		case "--loglevel":
			level = value() as LogLevel;
			if (!Object.hasOwn(rank, level))
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
			loggerKind = value() as ConsoleSinkKind;
			if (!["simple", "color", "devops"].includes(loggerKind))
				throw new Error(`Invalid logger "${loggerKind}", valid are: simple, color, devops`);
			break;
		case "--set":
			const assignment = value();
			const [key = "", ...parts] = assignment.split("=");
			if (!key.trim() || parts.length === 0 || ["__proto__", "constructor", "prototype"].includes(key))
				throw new Error("--set requires name=value with a non-empty, non-reserved name");
			vars[key] = parts.join("=");
			break;
		default:
			if (arg.startsWith("-"))
				throw new Error(`Unknown argument: ${arg}`);
			if (hasTask)
				throw new Error("Only one task name may be specified");
			taskName = arg;
			hasTask = true;
			break;
		}
	}

	return { taskName, file, level, loggerKind, timestamp, perf, vars, help };
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
		for (const [event, handler] of Object.entries<LoggerSink[keyof LoggerSink]>(sink)) {
			if (handler)
				logger.off(event, handler);
		}
	};
}

/** Parse CLI arguments, load a task file, and execute the selected task. */
export async function main(argv = process.argv.slice(2)): Promise<void> {
	const { taskName, file, level, loggerKind, timestamp, perf, vars: cliVars, help } = parseCli(argv);
	if (help) {
		console.log(`Usage: sip [task] [options]

  -f, --file <path>       Task file (default: taskfile.mts)
  --loglevel <level>      quiet|minimal|normal|verbose|debug (default: normal)
  --logger <kind>         simple|color|devops (default: auto)
  --set <name=value>      Set a task variable; may be repeated
  --[no-]timestamp        Toggle timestamps (default: enabled)
  --[no-]perf             Toggle completion/timing output (default: enabled)
  -h, --help              Show this help

The task defaults to the default export. Value options also accept --option=value.`);
		return;
	}
	for(var [k, v] of Object.entries(cliVars)) {
		vars[k] =
			v === "true" ? true :
				v === "false" ? false :
					v === "null" ? null :
						v.trim() !== "" && !isNaN(Number(v)) ? Number(v) :
							v;
	}
	const detachSink = configureLoggerSink(logger, { ...(loggerKind === undefined ? {} : { loggerKind }), level, timestamp, perf });
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
