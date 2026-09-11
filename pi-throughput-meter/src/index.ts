import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { computeTurnMetrics, formatTurnMetrics } from "./metrics.js";

export default function piThroughputMeter(pi: ExtensionAPI): void {
  let turnStartedAt = 0;
  let firstChunkAt: number | undefined;

  pi.on("turn_start", async (_event, ctx) => {
    turnStartedAt = Date.now();
    firstChunkAt = undefined;
    if (ctx.hasUI) {
      ctx.ui.setStatus("throughput", ctx.ui.theme.fg("dim", "speed: waiting for first token…"));
    }
  });

  pi.on("message_update", async (_event, ctx) => {
    if (firstChunkAt !== undefined) return;
    firstChunkAt = Date.now();
    if (ctx.hasUI) {
      ctx.ui.setStatus(
        "throughput",
        ctx.ui.theme.fg("accent", `TTFT ${firstChunkAt - turnStartedAt} ms · streaming…`),
      );
    }
  });

  pi.on("turn_end", async (event, ctx) => {
    if (!ctx.hasUI) return;
    const outputTokens = event.message.role === "assistant" ? event.message.usage.output : 0;
    const metrics = computeTurnMetrics({
      turnStartedAt,
      firstChunkAt,
      endedAt: Date.now(),
      outputTokens,
    });
    const label = metrics ? formatTurnMetrics(metrics) : "speed: unavailable";
    ctx.ui.setStatus("throughput", ctx.ui.theme.fg(metrics ? "success" : "warning", label));
  });
}

export { computeTurnMetrics, formatTurnMetrics } from "./metrics.js";
export type { TurnMetricInput, TurnMetrics } from "./metrics.js";
