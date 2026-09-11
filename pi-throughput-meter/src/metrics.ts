export type TurnMetricInput = {
  turnStartedAt: number;
  firstChunkAt: number | undefined;
  endedAt: number;
  outputTokens: number;
};

export type TurnMetrics = {
  ttftMs: number;
  streamSeconds: number;
  tokensPerSecond: number;
  outputTokens: number;
};

export function computeTurnMetrics(input: TurnMetricInput): TurnMetrics | undefined {
  const { turnStartedAt, firstChunkAt, endedAt, outputTokens } = input;
  if (firstChunkAt === undefined || endedAt <= firstChunkAt) return undefined;

  const streamSeconds = (endedAt - firstChunkAt) / 1000;
  return {
    ttftMs: firstChunkAt - turnStartedAt,
    streamSeconds,
    tokensPerSecond: outputTokens / streamSeconds,
    outputTokens,
  };
}

export function formatTurnMetrics(metrics: TurnMetrics): string {
  return `TTFT ${metrics.ttftMs} ms · ↓${metrics.outputTokens} · ${metrics.tokensPerSecond.toFixed(1)} tok/s`;
}
