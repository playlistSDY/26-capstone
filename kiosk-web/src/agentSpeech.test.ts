import assert from "node:assert/strict";
import test from "node:test";
import { AgentSpeech } from "./agentSpeech";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function fixture() {
  const texts = new WeakMap<Blob, string>();
  const played: { text: string; ended: () => void; failed: () => void }[] = [];
  const signals: AbortSignal[] = [];
  let stopped = 0;
  const errors: string[] = [];
  const speech = new AgentSpeech(
    () => {},
    () => errors.push("failed"),
    {
      synthesize: async (text, signal) => {
        signals.push(signal);
        const blob = new Blob([text]);
        texts.set(blob, text);
        return blob;
      },
      play: (blob, ended, failed) => {
        played.push({ text: texts.get(blob)!, ended, failed });
        return () => stopped++;
      },
    },
  );
  return { speech, played, errors, signals, stopped: () => stopped };
}

test("TTS buffers words, prefetches sentences and acknowledges only after playback", async () => {
  const { speech, played, signals } = fixture();
  let done = false;
  speech.append("따뜻한 라");
  assert.equal(signals.length, 0);
  speech.append("떼예요. 이대로 결제할까요?");
  speech.finish("따뜻한 라떼예요. 이대로 결제할까요?", () => (done = true));
  await tick();
  assert.equal(signals.length, 2);
  assert.equal(played.length, 1);
  assert.equal(done, false);
  played[0].ended();
  await tick();
  assert.equal(played.length, 2);
  assert.equal(done, false);
  played[1].ended();
  assert.equal(done, true);
});

test("Interrupt cancels fetched audio, playback and stale callbacks", async () => {
  const { speech, played, signals, stopped } = fixture();
  let done = false;
  speech.append("첫 문장. 다음 문장.");
  speech.finish("첫 문장. 다음 문장.", () => (done = true));
  await tick();
  speech.stop();
  played[0].ended();
  await tick();
  assert.equal(played.length, 1);
  assert.equal(stopped(), 1);
  assert.ok(signals.every((signal) => signal.aborted));
  assert.equal(done, false);
});

test("Host final text replaces provisional audio", async () => {
  const { speech, played } = fixture();
  speech.append("확인할게요.");
  await tick();
  speech.finish("차가운 라떼 한 잔이에요.", () => {});
  await tick();
  assert.equal(played.at(-1)!.text, "차가운 라떼 한 잔이에요.");
});

test("TTS playback failure blocks confirmation until explicit text mode", async () => {
  const { speech, played, errors } = fixture();
  let done = false;
  speech.finish("이대로 결제할까요?", () => (done = true));
  await tick();
  played[0].failed();
  assert.equal(errors.length, 1);
  assert.equal(done, false);
  speech.setEnabled(false);
  assert.equal(done, true);
});

test("Streamed clips prefetch immediately but play in sentence order", async () => {
  const { speech } = fixture();
  const started: string[] = [];
  const ended: (() => void)[] = [];
  const prefetched: string[] = [];
  speech.configure((text) => {
    prefetched.push(text);
    return {
      cancel: () => {},
      play: () => {
        started.push(text);
        return new Promise<void>((resolve) => ended.push(resolve));
      },
    };
  });
  speech.append("첫 문장. 두 번째 문장.");
  speech.finish("첫 문장. 두 번째 문장.", () => {});
  assert.equal(prefetched.length, 2);
  assert.deepEqual(started, ["첫 문장."]);
  ended[0]();
  await tick();
  assert.deepEqual(started, ["첫 문장.", "두 번째 문장."]);
  ended[1]();
});
