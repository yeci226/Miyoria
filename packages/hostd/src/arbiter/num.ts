// Python's number formatting and rounding, exactly: the decisions this arbiter takes were recorded
// from Python (workers/sing/gpu_decisions.json), reasons included, so `round`, `f"{x:.1f}"` and
// `repr(x)` must give the same digits here. Both languages use the same doubles; what differs is
// rounding a tie. Python rounds the exact binary value half to even; `Math.round` and `toFixed`
// round half up. A tie is decided here on the exact value with BigInt arithmetic.

const VIEW = new DataView(new ArrayBuffer(8));

/** `|x|` as `mantissa × 2^exponent`, exactly. */
function exact(x: number): { mantissa: bigint; exponent: number } {
  VIEW.setFloat64(0, Math.abs(x));
  const bits = VIEW.getBigUint64(0);
  const biased = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & ((1n << 52n) - 1n);
  if (biased === 0) return { mantissa: fraction, exponent: -1074 };
  return { mantissa: fraction | (1n << 52n), exponent: biased - 1075 };
}

/** `|x| × 10^digits` rounded half to even, as an integer. */
function scaled(x: number, digits: number): bigint {
  const { mantissa, exponent } = exact(x);
  const numerator = mantissa * 10n ** BigInt(digits);
  if (exponent >= 0) return numerator << BigInt(exponent);
  const denominator = 1n << BigInt(-exponent);
  const quotient = numerator / denominator;
  const twice = (numerator % denominator) * 2n;
  if (twice > denominator) return quotient + 1n;
  if (twice < denominator) return quotient;
  return quotient % 2n === 0n ? quotient : quotient + 1n;
}

/** Python's `f"{x:.{digits}f}"`. */
export function pyFixed(x: number, digits: number): string {
  if (!Number.isFinite(x)) return Number.isNaN(x) ? "nan" : x > 0 ? "inf" : "-inf";
  const n = scaled(x, digits)
    .toString()
    .padStart(digits + 1, "0");
  const sign = x < 0 || Object.is(x, -0) ? "-" : "";
  if (digits === 0) return `${sign}${n}`;
  return `${sign}${n.slice(0, -digits)}.${n.slice(-digits)}`;
}

/** Python's `round(x, digits)` for a float; `round(x)` (an int) when `digits` is omitted. */
export function pyRound(x: number, digits?: number): number {
  return Number(pyFixed(x, digits ?? 0));
}

/** Python's `repr(x)` of a float (`str` of an int is the same as JavaScript's). */
export function pyRepr(x: number | null, int = false): string {
  if (x === null) return "None";
  if (int) return String(x);
  if (!Number.isFinite(x)) return Number.isNaN(x) ? "nan" : x > 0 ? "inf" : "-inf";
  const abs = Math.abs(x);
  if (abs !== 0 && (abs < 1e-4 || abs >= 1e16)) {
    const [m, e] = x.toExponential().split("e") as [string, string];
    const exp = Number(e);
    return `${m}e${exp < 0 ? "-" : "+"}${String(Math.abs(exp)).padStart(2, "0")}`;
  }
  const s = String(x);
  return Number.isInteger(x) ? `${s}.0` : s;
}

/** `statistics.median`. */
export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mid = Math.floor(n / 2);
  if (n % 2 === 1) return sorted[mid] as number;
  return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** Python's `int(text)` for what an environment variable holds; `null` where it raises. */
export function pyInt(text: string): number | null {
  const t = text.trim();
  if (!/^[+-]?\d+(?:_\d+)*$/.test(t)) return null;
  return Number(t.replaceAll("_", ""));
}

/** Python's `float(text)`; `null` where it raises. */
export function pyFloat(text: string): number | null {
  const t = text.trim();
  if (/^[+-]?(?:inf|infinity)$/i.test(t)) return t.startsWith("-") ? -Infinity : Infinity;
  if (/^[+-]?nan$/i.test(t)) return Number.NaN;
  const digits = String.raw`\d+(?:_\d+)*`;
  const re = new RegExp(
    String.raw`^[+-]?(?:${digits}(?:\.(?:${digits})?)?|\.${digits})(?:[eE][+-]?${digits})?$`,
  );
  if (!re.test(t)) return null;
  return Number(t.replaceAll("_", ""));
}
