// The log of one service: its stdout and stderr, line by line, into `<state>/logs/<name>.log`
// (rotated at 10 MB, five old files kept) and the last lines in memory for `service.logs`, the
// log tail of a failure event and anyone following.

import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { createStream, type RotatingFileStream } from "rotating-file-stream";

/** Lines kept in memory per service. */
export const MEMORY_LINES = 500;
export const ROTATE_SIZE = "10M";
export const ROTATE_KEEP = 5;

/** A size-rotated log file `<dir>/<base>`, older ones `<base>.1` … `<base>.5`. */
export function rotatingLog(dir: string, base: string, size = ROTATE_SIZE): RotatingFileStream {
  mkdirSync(dir, { recursive: true });
  return createStream((index: number | null) => (index === null ? base : `${base}.${index}`), {
    path: dir,
    size,
    rotate: ROTATE_KEEP,
  });
}

/** The last `count` lines of a file, reading at most its last megabyte. */
export function fileTail(file: string, count: number): string[] {
  if (!existsSync(file)) return [];
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, 1024 * 1024);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split(/\r?\n/);
    if (length < size) lines.shift(); // the first one is probably cut
    return lines.filter((l) => l !== "").slice(-count);
  } finally {
    closeSync(fd);
  }
}

export class ServiceLog {
  readonly name: string;
  readonly file: string;
  readonly #dir: string;
  readonly #ring: string[] = [];
  readonly #partial = new Map<string, string>();
  readonly #listeners = new Set<(line: string) => void>();
  readonly #onError: (error: unknown) => void;
  #stream: RotatingFileStream | null = null;
  #broken = false;

  constructor(name: string, dir: string, onError: (error: unknown) => void = () => {}) {
    this.name = name;
    this.#dir = dir;
    this.file = join(dir, `${name}.log`);
    this.#onError = onError;
  }

  #open(): RotatingFileStream | null {
    if (this.#broken) return null;
    if (this.#stream === null) {
      try {
        const stream = rotatingLog(this.#dir, `${this.name}.log`);
        (stream as Writable).on("error", (error) => {
          this.#broken = true;
          this.#onError(error);
        });
        stream.on("warning", (error) => this.#onError(error));
        this.#stream = stream;
      } catch (error) {
        this.#broken = true;
        this.#onError(error);
        return null;
      }
    }
    return this.#stream;
  }

  /** Adds output of the service; `source` keeps stdout and stderr lines apart. */
  write(chunk: string | Buffer, source = "out"): void {
    const text = (this.#partial.get(source) ?? "") + chunk.toString();
    const parts = text.split(/\r?\n/);
    this.#partial.set(source, parts.pop() ?? "");
    for (const line of parts) this.line(line);
  }

  /** Writes what is left of unfinished lines (the process exited). */
  flush(): void {
    for (const [source, rest] of this.#partial) {
      if (rest !== "") this.line(rest);
      this.#partial.set(source, "");
    }
  }

  /** One whole line, from the service or from hostd (a start or exit marker). */
  line(line: string): void {
    this.#ring.push(line);
    if (this.#ring.length > MEMORY_LINES) this.#ring.splice(0, this.#ring.length - MEMORY_LINES);
    this.#open()?.write(`${line}\n`);
    for (const listener of this.#listeners) {
      try {
        listener(line);
      } catch (error) {
        this.#onError(error);
      }
    }
  }

  /** The last `count` lines: from memory once this daemon has seen output, else from the file. */
  tail(count: number): string[] {
    if (this.#ring.length > 0) return this.#ring.slice(-count);
    return fileTail(this.file, count);
  }

  /** Calls `listener` for every new line until the returned function is called. */
  follow(listener: (line: string) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async close(): Promise<void> {
    this.flush();
    const stream = this.#stream;
    this.#stream = null;
    if (stream === null) return;
    await new Promise<void>((resolve) => {
      stream.end(() => resolve());
    });
  }
}
