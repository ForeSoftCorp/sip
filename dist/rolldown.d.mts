import type { BuildOptions } from "rolldown";
export type RolldownOptionsWithConfig = Omit<BuildOptions, "onwarn"> & {
    /** Base directory for src, dest, configPath, and Rolldown options. Defaults to process.cwd(). */
    cwd?: string;
    /** Load a single Rolldown configuration before applying explicit options. */
    configPath?: string;
};
/** Bundle an entry file immediately. Explicit options override config; src and dest always win. */
export declare function rolldown(src: string, dest: string, options?: RolldownOptionsWithConfig): Promise<void>;
