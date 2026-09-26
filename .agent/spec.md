# Goal

Implement task runner, similar to gulp. As of v24+ NodeJS supports running TypeScript files using type erasure. All code TypeScript. Use NodeJS v24+ compatible syntax and functions. Use no extenral dependencies.

# Core Modules

* logger.ts -- implements event based logger for logging
    * Task start (timestamp, taskname)
    * Task end (timestamp, taskname, measured time)
    * Errors (timestamp, message, ...args)
    * Warnings (timestamp, message, ...args)
    * Info messages (timestamp, message, ...args)
    * Debug messages (timestamp, message, ...args)

* taskrunner.ts -- implements task runner class with
    * task(displayName, taskfn) -- creates a function to logs task executon start, runs executor, logs task perf
    * series([displayName, ]...taskfn) -- execute tasks one by one
    * parallel([displayName|options, ]...taskfn) -- options is { displayName, maxDop } -- execute task fn in parallel
    * conditional(boolean | () => Awaited<boolean>, ...taskfn) -- execute taskfn if first arg resolves to true

    taskfn is Awaited<void>

* index.ts
    create default runner, export its instance methods

* utils.ts
    * glob(glob: string|string[][, options) => string[]  -- resolve globs to files. Support "!pattern" for exclusion
    * map(src: string, options: { dir, name, ext, prefix, suffix } | { dir, base }) -- change parts of the file. options can be function (src) => result as well
    * resolve(src, dest) -- resolves src as glob, then map to dest via map().

* fs.ts
    implement cp, mv, rm, mkdir, rmdir. all support globs as input

* make.ts
    make([display, ]{ src: glob, dest, dep: glob }, executor) -- if dest is older than any of src or deps, run executor

* cli.ts
    Syntax: cli.ts \
        [task] \
        [-f|--file taskfile.{js,mjs,ts,mts}] \
        [--loglevel=quiet|minimal|normal|verbose|debug] \
        [--perf|--no-perf] \
        [--timestamp|--no-timestamp] \
        [--logger=simple|color|devops] \
        [--set name=value]*

    
    process arguments, create logger sink, load taskfile, execute task. catch and log all errors.

    --logger argument default autodetect -- use color for tty, simple otherwise


# Implementation notes

Document functions, validate arguments, prefer async node functions. let cli call exceptions