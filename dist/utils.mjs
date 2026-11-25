import * as path from "node:path";
import { glob as nodeGlob } from "node:fs/promises";
/**
 * Resolve file glob patterns lazily.
 *
 * Negated patterns beginning with `!` are passed to the native glob
 * implementation as exclusions. Results are returned as absolute paths.
 *
 * @param patterns A glob pattern or patterns to include. Prefix a pattern with `!` to exclude matching paths.
 * @param options Controls the working directory, file filtering, and symbolic-link traversal.
 * @returns An async iterator yielding matching paths as they are discovered.
 */
export async function* glob(patterns, { onlyFiles = true, ...nodeOptions } = {}) {
    const cwd = path.resolve(nodeOptions.cwd ?? process.cwd());
    const requested = [patterns].flat();
    const includes = requested.filter((pattern) => !pattern.startsWith("!"));
    const excludes = requested.filter((pattern) => pattern.startsWith("!")).map((pattern) => pattern.replace(/^!+/, ""));
    for await (const entry of nodeGlob(includes, {
        ...nodeOptions,
        cwd,
        exclude: excludes,
        withFileTypes: true,
    })) {
        if (onlyFiles && !entry.isFile() && !entry.isSymbolicLink())
            continue;
        const relative = path.relative(cwd, path.join(entry.parentPath, entry.name));
        yield path.resolve(cwd, relative);
    }
}
/**
 * Transform a source path into a destination path.
 *
 * A string is an exact file path, or a directory when it ends in `/` or `\\`. Mapping options can
 * change the destination directory, filename, extension, prefix, or suffix.
 * A mapping function may return either the final destination path or mapping
 * options, which are then applied to the source path.
 *
 * @param src The source path to transform.
 * @param options A destination directory, mapping options, or function. A function receives the source path and returns a destination path or mapping options.
 * @returns The mapped destination path.
 */
export function map(src, options) {
    if (typeof options === "function") {
        const mapped = options(src);
        return map(src, mapped);
    }
    if (typeof options === "string") {
        if (!/[\\/]$/.test(options))
            return path.normalize(options);
        options = { dir: options.replace(/[\\/]+$/, path.sep) };
    }
    const filter = ({ dir, name, ext }) => ({ dir, name, ext });
    const parsed = filter(path.parse(src));
    if ("base" in options) {
        return path.normalize(path.format({ dir: options.dir ?? parsed.dir, base: options.base }));
    }
    let { prefix, suffix, dir, name, ext } = { ...parsed, ...options };
    if (prefix)
        name = prefix + name;
    if (suffix)
        name = name + suffix;
    return path.normalize(path.format({ ...parsed, dir, name, ext }));
}
/**
 * Expand source glob patterns and map each result to a destination path.
 *
 * Source patterns are processed by {@link glob}, so patterns beginning with
 * `!` exclude matching paths. The destination can be a directory shortcut,
 * mapping options, or a function that receives each resolved source path.
 * A string destination must end in `/` or `\\` when the source resolves to
 * more than one path, so the directory intent is explicit.
 *
 * @param src A source glob pattern or patterns to resolve.
 * @param dest A destination directory, mapping options, or mapping function.
 * @returns An async iterator yielding mapped destination paths in discovery order.
 */
export async function* resolve(src, dest) {
    const sourceIterator = glob(src)[Symbol.asyncIterator]();
    const first = await sourceIterator.next();
    if (first.done)
        return;
    const second = await sourceIterator.next();
    if (!second.done && typeof dest === "string" && !/[\\/]$/.test(dest)) {
        throw new Error("A destination directory must end with '/' or '\\' when resolving multiple sources");
    }
    yield map(first.value, dest);
    if (!second.done)
        yield map(second.value, dest);
    for await (const file of { [Symbol.asyncIterator]: () => sourceIterator })
        yield map(file, dest);
}
