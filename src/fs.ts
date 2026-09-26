import path from "node:path";
import { cp as nodeCp, mkdir as nodeMkdir, rm as nodeRm, rename } from "node:fs/promises";
import { glob } from "./utils.ts";
import type { GlobOptions, GlobPattern } from "./utils.ts";

async function matches(patterns: GlobPattern, options?: GlobOptions): Promise<string[]> {
    const files: string[] = [];
    for await (const file of glob(patterns, options)) files.push(file);
    return files;
}

/** Copy files matched by src into dest. */
export async function cp(src: GlobPattern, dest: string): Promise<void> { 
    const sources = await matches(src); 
    await nodeMkdir(dest, { recursive: true }); 
    await Promise.all(sources.map((file) => nodeCp(file, path.join(dest, path.basename(file)), { recursive: true }))); 
}

/** Move files matched by src into dest. */
export async function mv(src: GlobPattern, dest: string): Promise<void> { 
    const sources = await matches(src); 
    await nodeMkdir(dest, { recursive: true }); 
    await Promise.all(sources.map((file) => rename(file, path.join(dest, path.basename(file))))); 
}

/** Remove files and directories matched by src. */
export async function rm(src: GlobPattern): Promise<void> { 
    await Promise.all((await matches(src, { onlyFiles: false })).map((file) => nodeRm(file, { recursive: true, force: true }))); 
}

/** Create a directory. */
export async function md(dir: string): Promise<void> { 
    await nodeMkdir(dir, { recursive: true }); 
}
