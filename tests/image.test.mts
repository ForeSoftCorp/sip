import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Transformer } from "@napi-rs/image";
import { logger } from "../src/index.mts";
import { TaskRunner } from "../src/runner.mts";
import { image } from "../src/image.mts";

async function rgba(input: Uint8Array): Promise<number[]> {
	const decoded = new Transformer(input);
	const { colorType } = await decoded.metadata();
	const pixels = await decoded.rawPixels();
	const channels = [1, 2, 3, 4][colorType];
	assert.ok(channels, `Expected 8-bit image, got ${colorType}`);
	const result: number[] = [];
	for (let i = 0; i < pixels.length; i += channels) {
		const channel = (offset: number) => {
			const value = pixels[i + offset];
			assert.ok(value !== undefined, "Decoded pixel must contain every channel");
			return value;
		};
		const r = channel(0);
		result.push(...(channels === 1 ? [r, r, r, 255] : channels === 2 ? [r, r, r, channel(1)] : channels === 3 ? [r, channel(1), channel(2), 255] : [r, channel(1), channel(2), channel(3)]));
	}
	return result;
}

async function fixture() {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "sip-image-"));
	const pixels = Buffer.from([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 255, 123, 45, 67, 255]);
	const png = await Transformer.fromRgbaPixels(pixels, 2, 2).png();
	const jpeg = await Transformer.fromRgbaPixels(pixels, 2, 2).jpeg(90);
	await writeFile(path.join(cwd, "input.png"), png);
	await writeFile(path.join(cwd, "input.jpg"), jpeg);
	return { cwd, png, jpeg };
}

void test("image optimizes PNG and JPEG losslessly and converts both to lossless WebP", async t => {
	const { cwd, png, jpeg } = await fixture();
	t.after(() => rm(cwd, { recursive: true, force: true }));
	for (const [src, dest, original, format] of [
		["input.png", "out/optimized.png", png, "png"],
		["input.jpg", "out/optimized.JPEG", jpeg, "jpeg"],
		["input.png", "out/png.webp", png, "webp"],
		["input.jpg", "out/jpeg.webp", jpeg, "webp"],
	] as const) {
		await image(src, dest, { cwd, png: { strip: false }, jpeg: { optimizeScans: true }, webp: { lossless: true } });
		const output = await readFile(path.join(cwd, dest));
		assert.equal((await new Transformer(output).metadata()).format, format);
		assert.deepEqual(await rgba(output), await rgba(original));
	}
	await image("input.png", "input.png", { cwd });
	assert.deepEqual(await rgba(await readFile(path.join(cwd, "input.png"))), await rgba(png));
});

void test("image accepts native raster formats beyond PNG, JPEG, and WebP", async t => {
	const { cwd, png } = await fixture();
	t.after(() => rm(cwd, { recursive: true, force: true }));
	for (const format of ["bmp", "tiff", "ico"] as const) {
		const input = await new Transformer(png)[format]();
		await writeFile(path.join(cwd, `input.${format}`), input);
		for (const outputFormat of ["png", "webp"] as const) {
			const dest = `out/${format}.${outputFormat}`;
			await image(`input.${format}`, dest, { cwd });
			const output = await readFile(path.join(cwd, dest));
			assert.equal((await new Transformer(output).metadata()).format, outputFormat);
			assert.deepEqual(await rgba(output), await rgba(input));
		}
	}
});

void test("image rasterizes SVG before encoding or transforming", async t => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "sip-image-svg-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="red"/></svg>';
	await writeFile(path.join(cwd, "input.SVG"), svg);
	const expected = await Transformer.fromSvg(svg).png();
	for (const format of ["png", "webp"] as const) {
		await image("input.SVG", `out.${format}`, { cwd });
		assert.deepEqual(await rgba(await readFile(path.join(cwd, `out.${format}`))), await rgba(expected));
	}
	await image("input.SVG", "small.png", { cwd, transform: value => value.resize(2, 2) });
	assert.equal((await new Transformer(await readFile(path.join(cwd, "small.png"))).metadata()).width, 2);
});

void test("image maps globs, validates destinations and protects existing outputs", async t => {
	const { cwd, png } = await fixture();
	t.after(() => rm(cwd, { recursive: true, force: true }));
	await assert.rejects(image("input.*", "collision/out.webp", { cwd }), /Destination collision/);
	await assert.rejects(stat(path.join(cwd, "collision")), { code: "ENOENT" });
	await image("*.png", { dir: "out", ext: ".webp" }, { cwd, overwrite: false });
	const saved = await readFile(path.join(cwd, "out/input.webp"));
	await assert.rejects(image("input.png", "out/input.webp", { cwd, overwrite: false }), { code: "EEXIST" });
	assert.deepEqual(await readFile(path.join(cwd, "out/input.webp")), saved);
	await image("input.png", "copies/", { cwd });
	assert.deepEqual(await rgba(await readFile(path.join(cwd, "copies/input.png"))), await rgba(png));
	await assert.rejects(image("input.png", "out/no.gif", { cwd }), /Unsupported image destination/);
	await assert.rejects(image("input.png", "out/no.jpg", { cwd }), /explicit jpeg.quality/);
	await image("missing*.png", "out/", { cwd });
	await writeFile(path.join(cwd, "bad.png"), "not an image");
	await assert.rejects(image("bad.png", "out/input.webp", { cwd }));
	assert.deepEqual(await readFile(path.join(cwd, "out/input.webp")), saved);
});

void test("image supports explicit transformations and lossy output with task-scoped logs", async t => {
	const { cwd } = await fixture();
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const events: { level: string; message: string; id: number | undefined }[] = [];
	for (const level of ["verbose", "debug"] as const) {
		const listener = (message: string) => events.push({ level, message, id: logger.taskId });
		logger.on(level, listener);
		t.after(() => logger.off(level, listener));
	}
	const runner = new TaskRunner();
	await runner.run(runner.task("Images", () => image("input.png", "thumb.png", {
		cwd, transform: async value => value.resize(1, 1),
	})));
	const metadata = await new Transformer(await readFile(path.join(cwd, "thumb.png"))).metadata();
	assert.equal(metadata.width, 1);
	assert.equal(metadata.height, 1);
	assert.ok(events.some(event => event.level === "verbose" && event.message === `image: ${path.join(cwd, "thumb.png")}`));
	assert.ok(events.some(event => event.message === "image: effective options"));
	assert.ok(events.length > 0);
	assert.ok(events.every(event => event.id !== undefined && event.id === events[0]?.id));
	await image("input.png", "lossy.jpg", { cwd, jpeg: { quality: 80 } });
	await image("input.jpg", "lossy.webp", { cwd, webp: { lossless: false, quality: 70 } });
	assert.equal((await new Transformer(await readFile(path.join(cwd, "lossy.jpg"))).metadata()).format, "jpeg");
	assert.equal((await new Transformer(await readFile(path.join(cwd, "lossy.webp"))).metadata()).format, "webp");
});
