import { EventEmitter } from "node:events";
import { AsyncLocalStorage } from "node:async_hooks";

export type LoggerEvent =
  | "taskStart"
  | "taskEnd"
  | "error"
  | "warning"
  | "info"
  | "debug";

export interface LoggerSink {
  taskStart?(name: string): void;
  taskEnd?(name: string, milliseconds: number): void;
  error?(message: unknown, ...args: unknown[]): void;
  warning?(message: unknown, ...args: unknown[]): void;
  info?(message: unknown, ...args: unknown[]): void;
  debug?(message: unknown, ...args: unknown[]): void;
}

/** Event-based logger. Attach listeners to receive structured log events. */
export class Logger extends EventEmitter {
  #taskContext = new AsyncLocalStorage<number>();
  #nextTaskId = 1;

  /** Current task execution ID, also available to synchronous event listeners. */
  get taskId(): number | undefined { return this.#taskContext.getStore(); }

  /** Allocate a unique ID for a named execution and preserve it across async work. */
  withTask<T>(callback: () => T): T {
    return this.#taskContext.run(this.#nextTaskId++, callback);
  }

  /** Attach a sink to this logger. */
  attach(sink: LoggerSink): this {
    for (const event of ["taskStart", "taskEnd", "error", "warning", "info", "debug"] as LoggerEvent[]) {
      const handler = sink[event];
      if (handler) 
		this.on(event, handler as (...args: unknown[]) => void);
    }
    return this;
  }
  taskStart(name: string): void { this.emit("taskStart", name); }
  taskEnd(name: string, milliseconds: number): void { this.emit("taskEnd", name, milliseconds); }
  error(message: unknown, ...args: unknown[]): void { this.emit("error", message, ...args); }
  warning(message: unknown, ...args: unknown[]): void { this.emit("warning", message, ...args); }
  info(message: unknown, ...args: unknown[]): void { this.emit("info", message, ...args); }
  debug(message: unknown, ...args: unknown[]): void { this.emit("debug", message, ...args); }
}

