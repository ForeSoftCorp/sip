import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { logger } from "../src/index.mts";
import { TaskRunner } from "../src/runner.mts";
import { svg } from "../src/svg.mts";
import { svgSprite } from "../src/svg-sprite.mts";

const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><!-- remove me --><defs><linearGradient id="paint"><stop stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient><mask id="mask"><rect width="24" height="24" fill="white"/></mask></defs><path fill="url(#paint)" mask="url(#mask)" d="M0 0h24v24H0z"/><path fill="currentColor" d="M1 1h2v2H1z"/></svg>`;
async function fixture() {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "sip-svg-"));
	await mkdir(path.join(cwd, "icons"));
	await writeFile(path.join(cwd, "icons/a.svg"), icon);
	await writeFile(path.join(cwd, "icons/b.svg"), icon);
	return cwd;
}

void test("svg optimizes mapped files, accepts SVGO options, and protects existing outputs", async t => {
	const cwd = await fixture();
	t.after(() => rm(cwd, { recursive: true, force: true }));
	await svg("icons/*.svg", "out/", { cwd, multipass: true });
	const output = await readFile(path.join(cwd, "out/a.svg"), "utf8");
	assert.doesNotMatch(output, /remove me/);
	assert.match(output, /viewBox="0 0 24 24"/);
	assert.match(output, /currentColor/);
	await assert.rejects(svg("icons/a.svg", "out/a.svg", { cwd, overwrite: false }), { code: "EEXIST" });
	await assert.rejects(svg("icons/*.svg", "one.svg", { cwd }), /collision/);
	await svg("icons/a.svg", "icons/a.svg", { cwd, plugins: [] });
	assert.match(await readFile(path.join(cwd, "icons/a.svg"), "utf8"), /remove me/);
});

void test("svg safely swaps mapped inputs", async t => {
	const cwd = await fixture();
	t.after(() => rm(cwd, { recursive: true, force: true }));
	await writeFile(path.join(cwd, "icons/b.svg"), icon.replace('viewBox="0 0 24 24"', 'viewBox="0 0 32 32"'));
	await svg("icons/*.svg", source => path.basename(source) === "a.svg" ? "icons/b.svg" : "icons/a.svg", { cwd, plugins: [] });
	assert.match(await readFile(path.join(cwd, "icons/a.svg"), "utf8"), /viewBox="0 0 32 32"/);
	assert.match(await readFile(path.join(cwd, "icons/b.svg"), "utf8"), /viewBox="0 0 24 24"/);
});

void test("svgSprite emits deterministic symbols with isolated gradient and mask references", async t => {
	const cwd = await fixture();
	t.after(() => rm(cwd, { recursive: true, force: true }));
	await svgSprite(["icons/b.svg", "icons/a.svg"], "out/sprite.svg", { cwd, prefix: "icon-" });
	const output = await readFile(path.join(cwd, "out/sprite.svg"), "utf8");
	assert.equal((output.match(/<symbol\b/g) ?? []).length, 2);
	assert.match(output, /id="icon-a"/);
	assert.match(output, /id="icon-b"/);
	assert.equal((output.match(/viewBox="0 0 24 24"/g) ?? []).length, 2);
	assert.match(output, /currentColor/);
	const ids = [...output.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
	assert.equal(ids.length, new Set(ids).size);
	for (const match of output.matchAll(/url\(#([^)]+)\)/g))
		assert.ok(ids.includes(match[1]));
	const gradients = [...output.matchAll(/<linearGradient id="([^"]+)"/g)].map(match => match[1]);
	assert.equal(gradients.length, 2);
	await svgSprite("icons/*.svg", "out/sprite.svg", { cwd, prefix: "icon-" });
	assert.equal(await readFile(path.join(cwd, "out/sprite.svg"), "utf8"), output);
	await assert.rejects(svgSprite("icons/*.svg", "out/sprite.svg", { cwd, overwrite: false }), { code: "EEXIST" });
});

void test("svgSprite supports custom IDs, inline embedding and disabled optimization", async t => {
	const cwd = await fixture();
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const seen: string[] = [];
	await svgSprite("icons/*.svg", "inline.svg", { cwd, inline: true, svgo: false, id: src => {
		seen.push(src);
		return path.basename(src, ".svg").toUpperCase();
	} });
	const output = await readFile(path.join(cwd, "inline.svg"), "utf8");
	assert.deepEqual(seen, [path.join("icons", "a.svg"), path.join("icons", "b.svg")]);
	assert.match(output, /id="A"/);
	assert.match(output, /style="position:absolute"/);
	assert.match(output, /remove me/);
});

void test("SVG handlers retain task context in destination and native diagnostic logs", async t => {
	const cwd = await fixture();
	t.after(() => rm(cwd, { recursive: true, force: true }));
	const events: { message: string; id: number | undefined }[] = [];
	for (const level of ["verbose", "debug"] as const) {
		const listener = (message: string) => events.push({ message, id: logger.taskId });
		logger.on(level, listener);
		t.after(() => logger.off(level, listener));
	}
	const runner = new TaskRunner();
	await runner.run(runner.task("SVG", async () => {
		await svg("icons/a.svg", "out.svg", { cwd });
		await svgSprite("icons/*.svg", "sprite.svg", { cwd });
	}));
	assert.ok(events.some(event => event.message === `svg: ${path.join(cwd, "out.svg")}`));
	assert.ok(events.some(event => event.message === `svgSprite: ${path.join(cwd, "sprite.svg")}`));
	assert.ok(events.some(event => event.message === "svgSprite: SVGO effective options"));
	assert.ok(events.length > 0);
	assert.ok(events.every(event => event.id !== undefined && event.id === events[0]?.id));
});

void test("svgSprite rejects empty inputs, duplicate or invalid IDs and malformed SVG without replacing output", async t => {
	const cwd = await fixture();
	t.after(() => rm(cwd, { recursive: true, force: true }));
	await writeFile(path.join(cwd, "sprite.svg"), "original");
	await assert.rejects(svgSprite("missing/*.svg", "sprite.svg", { cwd }), /at least one source/);
	await assert.rejects(svgSprite("icons/*.svg", "sprite.svg", { cwd, id: () => "same" }), /Duplicate.*a.svg.*b.svg/);
	await assert.rejects(svgSprite("icons/*.svg", "sprite.svg", { cwd, prefix: "bad " }), /Invalid SVG symbol ID/);
	await writeFile(path.join(cwd, "icons/b.svg"), "<svg><path></svg>");
	await assert.rejects(svgSprite("icons/*.svg", "sprite.svg", { cwd, svgo: false }));
	assert.equal(await readFile(path.join(cwd, "sprite.svg"), "utf8"), "original");
});
