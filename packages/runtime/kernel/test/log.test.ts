import { describe, expect, it } from "vitest";
import { formatLogLine } from "../src/index.js";

describe("formatLogLine", () => {
  it("formats_a_pino_line_readably", () => {
    const time = new Date(2026, 10, 1, 9, 5, 7).getTime();
    const line = JSON.stringify({
      level: 40,
      time,
      pid: 1,
      hostname: "h",
      scope: "llm.router",
      module: "llm",
      model: "deepseek:chat",
      attempts: 2,
      err: { type: "Error", message: "boom", stack: "..." },
      msg: "model failed",
    });
    expect(formatLogLine(line, false)).toBe(
      "09:05:07 WARN  llm llm.router model failed model=deepseek:chat attempts=2 err=boom",
    );
  });

  it("passes_non_json_through", () => {
    expect(formatLogLine("plain text", false)).toBe("plain text");
  });
});
