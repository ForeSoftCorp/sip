import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Config } from "svgo";
import type { TransferOptions } from "./fs.mts";
import type { Destination, GlobPattern } from "./utils.mts";
import { transfers } from "./transfers.mts";
import { logger } from "./logger.mts";

export type SvgOptions = TransferOptions & Omit<Config, "path">;

/** Optimize individual SVG files with SVGO. */
export async function svg(src: GlobPattern, dest: Destination, options: SvgOptions = {}): Promise<void> {
	const files = await transfers(src, dest, options);
	if (!files.length)
		return;
	const { optimize } = await import("svgo");
	const { cwd: _cwd, overwrite, ...config } = options;
	// Read all inputs first so mappings cannot overwrite a later input.
	const inputs = await Promise.all(files.map(async ([source, target]) => ({ source, target, input: await readFile(source, "utf8") })));
	const outputs = inputs.map(({ source, target, input }) => {
		const effective = { ...config, path: source };
		logger.verbose(`svg: ${target}`);
		logger.debug("svg: effective options", effective);
		return { target, data: optimize(input, effective).data };
	});
	for (const { target, data } of outputs) {
		await mkdir(path.dirname(target), { recursive: true });
		await writeFile(target, data, { flag: overwrite === false ? "wx" : "w" });
	}
}
