import type { CustomAtRules, TransformOptions } from "lightningcss";
import type { Options as SassOptions } from "sass-embedded";
export type LightningscssOptions<C extends CustomAtRules = CustomAtRules> = Omit<TransformOptions<C>, "filename" | "code" | "inputSourceMap" | "cssModules" | "analyzeDependencies"> & {
    /** Alias for sourceMap. An explicit sourceMap value takes precedence. */
    sourcemap?: boolean;
    /** Base directory for src, dest, projectRoot, and Sass loadPaths. */
    cwd?: string;
    /** Ensure generated CSS has a UTF-8 BOM. Defaults to false. */
    bom?: boolean;
    /** Enable Sass with true or compilation options. False or omission processes plain CSS. */
    sass?: boolean | Omit<SassOptions<"async">, "sourceMap" | "logger">;
};
/** Optionally compile Sass, process and minify with Lightning CSS, and write dest immediately. */
export declare function lightningscss<C extends CustomAtRules = CustomAtRules>(src: string, dest: string, options?: LightningscssOptions<C>): Promise<void>;
