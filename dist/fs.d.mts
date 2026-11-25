import type { GlobPattern, Destination } from "./utils.mts";
export type FileSystemOptions = {
    cwd?: string;
};
export type TransferOptions = FileSystemOptions & {
    /** Replace existing destinations. Defaults to true; false rejects existing paths. */
    overwrite?: boolean;
};
/** Copy matched files into a directory or to mapped destination paths. */
export declare function cp(src: GlobPattern, dest: Destination, options?: TransferOptions): Promise<void>;
/** Move files matched by src into dest. */
export declare function mv(src: GlobPattern, dest: Destination, options?: TransferOptions): Promise<void>;
/** Remove matched files or symbolic links. Reject directories without deleting any matches. */
export declare function rm(src: GlobPattern, options?: FileSystemOptions): Promise<void>;
/** Remove matched directories and their contents recursively. Reject files and symbolic links. */
export declare function rmdir(src: GlobPattern, options?: FileSystemOptions): Promise<void>;
/** Create a directory. */
export declare function mkdir(dir: string, options?: FileSystemOptions): Promise<void>;
