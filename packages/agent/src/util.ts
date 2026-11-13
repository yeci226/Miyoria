// Small helpers shared by the agent's modules.

import {
  type AccountRef,
  accountRefString,
  type ContextKey,
  contextKeyString,
} from "@miyoria/types";

/**
 * Map key of a context: like Rust's `Hash` / `Eq` on `ContextKey`, the kind is part of it
 * (`contextKeyString` alone is not unique).
 */
export function contextId(context: ContextKey): string {
  return `${contextKeyString(context)}|${context.kind}`;
}

/** Map key of an account. */
export function accountId(account: AccountRef): string {
  return accountRefString(account);
}

/** Number of Unicode scalar values (Rust `chars().count()`). */
export function charCount(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** UTF-8 byte length (Rust `str::len`). */
export function utf8Len(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/** Rust `to_ascii_lowercase`: only ASCII letters change. */
export function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** Rust `char::is_alphanumeric`. */
export function isAlphanumeric(c: string): boolean {
  return /^[\p{Alphabetic}\p{N}]$/u.test(c);
}

/** Rust `char::is_ascii_alphanumeric`. */
export function isAsciiAlphanumeric(c: string | undefined): boolean {
  return c !== undefined && /^[A-Za-z0-9]$/.test(c);
}

/** Rust `char::is_whitespace`. */
export function isWhitespace(c: string): boolean {
  return /^\s$/u.test(c);
}

/** Rust `{x:.N}` (fixed decimals). */
export function fixed(x: number, digits: number): string {
  return x.toFixed(digits);
}

/** Rust `{x:+.N}` (always signed). */
export function signed(x: number, digits: number): string {
  const s = x.toFixed(digits);
  return s.startsWith("-") ? s : `+${s}`;
}

/** An `AbortError` like the one `AbortSignal` produces. */
export function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("This operation was aborted", "AbortError");
}

/**
 * Settles like `promise`, but rejects as soon as `signal` aborts; and also when it aborted while
 * the caller was waiting (checked again when the caller resumes). The promise itself keeps
 * running; its rejection is swallowed.
 */
export async function guard<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  promise.catch(() => undefined);
  try {
    const value = await Promise.race([promise, aborted]);
    signal.throwIfAborted();
    return value;
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/** Thrown by `timeout` when time runs out. */
export class TimeoutError extends Error {
  override readonly name = "TimeoutError";

  constructor() {
    super("timed out");
  }
}

/**
 * Runs `fn` with a signal that aborts after `ms` (or when `parent` aborts). Rejects with
 * `TimeoutError` when the time runs out, even if `fn` ignores its signal.
 */
export async function timeout<T>(
  ms: number,
  parent: AbortSignal,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  parent.throwIfAborted();
  const controller = new AbortController();
  const onParent = () => controller.abort(parent.reason);
  parent.addEventListener("abort", onParent, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new TimeoutError();
      controller.abort(error);
      reject(error);
    }, ms);
  });
  try {
    const running = fn(controller.signal);
    running.catch(() => undefined);
    return await guard(Promise.race([running, expired]), parent);
  } finally {
    clearTimeout(timer);
    parent.removeEventListener("abort", onParent);
  }
}

/**
 * Splits calls, in order, into the groups that may run together: a run of calls that only look
 * (`readOnly`) is one group, every other call is a group of its own. Running the groups one after
 * another keeps every call that changes something in the order the model gave.
 */
export function toolBatches<T>(calls: readonly T[], readOnly: (call: T) => boolean): T[][] {
  const out: T[][] = [];
  let run: T[] = [];
  for (const call of calls) {
    if (readOnly(call)) {
      run.push(call);
      continue;
    }
    if (run.length > 0) out.push(run);
    run = [];
    out.push([call]);
  }
  if (run.length > 0) out.push(run);
  return out;
}
