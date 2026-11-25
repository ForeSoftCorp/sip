import { EventEmitter } from "node:events";
import { AsyncLocalStorage } from "node:async_hooks";
/** Event-based logger. Attach listeners to receive structured log events. */
export class Logger extends EventEmitter {
    #taskContext = new AsyncLocalStorage();
    #nextTaskId = 1;
    /** Current task execution ID, also available to synchronous event listeners. */
    get taskId() {
        return this.#taskContext.getStore();
    }
    /** Allocate a unique ID for a named execution and preserve it across async work. */
    withTask(callback) {
        return this.#taskContext.run(this.#nextTaskId++, callback);
    }
    /** Attach a sink to this logger. */
    attach(sink) {
        for (const event of ["taskStart", "taskEnd", "error", "warning", "info", "verbose", "debug"]) {
            const handler = sink[event];
            if (handler)
                this.on(event, handler);
        }
        return this;
    }
    taskStart(name) { this.emit("taskStart", name); }
    taskEnd(name, milliseconds) { this.emit("taskEnd", name, milliseconds); }
    error(message, ...args) { this.emit("error", message, ...args); }
    warning(message, ...args) { this.emit("warning", message, ...args); }
    info(message, ...args) { this.emit("info", message, ...args); }
    verbose(message, ...args) { this.emit("verbose", message, ...args); }
    debug(message, ...args) { this.emit("debug", message, ...args); }
}
/** Shared logger used by every SIP runner and handler. */
export const logger = new Logger();
