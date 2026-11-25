import path from "node:path";
import { lstat } from "node:fs/promises";
import { glob, map } from "./utils.mjs";
/** Validate the complete mapping before any files are copied or moved. */
export async function transfers(src, dest, options) {
    const cwd = path.resolve(options.cwd ?? process.cwd());
    const destinations = new Map();
    const result = [];
    for (const source of new Set(await Array.fromAsync(glob(src, { cwd })))) {
        const target = path.resolve(cwd, map(source, dest));
        const key = process.platform === "win32" ? target.toLowerCase() : target;
        const previous = destinations.get(key);
        if (previous !== undefined)
            throw new Error(`Destination collision: "${previous}" and "${source}" both map to "${target}"`);
        destinations.set(key, source);
        if (options.overwrite === false) {
            let exists = false;
            try {
                await lstat(target);
                exists = true;
            }
            catch (error) {
                if (error.code !== "ENOENT")
                    throw error;
            }
            if (exists)
                throw Object.assign(new Error(`Destination already exists: ${target}`), { code: "EEXIST" });
        }
        result.push([source, target]);
    }
    return result;
}
