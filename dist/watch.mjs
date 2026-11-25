import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { logger } from "./logger.mjs";
import { glob } from "./utils.mjs";
function address({ id = "default", cwd = process.cwd() }) {
    assert.ok(typeof id === "string" && id.length > 0, "watch id must be non-empty");
    let root = path.resolve(cwd);
    if (process.platform === "win32")
        root = root.toLowerCase();
    const key = createHash("sha256").update(JSON.stringify([os.homedir(), root, id])).digest("hex").slice(0, 32);
    if (process.platform === "win32")
        return `\\\\.\\pipe\\sip-watch-${key}`;
    if (process.platform === "linux")
        return `\0sip-watch-${key}`;
    return path.join(os.tmpdir(), `sip-watch-${key}.sock`);
}
async function snapshot(spec) {
    const result = new Map();
    for await (const file of glob(spec.src, spec.cwd === undefined ? {} : { cwd: spec.cwd })) {
        try {
            const info = await stat(file, { bigint: true });
            result.set(file, `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`);
        }
        catch (error) {
            // A file can disappear between globbing and stat (including atomic saves).
            if (!["ENOENT", "ENOTDIR"].includes(error.code ?? ""))
                throw error;
        }
    }
    return result;
}
function changed(previous, current) {
    return previous.size !== current.size || [...current].some(([file, value]) => previous.get(file) !== value);
}
/**
 * Create a long-running task that polls glob matches for additions, edits, and removals.
 * Executors run sequentially through the calling runner, only after changes. A failure
 * rejects the watch task and releases its resources. Use stopWatch() from another process
 * or abort options.signal to stop gracefully; cancellation does not interrupt executors.
 */
export function watch(specs, options = {}) {
    assert.ok(Array.isArray(specs) && specs.length > 0, "watch requires at least one specification");
    const interval = options.interval ?? 250;
    assert.ok(Number.isInteger(interval) && interval > 0 && interval <= 2_147_483_647, "watch interval must be a positive 32-bit integer");
    const settings = { ...options };
    for (const spec of specs) {
        assert.ok(spec, "watch requires a specification");
        assert.ok(typeof spec.src === "string" || Array.isArray(spec.src), "watch requires src");
        assert.ok([spec.src].flat().length > 0 && [spec.src].flat().every(pattern => typeof pattern === "string" && pattern.length > 0), "watch src must contain non-empty patterns");
        assert.equal(typeof spec.run, "function", "watch requires run");
        assert.ok(spec.cwd === undefined || typeof spec.cwd === "string", "watch cwd must be a string");
    }
    const requested = specs.map(spec => ({ ...spec, src: Array.isArray(spec.src) ? [...spec.src] : spec.src }));
    // Validate the address now, but resolve the default working directory at execution time.
    address(settings);
    return async function () {
        if (settings.signal?.aborted)
            return;
        const cwd = path.resolve(settings.cwd ?? process.cwd());
        const entries = requested.map(spec => ({ ...spec, cwd: path.resolve(cwd, spec.cwd ?? ".") }));
        const endpoint = address({ ...settings, cwd });
        const state = { stopping: false };
        // IPC and abort callbacks can change this during any awaited operation.
        const isStopping = () => state.stopping;
        let wake;
        const stop = () => { state.stopping = true; wake?.(); };
        const clients = new Set();
        const server = createServer(socket => {
            clients.add(socket);
            socket.setEncoding("utf8");
            socket.setTimeout(5000, () => socket.destroy());
            socket.on("error", () => socket.destroy());
            socket.on("close", () => clients.delete(socket));
            let command = "";
            socket.on("data", chunk => {
                command += chunk;
                if (command === "stop\n") {
                    // Allow the acknowledgement to flush while the watch loop drains.
                    clients.delete(socket);
                    socket.end("stopping\n");
                    stop();
                }
                else if (command.length > 5 || command.includes("\n"))
                    socket.destroy();
            });
        });
        let serverError;
        server.on("error", error => { serverError = error; stop(); });
        settings.signal?.addEventListener("abort", stop, { once: true });
        let timer;
        try {
            await new Promise((resolve, reject) => {
                server.once("error", reject);
                server.listen(endpoint, () => { server.off("error", reject); resolve(); });
            });
            const watched = await Promise.all(entries.map(async (entry) => ({ ...entry, previous: await snapshot(entry) })));
            logger.info(`watch: ready (${settings.id ?? "default"})`);
            while (!isStopping()) {
                await new Promise(resolve => { wake = resolve; timer = setTimeout(resolve, interval); });
                clearTimeout(timer);
                wake = undefined;
                if (isStopping())
                    break;
                // Capture all inputs before running any executor. Changes during a build
                // are detected by the next scan and coalesced into a subsequent run.
                const changes = await Promise.all(watched.map(async (entry) => ({ entry, current: await snapshot(entry) })));
                for (const { entry, current } of changes) {
                    if (isStopping())
                        break;
                    const dirty = changed(entry.previous, current);
                    entry.previous = current;
                    if (dirty)
                        await this.run(entry.run);
                }
            }
            if (serverError)
                throw serverError;
        }
        finally {
            clearTimeout(timer);
            settings.signal?.removeEventListener("abort", stop);
            for (const socket of clients)
                socket.destroy();
            if (server.listening)
                await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
    };
}
/** Request graceful cancellation from this or another process. An absent watcher is a no-op.
 * Resolves once the request is acknowledged; an active executor may still be finishing.
 */
export async function stopWatch(options = {}) {
    const endpoint = address(options);
    await new Promise((resolve, reject) => {
        const socket = createConnection(endpoint);
        let reply = "";
        socket.setEncoding("utf8");
        socket.setTimeout(5000, () => socket.destroy(new Error("Timed out stopping watcher")));
        socket.on("connect", () => socket.write("stop\n"));
        socket.on("data", chunk => {
            reply += chunk;
            if (reply === "stopping\n") {
                socket.destroy();
                resolve();
            }
            else if (reply.length > 9)
                socket.destroy(new Error("Invalid watch response"));
        });
        socket.on("error", error => {
            if (["ENOENT", "ECONNREFUSED"].includes(error.code ?? ""))
                resolve();
            else
                reject(error);
        });
        socket.on("close", () => {
            if (reply !== "stopping\n")
                reject(new Error("Watcher closed without acknowledging cancellation"));
        });
    });
}
