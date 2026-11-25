import type { GlobPattern, Destination } from "./utils.mts";
import type { TransferOptions } from "./fs.mts";
/** Validate the complete mapping before any files are copied or moved. */
export declare function transfers(src: GlobPattern, dest: Destination, options: TransferOptions): Promise<[string, string][]>;
