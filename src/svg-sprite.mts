import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { format } from "node:util";
import type { Config } from "svgo";
import type { Config as SpriteConfig, DefsAndSymbolSpecificModeConfig } from "svg-sprite";
import type { TransferOptions } from "./fs.mts";
import { glob } from "./utils.mts";
import type { GlobPattern } from "./utils.mts";
import { logger } from "./logger.mts";

export type SvgSpriteOptions = {
	/** Receives a cwd-relative source path. Defaults to the basename without its extension. */
	id?: (src: string) => string;
	prefix?: string;
	/** Prepare the sprite for embedding in HTML. Defaults to an external sprite. */
	inline?: boolean;
	/** SVGO options, or false to disable optimization. XML is always validated. */
	svgo?: Omit<Config, "path"> | false;
} & TransferOptions

/** Combine SVG files into a deterministic symbol sprite. */
export async function svgSprite(src: GlobPattern, dest: string, options: SvgSpriteOptions = {}): Promise<void> {
	const cwd = path.resolve(options.cwd ?? process.cwd());
	const target = path.resolve(cwd, dest);
	const sources = [...new Set(await Array.fromAsync(glob(src, { cwd })))].sort();
	assert.ok(sources.length, "svgSprite requires at least one source");
	const ids = new Map<string, string>();
	const jobs = sources.map(source => {
		const id = (options.prefix ?? "") + (options.id?.(path.relative(cwd, source)) ?? path.basename(source, path.extname(source)));
		assert.match(id, /^[A-Za-z_][A-Za-z0-9_.-]*$/, `Invalid SVG symbol ID: ${id}`);
		assert.ok(!ids.has(id), `Duplicate SVG symbol ID "${id}": "${ids.get(id)}" and "${source}"`);
		ids.set(id, source);
		return { source, id };
	});
	const [{ optimize }, { default: Spriter }] = await Promise.all([import("svgo"), import("svg-sprite")]);
	const errors: string[] = [];
	const forward = (level: "debug" | "verbose" | "info" | "warning" | "error") => AsyncLocalStorage.bind((...args: unknown[]) => {
		const message = format(...args);
		if (level === "error")
			errors.push(message);
		logger[level](message);
	});
	// Reserve a namespace which cannot collide with public symbol IDs.
	let namespaceIDPrefix = "_sip_";
	while ([...ids.keys()].some(id => id.startsWith(namespaceIDPrefix)))
		namespaceIDPrefix += "_";
	const config: SpriteConfig = {
		log: { level: "debug", transports: [], log: forward("debug"), debug: forward("debug"), verbose: forward("verbose"), info: forward("info"), warn: forward("warning"), error: forward("error") } as unknown as SpriteConfig["log"],
		shape: { transform: [], id: { generator: name => path.basename(name, ".svg") }, dimension: { maxWidth: Number.MAX_VALUE, maxHeight: Number.MAX_VALUE, precision: 8 } },
		svg: { namespaceIDs: true, namespaceIDPrefix, namespaceClassnames: true, xmlDeclaration: false, doctypeDeclaration: false },
		mode: { symbol: { inline: options.inline ?? false, sprite: "sprite.svg" } as DefsAndSymbolSpecificModeConfig },
	};
	logger.verbose(`svgSprite: ${target}`);
	logger.debug("svgSprite: effective options", { target, ...options, config });
	const spriter = new Spriter(config);
	for (const { source, id } of jobs) {
		const input = await readFile(source, "utf8");
		const effective: Config = { ...(options.svgo === false ? { plugins: [] } : options.svgo), path: source };
		// Validate XML even when optimization is disabled; svg-sprite otherwise skips malformed inputs.
		const validated = optimize(input, { path: source, plugins: [{ name: "validate-svg", fn: root => {
			assert.ok(root.children.some(node => node.type === "element" && node.name === "svg"), `Expected an SVG document: ${source}`);
			return null;
		} }] }).data;
		logger.debug("svgSprite: SVGO effective options", effective);
		const data = options.svgo === false ? validated : optimize(validated, effective).data;
		spriter.add(path.join(cwd, `${id}.svg`), `${id}.svg`, data);
	}
	const { result } = await spriter.compileAsync();
	assert.equal(errors.length, 0, errors.join("\n"));
	const output = result.symbol.sprite.contents as Buffer;
	await mkdir(path.dirname(target), { recursive: true });
	await writeFile(target, output, { flag: options.overwrite === false ? "wx" : "w" });
}
