import type { Config } from "svgo";
import type { TransferOptions } from "./fs.mts";
import type { GlobPattern } from "./utils.mts";
export type SvgSpriteOptions = {
    /** Receives a cwd-relative source path. Defaults to the basename without its extension. */
    id?: (src: string) => string;
    prefix?: string;
    /** Prepare the sprite for embedding in HTML. Defaults to an external sprite. */
    inline?: boolean;
    /** SVGO options, or false to disable optimization. XML is always validated. */
    svgo?: Omit<Config, "path"> | false;
} & TransferOptions;
/** Combine SVG files into a deterministic symbol sprite. */
export declare function svgSprite(src: GlobPattern, dest: string, options?: SvgSpriteOptions): Promise<void>;
