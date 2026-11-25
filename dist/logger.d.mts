import { EventEmitter } from "node:events";
export type LoggerEvent = "taskStart" | "taskEnd" | "error" | "warning" | "info" | "verbose" | "debug";
export type LoggerSink = {
    taskStart?(name: string): void;
    taskEnd?(name: string, milliseconds: number): void;
    error?(message: unknown, ...args: unknown[]): void;
    warning?(message: unknown, ...args: unknown[]): void;
    info?(message: unknown, ...args: unknown[]): void;
    verbose?(message: unknown, ...args: unknown[]): void;
    debug?(message: unknown, ...args: unknown[]): void;
};
/** Event-based logger. Attach listeners to receive structured log events. */
export declare class Logger extends EventEmitter {
    #private;
    /** Current task execution ID, also available to synchronous event listeners. */
    get taskId(): number | undefined;
    /** Allocate a unique ID for a named execution and preserve it across async work. */
    withTask<T>(callback: () => T): T;
    /** Attach a sink to this logger. */
    attach(sink: LoggerSink): this;
    taskStart(name: string): void;
    taskEnd(name: string, milliseconds: number): void;
    error(message: unknown, ...args: unknown[]): void;
    warning(message: unknown, ...args: unknown[]): void;
    info(message: unknown, ...args: unknown[]): void;
    verbose(message: unknown, ...args: unknown[]): void;
    debug(message: unknown, ...args: unknown[]): void;
}
/** Shared logger used by every SIP runner and handler. */
export declare const logger: Logger;
