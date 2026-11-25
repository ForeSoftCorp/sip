import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SourceMapConsumer } from "source-map-js";
import { logger } from "../src/index.mts";
import { TaskRunner } from "../src/runner.mts";
import { lightningscss } from "../src/lightningscss.mts";

// Sass uses canonical paths; Windows CI may spell TEMP with an 8.3 short name.
const tempDirectory = await realpath(os.tmpdir());

void test("lightningscss skips Sass when false or omitted, including loading the optional dependency", async t => {
	const cwd = await mkdtemp(path.join(tempDirectory, "sip-css-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const source = ".box { color: red; user-select: none; }";
	// Extension does not implicitly enable Sass.
	await writeFile(path.join(cwd, "main.scss"), source);
	for (const options of [{}, { sass: false }]) {
		const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
			import { registerHooks } from "node:module";
			registerHooks({ resolve(specifier, context, nextResolve) {
				if (specifier === "sass-embedded")
					throw new Error("Sass must not be loaded");
				return nextResolve(specifier, context);
			} });
			const { lightningscss } = await import(${JSON.stringify(pathToFileURL(path.resolve("src/lightningscss.mts")).href)});
			await lightningscss("main.scss", "out/plain.css", {
				cwd: ${JSON.stringify(cwd)}, sourceMap: true, targets: { safari: 12 << 16 }, ...${JSON.stringify(options)},
			});
		`], { encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
		const css = await readFile(path.join(cwd, "out/plain.css"), "utf8");
		assert.match(css, /color:red/);
		assert.match(css, /-webkit-user-select:none/);
		const map = JSON.parse(await readFile(path.join(cwd, "out/plain.css.map"), "utf8"));
		assert.ok(map.sourcesContent.includes(source));
		const original = new SourceMapConsumer(map).originalPositionFor({ line: 1, column: 0 });
		assert.equal(fileURLToPath(new URL(original.source, pathToFileURL(path.join(cwd, "out/plain.css.map")))), path.join(cwd, "main.scss"));
		assert.equal(original.line, 1);
	}
});

void test("lightningscss enables Sass defaults with true or an empty options object", async t => {
	const cwd = await mkdtemp(path.join(tempDirectory, "sip-sass-defaults-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	await writeFile(path.join(cwd, "main.scss"), "$color: red; .box { color: $color; }");
	for (const sass of [true, {}]) {
		await lightningscss("main.scss", "out.css", { cwd, sass });
		assert.equal(await readFile(path.join(cwd, "out.css"), "utf8"), ".box{color:red}");
	}
});

void test("lightningscss compiles imports, minifies, and applies browser targets in separate directories", async t => {
	const originalCwd = process.cwd();
	await Promise.all(["red", "blue"].map(async color => {
		const cwd = await mkdtemp(path.join(tempDirectory, "sip-scss-"));
		t.after(() => rm(cwd, { recursive: true, force: true }));
		await mkdir(path.join(cwd, "includes"));
		await writeFile(path.join(cwd, "includes/_theme.scss"), `$color: ${color};`);
		await writeFile(path.join(cwd, "main.scss"), '@use "theme"; .box { color: theme.$color; user-select: none; .child { margin: 0px; } }');
		const options = Object.freeze({ cwd, targets: { safari: 12 << 16 }, sass: { loadPaths: ["includes"] } });
		await lightningscss("main.scss", "out/style.css", options);
		const css = await readFile(path.join(cwd, "out/style.css"), "utf8");
		assert.match(css, new RegExp(`color:${color === "blue" ? "#00f" : color}`));
		assert.match(css, /-webkit-user-select:none/);
		assert.match(css, /\.box \.child\{margin:0\}/);
		assert.ok(!css.includes("\n"));
		assert.deepEqual(options.sass.loadPaths, ["includes"]);
		await assert.rejects(stat(path.join(cwd, "out/style.css.map")), { code: "ENOENT" });
	}));
	assert.equal(process.cwd(), originalCwd);
});

for (const mapOptions of [{ sourceMap: true }, { sourcemap: true }, { sourceMap: true, sourcemap: false }]) {
	void test(`lightningscss chains source maps with ${JSON.stringify(mapOptions)} and allows disabling minification`, async t => {
		const cwd = await mkdtemp(path.join(tempDirectory, "sip-scss-map-"));
		t.after(() => rm(cwd, { recursive: true, force: true }));
		const source = "$color: red;\n.box {\n  color: $color;\n}\n";
		await writeFile(path.join(cwd, "main.scss"), source);
		await lightningscss("main.scss", "out/style sheet.css", {
			cwd, minify: false, ...mapOptions, sass: { sourceMapIncludeSources: true },
		});
		const css = await readFile(path.join(cwd, "out/style sheet.css"), "utf8");
		assert.match(css, /\n  color: red;/);
		assert.match(css, /sourceMappingURL=style%20sheet.css.map/);
		const map = JSON.parse(await readFile(path.join(cwd, "out/style sheet.css.map"), "utf8"));
		assert.equal(map.file, "style sheet.css");
		assert.ok(map.sourcesContent.includes(source));
		const consumer = new SourceMapConsumer(map);
		const lines = css.split("\n");
		const line = lines.findIndex(value => value.includes(".box"));
		const generatedLine = lines[line];
		assert.ok(generatedLine !== undefined, "Expected generated CSS to contain .box");
		const original = consumer.originalPositionFor({ line: line + 1, column: generatedLine.indexOf(".box") });
		assert.match(original.source, /main\.scss$/);
		assert.equal(original.line, 2);
		assert.equal(fileURLToPath(new URL(original.source, pathToFileURL(path.join(cwd, "out/style sheet.css.map")))), path.join(cwd, "main.scss"));
	});
}

for (const sass of [false, true]) {
	for (const basename of ["main#dark", "main%theme", "main%20light"]) {
		void test(`lightningscss source maps escape ${basename} with sass=${sass}`, async t => {
			const cwd = await mkdtemp(path.join(tempDirectory, "sip-map-#%-"));
			t.after(() => rm(cwd, { recursive: true, force: true }));
			await mkdir(path.join(cwd, "src"));
			const src = path.join("src", `${basename}.${sass ? "scss" : "css"}`);
			const dest = "out#%/style#100%20.css";
			const source = sass ? "$color: red;\n.box { color: $color; }" : ".box { color: red; }";
			await writeFile(path.join(cwd, src), source);
			await lightningscss(src, dest, {
				cwd, projectRoot: "src", sourceMap: true, minify: false,
				sass: sass ? { sourceMapIncludeSources: true } : false,
			});
			const output = path.join(cwd, dest);
			const css = await readFile(output, "utf8");
			const reference = css.match(/sourceMappingURL=(.*?) \*\//)?.[1];
			assert.ok(reference);
			const mapUrl = new URL(reference, pathToFileURL(output));
			assert.equal(fileURLToPath(mapUrl), `${output}.map`);
			const map = JSON.parse(await readFile(mapUrl, "utf8"));
			const consumer = new SourceMapConsumer(map);
			const lines = css.split("\n");
			const line = lines.findIndex(value => value.includes(".box"));
			const generatedLine = lines[line];
			assert.ok(generatedLine !== undefined);
			const original = consumer.originalPositionFor({ line: line + 1, column: generatedLine.indexOf(".box") });
			assert.equal(fileURLToPath(new URL(original.source, mapUrl)), path.join(cwd, src));
			assert.equal(original.line, sass ? 2 : 1);
			assert.equal(consumer.sourceContentFor(original.source), source);
			for (const sourceUrl of map.sources as string[])
				assert.equal(fileURLToPath(new URL(sourceUrl, mapUrl)), path.join(cwd, src));
		});
	}
}

void test("lightningscss source maps preserve imported file and custom URLs", async t => {
	const cwd = await mkdtemp(path.join(tempDirectory, "sip-map-import-#%-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const local = path.join(cwd, "theme#100%20.scss");
	const localSource = ".local { color: blue; }";
	const remote = new URL("https://example.invalid/theme%23dark%2520.scss");
	const remoteSource = ".remote { color: green; }";
	await writeFile(local, localSource);
	await writeFile(path.join(cwd, "main.scss"), '@use "local";\n@use "remote";');
	await lightningscss("main.scss", "out/style.css", {
		cwd, sourceMap: true, minify: false,
		sass: {
			sourceMapIncludeSources: true,
			importers: [
				{ findFileUrl: url => url === "local" ? pathToFileURL(local) : null },
				{
					canonicalize: url => url === "remote" ? remote : null,
					load: () => ({ contents: remoteSource, syntax: "scss", sourceMapUrl: remote }),
				},
			],
		},
	});
	const mapUrl = pathToFileURL(path.join(cwd, "out/style.css.map"));
	const map = JSON.parse(await readFile(mapUrl, "utf8"));
	const consumer = new SourceMapConsumer(map);
	const lines = (await readFile(path.join(cwd, "out/style.css"), "utf8")).split("\n");
	for (const [selector, expectedUrl, source] of [
		[".local", pathToFileURL(local).href, localSource],
		[".remote", remote.href, remoteSource],
	] as const) {
		const line = lines.findIndex(value => value.includes(selector));
		const generatedLine = lines[line];
		assert.ok(generatedLine !== undefined);
		const original = consumer.originalPositionFor({ line: line + 1, column: generatedLine.indexOf(selector) });
		assert.equal(new URL(original.source, mapUrl).href, expectedUrl);
		assert.equal(original.line, 1);
		assert.equal(consumer.sourceContentFor(original.source), source);
	}
});

void test("lightningscss sourceMap: false takes precedence over sourcemap: true", async t => {
	const cwd = await mkdtemp(path.join(tempDirectory, "sip-scss-map-disabled-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	await writeFile(path.join(cwd, "main.scss"), ".box { color: red; }");
	await lightningscss("main.scss", "out.css", { cwd, sass: true, sourceMap: false, sourcemap: true });
	assert.doesNotMatch(await readFile(path.join(cwd, "out.css"), "utf8"), /sourceMappingURL/);
	await assert.rejects(stat(path.join(cwd, "out.css.map")), { code: "ENOENT" });
});

void test("lightningscss routes Sass and Lightning CSS diagnostics through the task logger", async t => {
	const cwd = await mkdtemp(path.join(tempDirectory, "sip-scss-log-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	await writeFile(path.join(cwd, "main.scss"), '@warn "sass warning"; @debug "sass debug"; @unknown hello; .box { color: red; }');
	const messages: [string, unknown, number | undefined][] = [];
	for (const level of ["warning", "debug"] as const) {
		const listener = (message: unknown) => messages.push([level, message, logger.taskId]);
		logger.on(level, listener);
		t.after(() => logger.off(level, listener));
	}
	const runner = new TaskRunner();
	await runner.run(runner.task("Styles", () => lightningscss("main.scss", "out.css", { cwd, sass: true })));
	assert.deepEqual(messages.slice(0, 1).map(([level, message]) => [level, message]), [
		["debug", "sass-embedded: effective compile options"],
	]);
	assert.ok(messages.some(([level, message]) => level === "debug" && message === "lightningcss: effective transform options"));
	assert.ok(messages.some(([level, message]) => level === "warning" && message === "sass warning"));
	assert.ok(messages.some(([level, message]) => level === "debug" && message === "sass debug"));
	assert.ok(messages.some(([level, message]) => level === "warning" && String(message).includes("Unknown at rule")));
	assert.ok(messages.length > 0);
	assert.ok(messages.every(([, , id]) => id !== undefined && id === messages[0]?.[2]));
});

void test("lightningscss rejects invalid inputs and preserves output on compilation or processing errors", async t => {
	const cwd = await mkdtemp(path.join(tempDirectory, "sip-scss-error-"));
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const dest = path.join(cwd, "out.css");
	await writeFile(dest, "previous output");
	await assert.rejects(lightningscss("", dest), /entry file/);
	await assert.rejects(lightningscss("main.scss", ""), /destination file/);
	await assert.rejects(lightningscss("main.scss", dest, { cwd: "" }), /cwd/);
	await assert.rejects(lightningscss("missing.scss", dest, { cwd }));
	await writeFile(path.join(cwd, "main.scss"), ".box { color: $missing; }");
	await assert.rejects(lightningscss("main.scss", dest, { cwd, sass: true }), /Undefined variable/);
	await writeFile(path.join(cwd, "main.scss"), ".box { color: red; }");
	await assert.rejects(lightningscss("main.scss", dest, { cwd, visitor: {
		StyleSheet() { throw new Error("processing failure"); },
	} }), /processing failure/);
	assert.equal(await readFile(dest, "utf8"), "previous output");
});
