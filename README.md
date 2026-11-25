# sip

A small TypeScript task runner with no runtime dependencies. Run it directly from a source checkout with Node.js 24.2 or newer.

## Install from GitHub

Replace `OWNER` with the GitHub repository owner:

```sh
npm install --save-dev github:OWNER/sip
# Or pin a tag/commit:
npm install --save-dev github:OWNER/sip#v1.0.0
```

Import from `@foresoft/sip` and run tasks with `npx sip`. The repository includes prebuilt JavaScript and TypeScript declarations in `dist/`; Git installs use these files directly and do not run a build. Optional handlers still require their corresponding peer dependencies.

The main entry contains only the dependency-free task runner and utilities. Import optional handlers and their option types from the dedicated subpaths: `@foresoft/sip/rolldown`, `@foresoft/sip/lightningscss`, `@foresoft/sip/image`, `@foresoft/sip/svg`, and `@foresoft/sip/svg-sprite`.

## Quick start

Run `npm ci` to install development tools. Create `taskfile.mts` in the checkout root:

```ts
import { task, parallel, series, logger, vars } from "./src/index.mts";

export const build = task("Build", async () => {
    logger.info("Compiling 12 files...");
    // Await your build operations here.
});

export const styles = task("Styles", async () => {
    logger.info("Writing styles");
});

export default series(
    parallel({ maxDop: 2 }, build, styles),
    task("Done", () => { logger.info("Production:", vars.production); }),
);
```

```sh
node src/cli.mts --no-timestamp --set production=true
node src/cli.mts build --logger=simple --loglevel=debug
node src/cli.mts --help
```

The default task is the task file's default export. A positional task name selects a named export. Paths and globs resolve from the working directory, not the task file's directory.

## CLI options

| Option | Meaning |
| --- | --- |
| `-f`, `--file <path>` | Task file; defaults to `taskfile.mts` |
| `--logger <kind>` | `simple`, `color`, or `devops`; auto-detects color for a terminal |
| `--loglevel <level>` | `quiet`, `minimal`, `normal`, `verbose`, or `debug`; defaults to `normal` |
| `--set <name=value>` | Repeatable variable assignment |
| `--timestamp`, `--no-timestamp` | Enable/disable timestamps; enabled by default |
| `--perf`, `--no-perf` | Enable/disable completion and timing messages; enabled by default |
| `-h`, `--help` | Show usage without loading a task file |

Value options accept both `--logger simple` and `--logger=simple`. Boolean switches do not accept values. Only one task name is allowed. Missing values, invalid logger/level names, and malformed assignments are errors.

`--set` converts `true`, `false`, `null`, and numeric values; other values remain strings, including an empty value in `--set name=`. Additional equals signs are preserved. Later assignments replace earlier ones. Variables are process-local and persist across programmatic `main()` calls.

`minimal` shows task lifecycle and errors; `normal` adds info/warnings; `verbose` adds handler names and destination paths; `debug` also adds diagnostics and effective compiler options. `quiet` suppresses logger output. Uncaught CLI failures still go to stderr and return exit code 1.

`logger.verbose(message, ...args)` emits a verbose event for custom sinks. Built-in handlers report `cp`, `mv`, `rm`, `rmdir`, `mkdir`, `rolldown`, and `lightningscss` with their absolute destination (or removal target). `make` also reports destinations when its executor is skipped, marked `(skipped, up to date)`.

## Tasks and logging

Use `--loglevel=debug` to diagnose incremental builds. `make` logs resolved paths, modification times, the newest dependency, reasons for rebuilding, and whether it runs or skips the executor. Lifecycle start/end messages also appear for skipped tasks because checking freshness is itself a task execution. Debug logging also includes the effective options immediately before calling Rolldown, Sass Embedded, and Lightning CSS.

- `task(name, executor)` declares a named task. Execute it through `runner.run(task)` or a composition helper to get lifecycle logging.
- `series(...tasks)` runs in order and stops at the first failure.
- `parallel({ maxDop }, ...tasks)` limits concurrency. On failure, it stops starting queued tasks, waits for active tasks, then rejects with the first observed error. It does not cancel active work or undo completed work.
- `conditional(condition, task)` runs one task if a value or async predicate is truthy.
- Task callbacks run with `this` set to their runner; `this.logger` is an alias for the shared `logger`.

All runners and handlers use one shared logger, available from `@foresoft/sip` or `@foresoft/sip/logger`. Create additional runners with `new TaskRunner()`; the constructor takes no logger argument. Sinks attached to the shared logger receive events from every runner and from standalone handler calls. Use `logger.off(event, handler)` to remove temporary listeners.

Each named execution receives an increasing numeric ID from the shared logger, starting at 1 and continuing across runners. Messages from parallel tasks keep their IDs across promises and timers:

```text
1> Starting Build task
2> Starting Styles task
1> Compiling 12 files...
2> Writing styles
```

Nested named tasks receive their own IDs; unnamed tasks inherit the current ID. Logging outside tasks has no prefix. Direct `console.log()` calls have no task attribution. Timing messages indicate completion, including failed executions.

For custom output, attach a sink with `logger.attach({ info(message, ...args) { /* ... */ } })`. Read `logger.taskId` inside the event handler to capture its ID; existing event arguments are unchanged. Provide an `error` handler when using the logger without the CLI, because it uses EventEmitter's special `error` event.

## Watching files

`watch([{ src, cwd?, run }], options?)` creates a task that stays active until stopped. Each `src` accepts the same glob patterns and `!` exclusions as `glob()`. Executors run through the calling runner when matched files are added, edited, renamed, or removed; they do not run initially. Use `series(build, watch(...))` for an initial build.

```ts
import { watch, stopWatch, series } from "./src/index.mts";

const build = async () => { /* build assets */ };
export const dev = series(build, watch([
    { src: ["src/**/*.mts", "!src/**/*.test.mts"], run: build },
]));
export const stop = () => stopWatch();
```

Start `sip dev`, then run `sip stop` from another process or IDE task using the same working directory. No interaction with the original terminal is required. `stopWatch()` uses local IPC, acknowledges the stop request, and is a no-op if the watcher is absent. Active executors finish normally, queued changes are discarded, and the original watch task resolves. It cannot forcibly interrupt a running executor; one that never finishes will still prevent graceful shutdown.

Watch options are `{ id?: string, cwd?: string, interval?: number, signal?: AbortSignal }`. `id` defaults to `"default"`; `cwd` defaults to `process.cwd()` and also supplies the base for each entry's `cwd`. Use distinct IDs for multiple watchers in one project, and pass matching `{ id, cwd }` to `stopWatch()`. Starting a second watcher at an occupied address rejects. For cancellation in the same process, pass an `AbortController`'s signal and call `controller.abort()`.

The watcher polls file metadata every 250 ms by default, with no dependencies. It supports initially empty matches and newly created directories. All executors run sequentially; changes during a build are coalesced into the next scan. Executor or scan failures reject the watcher and release its resources. Polling can miss files created and deleted entirely between scans, and scanning very large trees costs more than native filesystem notifications; narrow the globs or increase `interval` as needed. On macOS and other Unix platforms except Linux, a forced process kill can leave a socket in the OS temporary directory; an `EADDRINUSE` error includes the stale socket path, which must be removed after confirming the previous process has exited.

Import `watch`, `stopWatch`, `WatchSpec`, `WatchOptions`, and `WatchAddress` from the main entry or `@foresoft/sip/watch`.

## Files and incremental work

- `glob(patterns, options)` lazily yields absolute file paths. Use `!pattern` exclusions and `cwd` to change the search root.
- `map(source, options)` changes a path's directory, base name, extension, prefix, or suffix. `resolve(patterns, destination)` combines globbing and mapping. String destinations are exact file paths; append `/` or `\` to indicate a directory, even for one source. The same rule applies to strings returned by mapping functions and to `make` destinations. `resolve` rejects multiple sources mapped to one string filename.
- `cp(patterns, destination)` and `mv(patterns, destination)` accept an exact filename, a directory ending in `/` or `\`, path-mapping options, or a mapping function. Directory destinations flatten source filenames. Both reject duplicate destinations and any destination that overlaps another source in the batch before creating directories or modifying files (case-insensitive on Windows). This rejects swaps such as `a -> b, b -> a` and chains such as `a -> b, b -> c` without changing any inputs. After validation, destination parents are created automatically. Existing destination files outside the source set retain the underlying Node copy/rename overwrite behavior. Moves across filesystems can fail. These operations are not transactional after validation.
- `rm(patterns)` removes matched files or symbolic links without following links; it rejects directories. `rmdir(patterns)` removes matched directories and their contents recursively; it rejects files and symbolic links. Both validate all matches before deleting anything, and unmatched patterns are a no-op. `mkdir(directory)` creates a directory recursively.
- For example, `cp(src, "out/renamed.js")` renames the copied file; `cp(src, "out/")` preserves its basename. `{ dir: "out" }` explicitly selects a directory without requiring a trailing slash. `mv` uses the same conventions.
- `make([name,] { src, dest, deps?, cwd? }, executor)` runs when a destination is missing or an input is newer. `dest` can be a filename or a mapping function. The executor receives `{ cwd, resolved }`, where each resolved entry has absolute `src` and `dest` paths and a `changed` flag. Dependencies invalidate all mapped outputs; missing source matches are an error. Run the resulting task through a runner. It uses modification times and does not detect removed inputs or content changes with unchanged timestamps.

```ts
import { make, cp, logger } from "./src/index.mts";
import { writeFile } from "node:fs/promises";

export const assets = make("Assets", {
    src: "assets/*.txt",
    dest: "out/manifest.txt",
    deps: "config.json",
}, async function () {
    logger.info("Copying assets");
    await cp("assets/*.txt", "out/");
    await writeFile("out/manifest.txt", "Assets copied\n");
});
```

Missing paths are a no-op for `rm` and `rmdir`, including when another cleanup task removes a match before deletion. Other filesystem errors still propagate.

All filesystem handlers accept `cwd` without changing the process directory: `cp(src, dest, options?)`, `mv(src, dest, options?)`, `rm(patterns, options?)`, `rmdir(patterns, options?)`, and `mkdir(dir, options?)`. Relative sources and destinations both resolve from `cwd`.

`cp` and `mv` also accept `overwrite` (default `true`). With `overwrite: false`, existing destinations cause an error before any transfer starts. `mv` reserves new destinations using hard links before unlinking sources to avoid overwriting files created concurrently; this requires hard-link support on the same filesystem. Transfers are not transactional if an operation fails after validation.

```ts
await cp("assets/*.svg", "dist/", { cwd, overwrite: false });
await rm("dist/*.map", { cwd });
await mkdir("dist", { cwd });
```

`make` requires at least one matching source by default. Set `allowEmpty: true` in its spec to skip the executor when no sources match; verbose/debug logging reports the skip. Once a source exists, normal freshness checks apply.

Set `force: true` to run `make` regardless of timestamps, marking every resolved source/destination pair as changed. Sources are still required unless `allowEmpty` is enabled:

```ts
make({ src, dest, deps, force: vars.force === true }, executor);
```

The main entry exports `TaskExecutor`, `TaskFunction`, `ParallelOptions`, `GlobOptions`, `GlobPattern`, `MapOptions`, `MapFunction`, `Destination`, `FileSystemOptions`, and `TransferOptions`. `Destination` is the shared `string | MapOptions | MapFunction` type used by `cp`, `mv`, `map`, `resolve`, and `make`.

## Rolldown bundling

Install the optional peer dependency with `npm install --save-dev rolldown`. Import `rolldown` and `RolldownOptionsWithConfig` from `@foresoft/sip/rolldown`:

```ts
import { task } from "@foresoft/sip";
import { rolldown } from "@foresoft/sip/rolldown";

export const bundle = task("Bundle", () => rolldown("src/main.mts", "dist/main.js", {
    cwd: process.cwd(),
    configPath: "rolldown.config.mts",
    output: { format: "esm", sourcemap: true },
}));
```

`rolldown(src, dest, options?)` runs immediately and returns `Promise<void>`. Options extend Rolldown's `BuildOptions` with `configPath` and `cwd`. All three paths resolve relative to `cwd` (default: `process.cwd()`); the process directory is never changed. Config loading is opt-in and uses Rolldown's loader, including TypeScript and async config functions. Functions receive the explicit build options with resolved entry/output paths. Configs must contain a single configuration, with at most one output object.

Explicit options override config options, with `output` merged separately. `src` and `dest` override configured input/output paths, and a configured output directory is removed. Other nested options are replaced, not deeply merged. `write: false` performs the build without writing files.

Warnings, info, and debug messages go through SIP's default logger and retain the surrounding task ID. The `onLog(level, log, defaultHandler)` hook can filter or transform messages; its default handler forwards to SIP. Check `level === "warn"` to handle warnings. The deprecated `onwarn` option is rejected in both explicit options and loaded configs; use `onLog` instead. Rolldown's log level defaults to `debug` so SIP's sink controls visibility, but an explicit `logLevel` is respected. Build/config errors reject the promise for the runner or CLI to handle.

## CSS and SCSS processing

Install `lightningcss` for CSS processing. To enable Sass preprocessing, also install `sass-embedded` and `source-map-js`; the latter supplies types referenced by Sass Embedded's declarations. Import `lightningscss` and `LightningscssOptions` from `@foresoft/sip/lightningscss`:

```ts
import { task } from "@foresoft/sip";
import { lightningscss } from "@foresoft/sip/lightningscss";

export const styles = task("Styles", () => lightningscss("styles/main.scss", "dist/main.css", {
    cwd: process.cwd(),
    sourcemap: true,
    targets: { safari: 12 << 16 },
    sass: { loadPaths: ["styles/includes"], sourceMapIncludeSources: true },
}));
```

`lightningscss(src, dest, options?)` returns `Promise<void>` and runs immediately. It processes CSS with Lightning CSS. Sass preprocessing is opt-in: set `sass: true` for default Sass options or pass a `sass` options object. If `sass` is omitted or `false`, the input is read directly as CSS, regardless of its extension, and Sass Embedded is never loaded. Minification defaults to enabled; set `minify: false` for readable output. Destination directories are created automatically.

Options are Lightning CSS transform options plus `cwd` and `sass`. Entry/output paths, Sass `loadPaths`, and Lightning CSS `projectRoot` resolve from `cwd`, which defaults to the process working directory without changing it. `sourceMap: true` writes `dest.map` with a reference in the CSS, chaining both stages when Sass is enabled. Source filenames in the map resolve from the output directory. Sass warnings/debug messages and Lightning CSS warnings use SIP's default logger with the surrounding task ID; errors reject the promise.

The pipeline manages input code, filenames, source maps, and Sass logging. CSS Modules and dependency analysis are excluded because this handler writes a CSS file without exporting class mappings or resolving dependency placeholders. CSS `url()` values are preserved rather than rebased; referenced assets must be available relative to the output CSS. Compilers are loaded only when needed during the handler's execution.

`sourcemap` is an alias for `sourceMap`. If both are specified, `sourceMap` takes precedence, including when it is `false`.

## Image processing

Install `@napi-rs/image` as a development dependency. Import `image` and `ImageOptions` from `@foresoft/sip/image`.

```ts
import { image } from "@foresoft/sip/image";

await image("assets/logo.png", "dist/logo.png"); // lossless PNG optimization
await image("assets/photo.jpg", "dist/photo.jpg"); // lossless JPEG optimization
await image("assets/*.{png,jpg}", { dir: "dist", ext: ".webp" }, {
    cwd: process.cwd(),
    overwrite: false,
    png: { strip: false },
    jpeg: { optimizeScans: true },
    webp: { lossless: true },
});
```

`image(src, dest, options?)` immediately reads, optimizes or transforms, and saves, returning `Promise<void>`. It accepts `GlobPattern` and `Destination`, uses the shared `cwd`/`overwrite` conventions, creates output parents, and validates destination collisions before processing. Unmatched source patterns are a no-op; use `make` for required inputs and freshness checks. The optional native dependency loads only when there are images to process. Images are processed sequentially to limit memory use. A batch is not transactional after validation.

The destination extension selects PNG, JPEG (`.jpg` or `.jpeg`), or WebP; only that format's options apply. Inputs may be any still-image format decoded by the installed @napi-rs/image build. Raster formats are detected by the native decoder; `.svg` and `.svgz` inputs use its SVG rasterizer. Platform-dependent formats require the corresponding native codec. Output formats remain PNG, JPEG, and WebP. Same-format PNG/JPEG without a transform uses the native optimizer; other combinations decode and re-encode. PNG options are native `PNGLosslessOptions`; JPEG options are native `JpegCompressOptions`. WebP defaults to lossless; `{ lossless: false, quality: 80 }` explicitly requests lossy encoding. JPEG optimization defaults to quality 100 (the native lossless mode). JPEG conversion or transformation requires explicit `jpeg.quality`, since JPEG re-encoding is lossy even at quality 100.

An optional `transform: image => image.resize(256)` callback receives the native `Transformer` and may return it asynchronously. No implicit resizing or EXIF rotation occurs. Native transformation ordering applies. A transformed PNG is encoded and then optimized with the supplied PNG options.

Lossless refers to image data, not metadata preservation or guaranteed size reduction. Re-encoding can discard metadata, including orientation and color profiles. WebP conversion rejects input above 8 bits per channel rather than silently reducing precision. Animated images are outside this handler's supported scope. Verbose logs show destinations; debug logs show effective options, native operations, and input/output byte counts.

## SVG optimization and sprites

Install `svgo` for SVG optimization, and additionally `svg-sprite` for sprites. Both are optional peers loaded only when their handlers run. Import `svg` and `SvgOptions` from `@foresoft/sip/svg`, and `svgSprite` and `SvgSpriteOptions` from `@foresoft/sip/svg-sprite`.

```ts
import { svg } from "@foresoft/sip/svg";
import { svgSprite } from "@foresoft/sip/svg-sprite";

await svg("assets/**/*.svg", "dist/svg/", { multipass: true });
await svgSprite("assets/icons/*.svg", "dist/icons.svg", {
    prefix: "icon-",
    svgo: { multipass: true },
});
```

`svg(src, dest, options?)` optimizes individual files using SVGO. `SvgOptions` extends SVGO's config (except the managed `path`) with `cwd` and `overwrite`. Source globs and destination mappings follow `cp`; unmatched patterns are a no-op. Mapping collisions are rejected before writing. Inputs are read and optimized before any output is written, so in-place optimization is supported. SVGO's default optimizations apply unless you provide `plugins`.

`svgSprite(src, dest, options?)` combines SVG files into one `<symbol>` sprite. `SvgSpriteOptions` accepts `cwd`, `overwrite`, `prefix`, `id`, `inline`, and `svgo`. The default ID is the source basename without its extension; `id(relativeSourcePath)` customizes it, and `prefix` is prepended. Final IDs must start with an ASCII letter or underscore and contain only letters, digits, underscores, periods, and hyphens. Duplicate IDs fail with both source paths. Empty input and malformed SVG reject without replacing the destination.

Inputs are sorted for deterministic output. Internal IDs and CSS classes are namespaced, and references are adjusted to avoid collisions between icons. Symbol `viewBox` and paint attributes, including `currentColor`, are preserved by sprite assembly; custom SVGO plugins can change them. `svgo: false` disables optimization while retaining XML validation and sprite namespacing. `inline: true` prepares the sprite for embedding in HTML; the default is an external sprite:

```html
<svg><use href="/icons.svg#icon-search"></use></svg>
```

Both handlers return `Promise<void>`, create output parents, and honor `overwrite: false`. Destinations appear at verbose level, effective options at debug level, and sprite diagnostics use SIP's logger. Use `make` to apply freshness checks. Outputs remain vector SVG; use `image()` for rasterization.

## Development

```sh
npm run check
npm run test:package
```

`npm run compile` cleans and regenerates `dist/`: TypeScript emits `.mjs` JavaScript and `.d.mts` declarations, rewriting relative source imports to `.mjs`. Each source module stays separate, so subpath imports share the same runner and logger instances. Node built-ins and optional peer dependencies remain external. Package exports and the CLI point to `dist/`. The script is named `compile` because npm treats a script named `build` as a reason to install development dependencies when installing from Git.

There are no install-time build hooks. `check` builds, lints, type-checks, and runs regression tests. GitHub Actions runs these checks and the package smoke test on Windows and Linux with Node 24 and 26. The package smoke test installs the packed package into a temporary consumer's `node_modules`, checks all exports and declarations, and runs the compiled CLI without TypeScript loaders or optional peer dependencies.

After a push to `main` passes the entire matrix, CI commits the tested Ubuntu / Node 24 `dist/` output back to `main` as `github-actions[bot]`. It includes removed generated files, skips unchanged output, and skips stale builds when `main` has advanced. Pull requests and other branches only run checks. The commit job has `contents: write`; repository rules must allow the Actions bot to push to `main`. Its `GITHUB_TOKEN` push does not start another workflow run.

You can check in source changes without rebuilding `dist/` locally. Pull the bot's follow-up commit before your next push. Git installs and release tags should use a revision containing the updated `dist/`; the original source commit still contains the previous build.

The package smoke test also type-checks a core consumer with strict declaration checking and only Node's type dependencies installed.
