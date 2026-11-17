import { Events } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import {
  EventBus,
  exemptFromBusCheck,
  MetricsError,
  MetricsRegistry,
  OVERFLOW_LABEL,
  renderMetrics,
  topicPrefix,
} from "../src/index.js";

// The bus is counted by topic prefix here; the payloads are not what is tested.
exemptFromBusCheck(["voice.latency", "voice.utterance", "llm.budget"]);

describe("metrics", () => {
  it("renders counters and gauges in the text format", () => {
    const r = new MetricsRegistry();
    const c = r.counter("test_requests_total", { help: "Requests.", labels: ["path"] });
    c.inc({ path: "/a" });
    c.inc({ path: "/a" }, 2);
    c.inc({ path: 'q"\\\n' });
    c.inc({ path: "/a" }, -1); // ignored: counters only go up
    r.gauge("test_up", { help: "Up.\nSecond line" }).set({}, 1);
    expect(r.render()).toBe(
      [
        "# HELP test_requests_total Requests.",
        "# TYPE test_requests_total counter",
        'test_requests_total{path="/a"} 3',
        'test_requests_total{path="q\\"\\\\\\n"} 1',
        "# HELP test_up Up.\\nSecond line",
        "# TYPE test_up gauge",
        "test_up 1",
        "",
      ].join("\n"),
    );
  });

  it("renders cumulative histogram buckets", () => {
    const r = new MetricsRegistry();
    const h = r.histogram("test_latency_seconds", {
      help: "Latency.",
      labels: ["model"],
      buckets: [0.5, 1],
    });
    h.observe({ model: "a:b" }, 0.2);
    h.observe({ model: "a:b" }, 0.7);
    h.observe({ model: "a:b" }, 4);
    expect(h.count({ model: "a:b" })).toBe(3);
    const lines = r.render().split("\n");
    expect(lines).toContain('test_latency_seconds_bucket{model="a:b",le="0.5"} 1');
    expect(lines).toContain('test_latency_seconds_bucket{model="a:b",le="1"} 2');
    expect(lines).toContain('test_latency_seconds_bucket{model="a:b",le="+Inf"} 3');
    expect(lines).toContain('test_latency_seconds_sum{model="a:b"} 4.9');
    expect(lines).toContain('test_latency_seconds_count{model="a:b"} 3');
  });

  it("collapses label combinations past maxSeries", () => {
    const r = new MetricsRegistry();
    const c = r.counter("test_capped_total", { help: "x", labels: ["k"], maxSeries: 2 });
    for (const k of ["a", "b", "c", "d"]) c.inc({ k });
    const samples = r.collect()[0]?.samples ?? [];
    expect(samples.map((s) => s.labels.k)).toEqual(["a", "b", OVERFLOW_LABEL]);
    expect(c.get({ k: OVERFLOW_LABEL })).toBe(2);
  });

  it("returns the same handle for the same name and rejects other shapes", () => {
    const r = new MetricsRegistry();
    const a = r.counter("test_same_total", { help: "x", labels: ["k"] });
    expect(r.counter("test_same_total", { help: "x", labels: ["k"] })).toBe(a);
    expect(() => r.gauge("test_same_total", { help: "x", labels: ["k"] })).toThrow(MetricsError);
    expect(() => r.counter("test_same_total", { help: "x" })).toThrow(MetricsError);
    expect(() => r.counter("bad-name", { help: "x" })).toThrow(MetricsError);
    expect(() => r.counter("test_le", { help: "x", labels: ["le"] })).toThrow(MetricsError);
  });

  it("renders special values", () => {
    expect(
      renderMetrics([
        {
          name: "x",
          help: "h",
          type: "gauge",
          samples: [
            { name: "x", labels: { a: "1" }, value: Number.POSITIVE_INFINITY },
            { name: "x", labels: { a: "2" }, value: Number.NaN },
          ],
        },
      ]),
    ).toBe('# HELP x h\n# TYPE x gauge\nx{a="1"} +Inf\nx{a="2"} NaN\n');
    expect(renderMetrics([])).toBe("");
  });

  it("counts bus events by topic prefix and drops", () => {
    expect(topicPrefix("platform.message.created")).toBe("platform");
    expect(topicPrefix("plain")).toBe("plain");
    const r = new MetricsRegistry();
    const bus = new EventBus({ capacity: 1, metrics: r });
    const sub = bus.subscribe("*");
    bus.publish("test", Events.VoiceLatency, null as never);
    bus.publish("test", Events.VoiceUtteranceEvent, null as never);
    bus.publish("test", Events.LlmBudget, null as never);
    const published = r.counter("miyoria_bus_events_published_total", {
      help: "",
      labels: ["prefix"],
    });
    expect(published.get({ prefix: "voice" })).toBe(2);
    expect(published.get({ prefix: "llm" })).toBe(1);
    expect(r.counter("miyoria_bus_events_dropped_total", { help: "" }).get()).toBe(2);
    sub.close();
  });
});
