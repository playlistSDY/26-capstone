import test from "node:test";
import assert from "node:assert/strict";
import { mergeUsage, type UsageReport } from "./agentUsage";
const report: UsageReport = {
  turn: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
  session: { input_tokens: 200, output_tokens: 40, total_tokens: 240 },
  tts_session: { input_tokens: 10, output_tokens: 100, total_tokens: 110 },
};
test("Dialogue and audio token totals remain separate", () => {
  const merged = mergeUsage(null, report);
  assert.equal(merged.session.total_tokens, 240);
  assert.equal(merged.tts_session?.total_tokens, 110);
});
test("Late audio or older turn usage cannot decrease session totals", () => {
  const merged = mergeUsage(report, {
    turn: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    session: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
    tts_session: { input_tokens: 20, output_tokens: 200, total_tokens: 220 },
  });
  assert.equal(merged.session.total_tokens, 240);
  assert.equal(merged.tts_session?.total_tokens, 220);
});
test("Incomplete provider usage is explicitly retained", () => {
  const merged = mergeUsage(null, {
    ...report,
    session: { ...report.session, unreported_requests: 1 },
  });
  assert.equal(merged.session.unreported_requests, 1);
});
