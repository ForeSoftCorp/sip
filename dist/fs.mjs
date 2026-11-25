import path from "node:path";
import { cp as nodeCp, mkdir as nodeMkdir, rm as nodeRm, rename, lstat, link, unlink } from "node:fs/promises";
import { glob } from "./utils.mjs";
import { transfers } from "./transfers.mjs";
import { logger } from "./logger.mjs";
async function matches(patterns, options) {
    const files = [];
    for await (const file of glob(patterns, options))
        files.push(file);
    return files;
}
/** Reject mappings that could overwrite another input before all inputs are read. */
function assertNoSourceOverlap(files) {
    const key = (file) => process.platform === "win32" ? file.toLowerCase() : file;
    const sources = new Map(files.map(([source]) => [key(source), source]));
    for (const [source, target] of files) {
        const other = sources.get(key(target));
        if (other !== undefined && key(source) !== key(target))
            throw new Error(`Destination overlaps source: "${source}" maps to "${target}", conflicting with source "${other}"`);
    }
}
/** Copy matched files into a directory or to mapped destination paths. */
export async function cp(src, dest, options = {}) {
    const sources = await transfers(src, dest, options);
    assertNoSourceOverlap(sources);
    await Promise.all([...new Set(sources.map(([, target]) => path.dirname(target)))].map(dir => nodeMkdir(dir, { recursive: true })));
    await Promise.all(sources.map(([file, target]) => {
        logger.verbose(`cp: ${target}`);
        return nodeCp(file, target, { recursive: true, force: options.overwrite ?? true, errorOnExist: options.overwrite === false });
    }));
}
/** Move files matched by src into dest. */
export async function mv(src, dest, options = {}) {
    const sources = await transfers(src, dest, options);
    assertNoSourceOverlap(sources);
    await Promise.all([...new Set(sources.map(([, target]) => path.dirname(target)))].map(dir => nodeMkdir(dir, { recursive: true })));
    await Promise.all(sources.map(async ([file, target]) => {
        logger.verbose(`mv: ${target}`);
        if (options.overwrite === false) {
            // Reserve the target atomically: rename would overwrite a path created after validation.
            await link(file, target);
            await unlink(file);
        }
        else
            await rename(file, target);
    }));
}
/** Validate every match before deleting anything. Symbolic links are removed as files, never followed. */
async function removalTargets(src, directories, options) {
    const files = [...new Set(await matches(src, { ...options, onlyFiles: false }))];
    const existing = [];
    for (const file of files) {
        let entry;
        try {
            entry = await lstat(file);
        }
        catch (error) {
            // Another cleanup task may remove a match after globbing.
            if (error.code === "ENOENT")
                continue;
            throw error;
        }
        if (directories ? !entry.isDirectory() : !(entry.isFile() || entry.isSymbolicLink()))
            throw new Error(`${directories ? "rmdir" : "rm"} requires ${directories ? "a directory" : "a file or symbolic link"}: ${file}`);
        existing.push(file);
    }
    return existing;
}
/** Remove matched files or symbolic links. Reject directories without deleting any matches. */
export async function rm(src, options = {}) {
    await Promise.all((await removalTargets(src, false, options)).map((file) => {
        logger.verbose(`rm: ${file}`);
        return nodeRm(file, { force: true });
    }));
}
/** Remove matched directories and their contents recursively. Reject files and symbolic links. */
export async function rmdir(src, options = {}) {
    await Promise.all((await removalTargets(src, true, options)).map((directory) => {
        logger.verbose(`rmdir: ${directory}`);
        return nodeRm(directory, { recursive: true, force: true });
    }));
}
/** Create a directory. */
export async function mkdir(dir, options = {}) {
    const target = path.resolve(options.cwd ?? process.cwd(), dir);
    logger.verbose(`mkdir: ${target}`);
    await nodeMkdir(target, { recursive: true });
}
