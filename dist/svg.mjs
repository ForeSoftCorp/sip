import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { transfers } from "./transfers.mjs";
import { logger } from "./logger.mjs";
/** Optimize individual SVG files with SVGO. */
export async function svg(src, dest, options = {}) {
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
