import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CustomAtRules, TransformOptions } from "lightningcss";
import type { Logger as SassLogger, Options as SassOptions } from "sass-embedded";
import { logger } from "./index.ts";

export type LightningScssOptions<C extends CustomAtRules = CustomAtRules> = Omit<
	TransformOptions<C>, "filename" | "code" | "inputSourceMap" | "cssModules" | "analyzeDependencies"
> & {
	/** Alias for sourceMap. An explicit sourceMap value takes precedence. */
	sourcemap?: boolean;
	/** Base directory for src, dest, projectRoot, and Sass loadPaths. */
	cwd?: string;
	/** Sass compilation options. Source map generation and logging are managed by SIP. */
	sass?: Omit<SassOptions<"async">, "sourceMap" | "logger">;
};

/** Compile Sass, process and minify with Lightning CSS, and write dest immediately. */
export async function lightningscss<C extends CustomAtRules = CustomAtRules>(
	src: string, dest: string, options: LightningScssOptions<C> = {},
): Promise<void> {
	assert.ok(typeof src === "string" && src.length > 0, "lightningscss requires an entry file");
	assert.ok(typeof dest === "string" && dest.length > 0, "lightningscss requires a destination file");
	assert.ok(options.cwd === undefined || (typeof options.cwd === "string" && options.cwd.length > 0), "cwd must be a non-empty string");
	const { cwd: baseDirectory, sass: sassOptions, sourcemap, ...cssOptions } = options;
	const sourceMap = cssOptions.sourceMap ?? sourcemap ?? false;
	const cwd = path.resolve(baseDirectory ?? process.cwd());
	const input = path.resolve(cwd, src);
	const file = path.resolve(cwd, dest);
	const [{ compileAsync }, { transform }] = await Promise.all([import("sass-embedded"), import("lightningcss")]);
	const compileOptions: SassOptions<"async"> = {
		...sassOptions,
		sourceMap,
		logger: {
			warn: AsyncLocalStorage.bind<NonNullable<SassLogger["warn"]>>((message, details) => logger.warning(message, details)),
			debug: AsyncLocalStorage.bind<NonNullable<SassLogger["debug"]>>((message, details) => logger.debug(message, details)),
		},
	};
	if (sassOptions?.loadPaths)
		compileOptions.loadPaths = sassOptions.loadPaths.map(directory => path.resolve(cwd, directory));
	logger.verbose(`lightningscss: ${file}`);
	logger.debug("sass-embedded: effective compile options", { input, ...compileOptions });
	const compiled = await compileAsync(input, compileOptions);
	const transformOptions: TransformOptions<C> = {
		...cssOptions,
		sourceMap,
		filename: input,
		code: Buffer.from(compiled.css),
		projectRoot: path.resolve(cwd, cssOptions.projectRoot ?? "."),
		minify: cssOptions.minify ?? true,
	};
	if (compiled.sourceMap)
		transformOptions.inputSourceMap = JSON.stringify(compiled.sourceMap);
	logger.debug("lightningcss: effective transform options", transformOptions);
	const result = transform(transformOptions);
	for (const warning of result.warnings)
		logger.warning(warning.message, warning);
	await mkdir(path.dirname(file), { recursive: true });
	if (result.map) {
		const map = JSON.parse(Buffer.from(result.map).toString("utf8"));
		map.file = path.basename(file);
		// Lightning CSS sources are relative to projectRoot, not the destination.
		map.sources = map.sources.map((source: string) => {
			if (!path.isAbsolute(source) && URL.canParse(source))
				return source;
			const absolute = path.resolve(cwd, cssOptions.projectRoot ?? ".", source);
			return path.relative(path.dirname(file), absolute).split(path.sep).join("/");
		});
		await writeFile(`${file}.map`, JSON.stringify(map));
		const reference = `\n/*# sourceMappingURL=${encodeURIComponent(path.basename(file))}.map */\n`;
		await writeFile(file, Buffer.concat([result.code, Buffer.from(reference)]));
	} else {
		await writeFile(file, result.code);
	}
}
