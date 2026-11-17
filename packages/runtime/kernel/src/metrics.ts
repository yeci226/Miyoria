// Process-wide metrics in the Prometheus text exposition format (version 0.0.4).
//
// Libraries record into `metrics`, the default registry (`metrics.counter(...)` returns the
// same handle when called again with the same name, so declaring a metric at import time and in
// a constructor are both fine). The `api` module serves it at `GET /metrics`, together with the
// metrics it computes at scrape time (module states, process memory).
//
// Every metric declares its label names up front and caps the number of label combinations
// (`maxSeries`): past the cap, new combinations are counted under `"other"` for every label, so
// a misbehaving caller cannot grow the exposition without bound.

import { getLogger } from "./log.js";

const log = getLogger("kernel.metrics");

/** Label values by label name. Missing labels are `""`; unknown ones are ignored. */
export type Labels = Readonly<Record<string, string>>;

export type MetricType = "counter" | "gauge" | "histogram";

/** One line of the exposition: `name{labels} value`. */
export interface MetricSample {
  /** Full sample name, including suffixes like `_bucket` / `_sum` / `_count`. */
  name: string;
  labels: Labels;
  value: number;
}

/** Everything under one `# HELP` / `# TYPE` header. */
export interface MetricFamily {
  name: string;
  help: string;
  type: MetricType;
  samples: MetricSample[];
}

export interface MetricOptions {
  help: string;
  labels?: readonly string[];
  /** Label combinations kept before new ones collapse into `"other"`. Default 256. */
  maxSeries?: number;
}

export interface HistogramOptions extends MetricOptions {
  /** Upper bounds, ascending (`+Inf` is implied). Default `DEFAULT_BUCKETS`. */
  buckets?: readonly number[];
}

/** Bucket bounds (seconds) for request latencies from tens of ms to half a minute. */
export const DEFAULT_BUCKETS: readonly number[] = [
  0.05, 0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 5, 8, 13, 20, 30,
];

const DEFAULT_MAX_SERIES = 256;
/** Label value every label gets once a metric is over its `maxSeries`. */
export const OVERFLOW_LABEL = "other";
const METRIC_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export class MetricsError extends Error {
  override readonly name = "MetricsError";
}

abstract class Metric<S> {
  abstract readonly type: MetricType;
  readonly name: string;
  readonly help: string;
  readonly labelNames: readonly string[];
  readonly #maxSeries: number;
  readonly #series = new Map<string, { values: string[]; state: S }>();
  #overflowLogged = false;

  constructor(name: string, options: MetricOptions) {
    if (!METRIC_NAME.test(name)) throw new MetricsError(`invalid metric name \`${name}\``);
    for (const label of options.labels ?? []) {
      if (!LABEL_NAME.test(label) || label.startsWith("__") || label === "le") {
        throw new MetricsError(`invalid label name \`${label}\` for metric \`${name}\``);
      }
    }
    this.name = name;
    this.help = options.help;
    this.labelNames = [...(options.labels ?? [])];
    this.#maxSeries = Math.max(1, options.maxSeries ?? DEFAULT_MAX_SERIES);
  }

  protected abstract initial(): S;

  /** The state of the series for `labels`, created on first use. */
  protected state(labels: Labels): S {
    let values = this.labelNames.map((n) => labels[n] ?? "");
    let key = JSON.stringify(values);
    let entry = this.#series.get(key);
    if (entry) return entry.state;
    if (this.#series.size >= this.#maxSeries) {
      if (!this.#overflowLogged) {
        this.#overflowLogged = true;
        log.warn({ metric: this.name }, "too many label combinations, collapsing new ones");
      }
      values = this.labelNames.map(() => OVERFLOW_LABEL);
      key = JSON.stringify(values);
      entry = this.#series.get(key);
      if (entry) return entry.state;
    }
    entry = { values, state: this.initial() };
    this.#series.set(key, entry);
    return entry.state;
  }

  protected *entries(): Iterable<[Labels, S]> {
    for (const { values, state } of this.#series.values()) {
      const labels: Record<string, string> = {};
      this.labelNames.forEach((n, i) => {
        labels[n] = values[i] ?? "";
      });
      yield [labels, state];
    }
  }

  /** Drops every series (tests). */
  reset(): void {
    this.#series.clear();
  }

  abstract collect(): MetricFamily;

  /** Same kind and labels as another declaration of this name. */
  sameShape(type: MetricType, labels: readonly string[] | undefined): boolean {
    const names = labels ?? [];
    return (
      this.type === type &&
      names.length === this.labelNames.length &&
      names.every((n, i) => n === this.labelNames[i])
    );
  }
}

/** A value that only goes up. */
export class Counter extends Metric<{ value: number }> {
  readonly type = "counter";

  protected initial(): { value: number } {
    return { value: 0 };
  }

  inc(labels: Labels = {}, by = 1): void {
    if (!(by >= 0) || !Number.isFinite(by)) return;
    this.state(labels).value += by;
  }

  /** Current value (tests). */
  get(labels: Labels = {}): number {
    return this.state(labels).value;
  }

  collect(): MetricFamily {
    const samples = [...this.entries()].map(([labels, s]) => ({
      name: this.name,
      labels,
      value: s.value,
    }));
    return { name: this.name, help: this.help, type: this.type, samples };
  }
}

/** A value that goes up and down. */
export class Gauge extends Metric<{ value: number }> {
  readonly type = "gauge";

  protected initial(): { value: number } {
    return { value: 0 };
  }

  set(labels: Labels, value: number): void {
    this.state(labels).value = value;
  }

  inc(labels: Labels = {}, by = 1): void {
    this.state(labels).value += by;
  }

  get(labels: Labels = {}): number {
    return this.state(labels).value;
  }

  collect(): MetricFamily {
    const samples = [...this.entries()].map(([labels, s]) => ({
      name: this.name,
      labels,
      value: s.value,
    }));
    return { name: this.name, help: this.help, type: this.type, samples };
  }
}

interface HistogramState {
  /** Non-cumulative count per bucket; the last one is `+Inf`. */
  counts: number[];
  sum: number;
  count: number;
}

/** Observations sorted into fixed buckets. */
export class Histogram extends Metric<HistogramState> {
  readonly type = "histogram";
  readonly buckets: readonly number[];

  constructor(name: string, options: HistogramOptions) {
    super(name, options);
    const buckets = [...(options.buckets ?? DEFAULT_BUCKETS)];
    if (buckets.some((b, i) => !Number.isFinite(b) || (i > 0 && b <= (buckets[i - 1] ?? 0)))) {
      throw new MetricsError(`buckets of \`${name}\` must be finite and ascending`);
    }
    this.buckets = buckets;
  }

  protected initial(): HistogramState {
    return { counts: new Array<number>(this.buckets.length + 1).fill(0), sum: 0, count: 0 };
  }

  observe(labels: Labels, value: number): void {
    if (Number.isNaN(value)) return;
    const s = this.state(labels);
    let i = this.buckets.findIndex((b) => value <= b);
    if (i < 0) i = this.buckets.length;
    s.counts[i] = (s.counts[i] ?? 0) + 1;
    s.sum += value;
    s.count += 1;
  }

  /** Observation count of a series (tests). */
  count(labels: Labels = {}): number {
    return this.state(labels).count;
  }

  collect(): MetricFamily {
    const samples: MetricSample[] = [];
    for (const [labels, s] of this.entries()) {
      let cumulative = 0;
      this.buckets.forEach((bound, i) => {
        cumulative += s.counts[i] ?? 0;
        samples.push({
          name: `${this.name}_bucket`,
          labels: { ...labels, le: formatValue(bound) },
          value: cumulative,
        });
      });
      samples.push({
        name: `${this.name}_bucket`,
        labels: { ...labels, le: "+Inf" },
        value: s.count,
      });
      samples.push({ name: `${this.name}_sum`, labels, value: s.sum });
      samples.push({ name: `${this.name}_count`, labels, value: s.count });
    }
    return { name: this.name, help: this.help, type: this.type, samples };
  }
}

type AnyMetric = Counter | Gauge | Histogram;

/** A set of named metrics. */
export class MetricsRegistry {
  readonly #metrics = new Map<string, AnyMetric>();

  counter(name: string, options: MetricOptions): Counter {
    return this.#get(name, "counter", options, () => new Counter(name, options)) as Counter;
  }

  gauge(name: string, options: MetricOptions): Gauge {
    return this.#get(name, "gauge", options, () => new Gauge(name, options)) as Gauge;
  }

  histogram(name: string, options: HistogramOptions): Histogram {
    return this.#get(name, "histogram", options, () => new Histogram(name, options)) as Histogram;
  }

  #get(name: string, type: MetricType, options: MetricOptions, create: () => AnyMetric) {
    const existing = this.#metrics.get(name);
    if (existing) {
      if (!existing.sameShape(type, options.labels)) {
        throw new MetricsError(`metric \`${name}\` is already registered with another shape`);
      }
      return existing;
    }
    const metric = create();
    this.#metrics.set(name, metric);
    return metric;
  }

  /** Every metric, sorted by name. */
  collect(): MetricFamily[] {
    return [...this.#metrics.values()]
      .map((m) => m.collect())
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** Drops every series of every metric (tests); the handles stay valid. */
  reset(): void {
    for (const m of this.#metrics.values()) m.reset();
  }

  /** The exposition of every metric. */
  render(): string {
    return renderMetrics(this.collect());
  }
}

/** The default, process-wide registry. */
export const metrics = new MetricsRegistry();

/** `Content-Type` of the text exposition format. */
export const METRICS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

/** Prometheus float formatting (`+Inf`, `-Inf`, `NaN`). */
export function formatValue(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Number.POSITIVE_INFINITY) return "+Inf";
  if (value === Number.NEGATIVE_INFINITY) return "-Inf";
  return String(value);
}

function escapeHelp(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

function escapeLabel(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function sampleLine(sample: MetricSample): string {
  const pairs = Object.entries(sample.labels).map(([k, v]) => `${k}="${escapeLabel(v)}"`);
  const labels = pairs.length > 0 ? `{${pairs.join(",")}}` : "";
  return `${sample.name}${labels} ${formatValue(sample.value)}`;
}

/** Text exposition (format 0.0.4) of `families`, one header per family. */
export function renderMetrics(families: Iterable<MetricFamily>): string {
  const lines: string[] = [];
  for (const family of families) {
    lines.push(`# HELP ${family.name} ${escapeHelp(family.help)}`);
    lines.push(`# TYPE ${family.name} ${family.type}`);
    for (const sample of family.samples) lines.push(sampleLine(sample));
  }
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}
