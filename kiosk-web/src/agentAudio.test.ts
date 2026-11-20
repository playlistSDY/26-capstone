import test from "node:test";
import assert from "node:assert/strict";
import { streamAgentAudio } from "./agentAudio";

test("PCM playback starts before audio.done and interruption stops scheduled sources", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalContext = Object.getOwnPropertyDescriptor(
    globalThis,
    "AudioContext",
  );
  const sources: {
    started: boolean;
    stopped: boolean;
    onended: (() => void) | null;
  }[] = [];
  class Context {
    state = "running";
    currentTime = 0;
    destination = {};
    createBuffer(_channels: number, length: number, rate: number) {
      return { duration: length / rate, copyToChannel: () => {} };
    }
    createBufferSource() {
      const source = {
        buffer: null,
        started: false,
        stopped: false,
        onended: null as (() => void) | null,
        connect: () => {},
        disconnect: () => {},
        start: () => {
          source.started = true;
        },
        stop: () => {
          source.stopped = true;
        },
      };
      sources.push(source);
      return source;
    }
  }
  Object.defineProperty(globalThis, "AudioContext", {
    configurable: true,
    value: Context,
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalContext)
      Object.defineProperty(globalThis, "AudioContext", originalContext);
    else Reflect.deleteProperty(globalThis, "AudioContext");
  });
  let writer: ReadableStreamDefaultController<Uint8Array>;
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          writer = controller;
        },
      }),
    );
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  const emit = (event: unknown) =>
    writer.enqueue(new TextEncoder().encode(JSON.stringify(event) + "\n"));
  const controller = new AbortController();
  const clip = streamAgentAudio("/test", "test-token", {}, controller.signal);
  let done = false;
  const playing = clip.play().then(() => {
    done = true;
  });
  await tick();
  emit({ type: "audio.delta", pcm: "AAAAAA==", sample_rate: 24000 });
  await tick();
  assert.equal(sources[0].started, true);
  assert.equal(done, false);
  emit({ type: "audio.done" });
  writer!.close();
  await tick();
  assert.equal(done, false);
  sources[0].onended!();
  await playing;
  assert.equal(done, true);

  const secondController = new AbortController();
  const second = streamAgentAudio(
    "/test",
    "test-token",
    {},
    secondController.signal,
  );
  const rejected = assert.rejects(second.play(), /interrupted/);
  await tick();
  emit({ type: "audio.delta", pcm: "AAAAAA==", sample_rate: 24000 });
  await tick();
  secondController.abort();
  await rejected;
  assert.equal(sources[1].stopped, true);
  writer!.close();
});
