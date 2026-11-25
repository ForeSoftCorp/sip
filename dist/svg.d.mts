import type { Config } from "svgo";
import type { TransferOptions } from "./fs.mts";
import type { Destination, GlobPattern } from "./utils.mts";
export type SvgOptions = TransferOptions & Omit<Config, "path">;
/** Optimize individual SVG files with SVGO. */
export declare function svg(src: GlobPattern, dest: Destination, options?: SvgOptions): Promise<void>;
