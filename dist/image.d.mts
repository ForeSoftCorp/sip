import type { JpegCompressOptions, PNGLosslessOptions, Transformer } from "@napi-rs/image";
import type { TransferOptions } from "./fs.mts";
import type { Destination, GlobPattern } from "./utils.mts";
export type ImageOptions = TransferOptions & {
    /** Native lossless PNG optimizer options. Also applied after encoding transformed PNGs. */
    png?: PNGLosslessOptions;
    /** Native JPEG compression options. Quality defaults to 100 for lossless same-format optimization. */
    jpeg?: JpegCompressOptions;
    /** Lossless by default. Lossy encoding must be explicitly enabled. */
    webp?: {
        lossless?: true;
    } | {
        lossless: false;
        quality?: number;
    };
    /** Optional native transformation. No automatic resize or EXIF rotation is applied. */
    transform?: (image: Transformer) => Transformer | Promise<Transformer>;
};
/** Read, optimize or transform, and save images. Destination extensions select the encoder. */
export declare function image(src: GlobPattern, dest: Destination, options?: ImageOptions): Promise<void>;
