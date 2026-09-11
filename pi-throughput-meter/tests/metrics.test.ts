import { describe, expect, it } from "vitest";
import { computeTurnMetrics, formatTurnMetrics } from "../src/metrics.js";

describe("turn throughput metrics", () => {
  it("computes TTFT and streamed output tokens per second", () => {
    const metrics = computeTurnMetrics({
      turnStartedAt: 1000,
      firstChunkAt: 1300,
      endedAt: 3300,
      outputTokens: 400,
    });

    expect(metrics).toEqual({
      ttftMs: 300,
      streamSeconds: 2,
      tokensPerSecond: 200,
      outputTokens: 400,
    });
    expect(formatTurnMetrics(metrics!)).toBe("TTFT 300 ms · ↓400 · 200.0 tok/s");
  });

  it("returns undefined when no streamed chunk was observed", () => {
    expect(
      computeTurnMetrics({
        turnStartedAt: 1000,
        firstChunkAt: undefined,
        endedAt: 1300,
        outputTokens: 20,
      }),
    ).toBeUndefined();
  });
});
