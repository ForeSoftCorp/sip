import path from "node:path";
import { cp as nodeCp, mkdir as nodeMkdir, rm as nodeRm, rename, lstat, link, unlink } from "node:fs/promises";
import { glob } from "./utils.mts";
import { transfers } from "./transfers.mts";
import { logger } from "./logger.mts";
import type { GlobOptions, GlobPattern, Destination } from "./utils.mts";

export type FileSystemOptions = { cwd?: string };
export type TransferOptions = FileSystemOptions & {
	/** Replace existing destinations. Defaults to true; false rejects existing paths. */
	overwrite?: boolean;
};

async function matches(patterns: GlobPattern, options?: GlobOptions): Promise<string[]> {
	const files: string[] = [];
	for await (const file of glob(patterns, options))
		files.push(file);
	return files;
}

/** Reject mappings that could overwrite another input before all inputs are read. */
function assertNoSourceOverlap(files: [string, string][]): void {
	const key = (file: string) => process.platform === "win32" ? file.toLowerCase() : file;
	const sources = new Map(files.map(([source]) => [key(source), source]));
	for (const [source, target] of files) {
		const other = sources.get(key(target));
		if (other !== undefined && key(source) !== key(target))
			throw new Error(`Destination overlaps source: "${source}" maps to "${target}", conflicting with source "${other}"`);
	}
}

/** Copy matched files into a directory or to mapped destination paths. */
export async function cp(src: GlobPattern, dest: Destination, options: TransferOptions = {}): Promise<void> {
	const sources = await transfers(src, dest, options);
	assertNoSourceOverlap(sources);
	await Promise.all([...new Set(sources.map(([, target]) => path.dirname(target)))].map(dir => nodeMkdir(dir, { recursive: true })));
	await Promise.all(sources.map(([file, target]) => {
		logger.verbose(`cp: ${target}`);
		return nodeCp(file, target, { recursive: true, force: options.overwrite ?? true, errorOnExist: options.overwrite === false });
	}));
}

/** Move files matched by src into dest. */
export async function mv(src: GlobPattern, dest: Destination, options: TransferOptions = {}): Promise<void> {
	const sources = await transfers(src, dest, options);
	assertNoSourceOverlap(sources);
	await Promise.all([...new Set(sources.map(([, target]) => path.dirname(target)))].map(dir => nodeMkdir(dir, { recursive: true })));
	await Promise.all(sources.map(async ([file, target]) => {
		logger.verbose(`mv: ${target}`);
		if (options.overwrite === false) {
			// Reserve the target atomically: rename would overwrite a path created after validation.
			await link(file, target);
			await unlink(file);
		} else
			await rename(file, target);
	}));
}

/** Validate every match before deleting anything. Symbolic links are removed as files, never followed. */
async function removalTargets(src: GlobPattern, directories: boolean, options: FileSystemOptions): Promise<string[]> {
	const files = [...new Set(await matches(src, { ...options, onlyFiles: false }))];
	const existing: string[] = [];
	for (const file of files) {
		let entry: Awaited<ReturnType<typeof lstat>>;
		try { entry = await lstat(file); }
		catch (error) {
			// Another cleanup task may remove a match after globbing.
			if ((error as NodeJS.ErrnoException).code === "ENOENT")
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
export async function rm(src: GlobPattern, options: FileSystemOptions = {}): Promise<void> {
	await Promise.all((await removalTargets(src, false, options)).map((file) => {
		logger.verbose(`rm: ${file}`);
		return nodeRm(file, { force: true });
	}));
}

/** Remove matched directories and their contents recursively. Reject files and symbolic links. */
export async function rmdir(src: GlobPattern, options: FileSystemOptions = {}): Promise<void> {
	await Promise.all((await removalTargets(src, true, options)).map((directory) => {
		logger.verbose(`rmdir: ${directory}`);
		return nodeRm(directory, { recursive: true, force: true });
	}));
}

/** Create a directory. */
export async function mkdir(dir: string, options: FileSystemOptions = {}): Promise<void> {
	const target = path.resolve(options.cwd ?? process.cwd(), dir);
	logger.verbose(`mkdir: ${target}`);
	await nodeMkdir(target, { recursive: true });
}
