import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { JpegCompressOptions, PNGLosslessOptions, Transformer } from "@napi-rs/image";
import type { TransferOptions } from "./fs.mts";
import type { Destination, GlobPattern } from "./utils.mts";
import { transfers } from "./transfers.mts";
import { logger } from "./logger.mts";

export type ImageOptions = TransferOptions & {
	/** Native lossless PNG optimizer options. Also applied after encoding transformed PNGs. */
	png?: PNGLosslessOptions;
	/** Native JPEG compression options. Quality defaults to 100 for lossless same-format optimization. */
	jpeg?: JpegCompressOptions;
	/** Lossless by default. Lossy encoding must be explicitly enabled. */
	webp?: { lossless?: true } | { lossless: false; quality?: number };
	/** Optional native transformation. No automatic resize or EXIF rotation is applied. */
	transform?: (image: Transformer) => Transformer | Promise<Transformer>;
};

function outputFormat(file: string): "png" | "jpeg" | "webp" {
	const extension = path.extname(file).toLowerCase();
	if (extension === ".jpg" || extension === ".jpeg")
		return "jpeg";
	if (extension === ".png" || extension === ".webp")
		return extension.slice(1) as "png" | "webp";
	throw new Error(`Unsupported image destination format: ${file}`);
}

/** Read, optimize or transform, and save images. Destination extensions select the encoder. */
export async function image(src: GlobPattern, dest: Destination, options: ImageOptions = {}): Promise<void> {
	const files = await transfers(src, dest, options);
	const jobs = files.map(([source, target]) => ({ source, target, format: outputFormat(target) }));
	const key = (file: string) => process.platform === "win32" ? file.toLowerCase() : file;
	const sources = new Set(files.map(([source]) => key(source)));
	for (const { source, target } of jobs)
		assert.ok(key(source) === key(target) || !sources.has(key(target)), `Image destination would overwrite another source: ${target}`);
	if (!jobs.length)
		return;
	const { Transformer: NativeTransformer, losslessCompressPng, compressJpeg, JsColorType } = await import("@napi-rs/image");
	for (const { source, target, format } of jobs) {
		const outputOptions = options[format];
		if (format === "jpeg" && options.jpeg?.quality !== undefined)
			assert.ok(Number.isFinite(options.jpeg.quality) && options.jpeg.quality >= 0 && options.jpeg.quality <= 100, "JPEG quality must be between 0 and 100");
		if (format === "webp" && options.webp?.lossless === false && options.webp.quality !== undefined)
			assert.ok(Number.isFinite(options.webp.quality) && options.webp.quality >= 0 && options.webp.quality <= 100, "WebP quality must be between 0 and 100");
		logger.verbose(`image: ${target}`);
		logger.debug("image: effective options", { source, target, format, output: outputOptions, transform: options.transform, overwrite: options.overwrite ?? true });
		const input = await readFile(source);
		const svg = /\.svgz?$/i.test(source);
		let transformer = svg ? NativeTransformer.fromSvg(input) : new NativeTransformer(input);
		const metadata = await transformer.metadata();
		let output: Buffer;
		if (format === "png" && metadata.format === "png" && !svg && !options.transform) {
			logger.debug("image: native losslessCompressPng", options.png ?? {});
			output = await losslessCompressPng(input, options.png);
		} else if (format === "jpeg" && metadata.format === "jpeg" && !svg && !options.transform) {
			const jpeg = { ...options.jpeg, quality: options.jpeg?.quality ?? 100 };
			logger.debug("image: native compressJpeg", jpeg);
			output = await compressJpeg(input, jpeg);
		} else {
			if (format === "jpeg")
				assert.ok(options.jpeg?.quality !== undefined, "JPEG conversion or transformation requires explicit jpeg.quality because re-encoding is lossy");
			if (options.transform)
				transformer = await options.transform(transformer);
			if (format === "webp") {
				const transformed = await transformer.metadata();
				assert.ok(transformed.colorType <= JsColorType.Rgba8, "WebP requires 8-bit input; refusing implicit bit-depth reduction");
				if (options.webp?.lossless === false) {
					const quality = options.webp.quality ?? 80;
					logger.debug("image: native webp", { quality });
					output = await transformer.webp(quality);
				} else {
					logger.debug("image: native webpLossless");
					output = await transformer.webpLossless();
				}
			} else if (format === "png") {
				logger.debug("image: native png then losslessCompressPng", options.png ?? {});
				output = await losslessCompressPng(await transformer.png(), options.png);
			} else {
				logger.debug("image: native jpeg", { quality: options.jpeg!.quality });
				output = await transformer.jpeg(options.jpeg!.quality);
				if (options.jpeg?.optimizeScans !== undefined)
					output = await compressJpeg(output, { quality: 100, optimizeScans: options.jpeg.optimizeScans });
			}
		}
		await mkdir(path.dirname(target), { recursive: true });
		await writeFile(target, output, { flag: options.overwrite === false ? "wx" : "w" });
		logger.debug("image: saved", { target, inputBytes: input.length, outputBytes: output.length });
	}
}
