export type GlobPattern = string | string[];
export type GlobOptions = {
    cwd?: string;
    onlyFiles?: boolean;
    followSymlinks?: boolean;
};
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
export declare function glob(patterns: GlobPattern, { onlyFiles, ...nodeOptions }?: GlobOptions): AsyncGenerator<string>;
export type MapOptions = {
    dir?: string;
    name?: string;
    ext?: string;
    prefix?: string;
    suffix?: string;
} | {
    dir?: string;
    base: string;
};
export type MapFunction = (src: string) => string | MapOptions;
export type Destination = string | MapOptions | MapFunction;
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
export declare function map(src: string, options: Destination): string;
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
export declare function resolve(src: GlobPattern, dest: Destination): AsyncGenerator<string>;
