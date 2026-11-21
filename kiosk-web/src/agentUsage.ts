export type TokenCounts = {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cached_input_tokens?: number;
  requests?: number;
  unreported_requests?: number;
  estimated_cost_usd?: number;
  unpriced_requests?: number;
};
export type UsageReport = {
  turn: TokenCounts;
  session: TokenCounts;
  tts_turn?: TokenCounts;
  tts_session?: TokenCounts;
};
export function mergeUsage(
  previous: UsageReport | null,
  incoming: UsageReport,
): UsageReport {
  const maximum = (
    a: TokenCounts | undefined,
    b: TokenCounts | undefined,
  ): TokenCounts => ({
    input_tokens: Math.max(a?.input_tokens ?? 0, b?.input_tokens ?? 0),
    output_tokens: Math.max(a?.output_tokens ?? 0, b?.output_tokens ?? 0),
    total_tokens: Math.max(a?.total_tokens ?? 0, b?.total_tokens ?? 0),
    estimated_cost_usd: Math.max(
      a?.estimated_cost_usd ?? 0,
      b?.estimated_cost_usd ?? 0,
    ),
    unpriced_requests: Math.max(
      a?.unpriced_requests ?? 0,
      b?.unpriced_requests ?? 0,
    ),
    cached_input_tokens: Math.max(
      a?.cached_input_tokens ?? 0,
      b?.cached_input_tokens ?? 0,
    ),
    unreported_requests: Math.max(
      a?.unreported_requests ?? 0,
      b?.unreported_requests ?? 0,
    ),
  });
  return {
    ...incoming,
    session: maximum(previous?.session, incoming.session),
    tts_session: maximum(previous?.tts_session, incoming.tts_session),
  };
}

export function formatEstimatedCost(
  ...counts: (TokenCounts | undefined)[]
): string {
  const cost = counts.reduce(
    (sum, value) => sum + (value?.estimated_cost_usd ?? 0),
    0,
  );
  const incomplete = counts.some(
    (value) =>
      (value?.unpriced_requests ?? 0) > 0 ||
      (value?.unreported_requests ?? 0) > 0 ||
      (!!value?.total_tokens && value.estimated_cost_usd === undefined),
  );
  if (incomplete && cost === 0) return "비용 미집계";
  return `예상 $${cost.toFixed(cost >= 0.01 ? 4 : 6)}${incomplete ? "+" : ""}`;
}
