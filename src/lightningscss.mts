import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { CustomAtRules, TransformOptions } from "lightningcss";
import type { Logger as SassLogger, Options as SassOptions } from "sass-embedded";
import { logger } from "./logger.mts";

export type LightningscssOptions<C extends CustomAtRules = CustomAtRules> = Omit<
	TransformOptions<C>, "filename" | "code" | "inputSourceMap" | "cssModules" | "analyzeDependencies"
> & {
	/** Alias for sourceMap. An explicit sourceMap value takes precedence. */
	sourcemap?: boolean;
	/** Base directory for src, dest, projectRoot, and Sass loadPaths. */
	cwd?: string;
	/** Enable Sass with true or compilation options. False or omission processes plain CSS. */
	sass?: boolean | Omit<SassOptions<"async">, "sourceMap" | "logger">;
};

/** Optionally compile Sass, process and minify with Lightning CSS, and write dest immediately. */
export async function lightningscss<C extends CustomAtRules = CustomAtRules>(
	src: string, dest: string, options: LightningscssOptions<C> = {},
): Promise<void> {
	assert.ok(typeof src === "string" && src.length > 0, "lightningscss requires an entry file");
	assert.ok(typeof dest === "string" && dest.length > 0, "lightningscss requires a destination file");
	assert.ok(options.cwd === undefined || (typeof options.cwd === "string" && options.cwd.length > 0), "cwd must be a non-empty string");
	const { cwd: baseDirectory, sass: sassOptions, sourcemap, ...cssOptions } = options;
	const sourceMap = cssOptions.sourceMap ?? sourcemap ?? false;
	const cwd = path.resolve(baseDirectory ?? process.cwd());
	const input = path.resolve(cwd, src);
	const file = path.resolve(cwd, dest);
	const projectRoot = path.resolve(cwd, cssOptions.projectRoot ?? ".");
	const { transform } = await import("lightningcss");
	logger.verbose(`lightningscss: ${file}`);
	let code: Buffer;
	let inputSourceMap: string | undefined;
	if (sassOptions !== undefined && sassOptions !== false) {
		const { compileAsync } = await import("sass-embedded");
		const sass = sassOptions === true ? {} : sassOptions;
		const compileOptions: SassOptions<"async"> = {
			...sass,
			sourceMap,
			logger: {
				warn: AsyncLocalStorage.bind<NonNullable<SassLogger["warn"]>>((message, details) => logger.warning(message, details)),
				debug: AsyncLocalStorage.bind<NonNullable<SassLogger["debug"]>>((message, details) => logger.debug(message, details)),
			},
		};
		if (sass.loadPaths)
			compileOptions.loadPaths = sass.loadPaths.map(directory => path.resolve(cwd, directory));
		logger.debug("sass-embedded: effective compile options", { input, ...compileOptions });
		const compiled = await compileAsync(input, compileOptions);
		code = Buffer.from(compiled.css);
		if (compiled.sourceMap) {
			// Lightning CSS treats input-map sources as relative to projectRoot.
			// Decode file URLs before rebasing; encode them only in the final map.
			inputSourceMap = JSON.stringify({
				...compiled.sourceMap,
				sources: compiled.sourceMap.sources.map(source => source.startsWith("file:")
					? path.relative(projectRoot, fileURLToPath(source)).split(path.sep).join("/")
					: source),
			});
		}
	} else {
		code = await readFile(input);
	}
	const transformOptions: TransformOptions<C> = {
		...cssOptions,
		sourceMap,
		filename: input,
		code,
		projectRoot,
		minify: cssOptions.minify ?? true,
	};
	if (inputSourceMap !== undefined)
		transformOptions.inputSourceMap = inputSourceMap;
	logger.debug("lightningcss: effective transform options", transformOptions);
	const result = transform(transformOptions);
	for (const warning of result.warnings)
		logger.warning(warning.message, warning);
	await mkdir(path.dirname(file), { recursive: true });
	if (result.map) {
		const map = JSON.parse(Buffer.from(result.map).toString("utf8"));
		map.file = path.basename(file);
		// Rebase local paths from projectRoot to the destination, then encode URL
		// components once. Non-file URLs from custom Sass importers stay intact.
		map.sources = map.sources.map((source: string) => {
			if (!path.isAbsolute(source) && URL.canParse(source))
				return source;
			const absolute = path.resolve(projectRoot, source);
			const relative = path.relative(path.dirname(file), absolute);
			return path.isAbsolute(relative) ? pathToFileURL(absolute).href : relative.split(path.sep).map(encodeURIComponent).join("/");
		});
		await writeFile(`${file}.map`, JSON.stringify(map));
		const reference = `\n/*# sourceMappingURL=${encodeURIComponent(path.basename(file))}.map */\n`;
		await writeFile(file, Buffer.concat([result.code, Buffer.from(reference)]));
	} else {
		await writeFile(file, result.code);
	}
}
