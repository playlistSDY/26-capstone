import type { UsageReport } from "./agentUsage";
import type { SpeechClip } from "./agentSpeech";

let context: AudioContext | null = null;
export function unlockAgentAudio() {
  if (!context) context = new AudioContext();
  if (context.state === "suspended") void context.resume();
}

/** Play 24kHz PCM as chunks arrive; never wait for the complete audio response. */
export function streamAgentAudio(
  url: string,
  token: string,
  body: unknown,
  signal: AbortSignal,
  onUsage?: (usage: UsageReport) => void,
): SpeechClip {
  unlockAgentAudio();
  const ctx = context!;
  const pending: Float32Array[] = [];
  const sources = new Set<AudioBufferSourceNode>();
  let playing = false,
    finished = false,
    canceled = false;
  let error: Error | null = null;
  let nextTime = 0;
  let resolve: (() => void) | null = null;
  let reject: ((error: Error) => void) | null = null;

  function check() {
    if (error) reject?.(error);
    else if (finished && !pending.length && !sources.size) resolve?.();
  }
  function drain() {
    if (!playing || canceled || error) return;
    for (const samples of pending.splice(0)) {
      const buffer = ctx.createBuffer(1, samples.length, 24000);
      buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      sources.add(source);
      source.onended = () => {
        sources.delete(source);
        source.disconnect();
        check();
      };
      const when = Math.max(nextTime, ctx.currentTime + 0.04);
      source.start(when);
      nextTime = when + buffer.duration;
    }
    check();
  }
  const cancel = () => {
    canceled = true;
    pending.length = 0;
    error = new Error("Audio interrupted");
    for (const source of sources) {
      source.onended = null;
      try {
        source.stop();
      } catch {}
      source.disconnect();
    }
    sources.clear();
    check();
  };
  signal.addEventListener("abort", cancel, { once: true });

  void (async () => {
    try {
      const response = await fetch(url, {
        method: "POST",
        signal,
        headers: {
          "Content-Type": "application/json",
          "X-Switch-Agent-Token": token,
        },
        body: JSON.stringify(body),
      });
      if (!response.ok || !response.body)
        throw new Error("Audio stream unavailable");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let text = "";
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (canceled) return;
        text += decoder.decode(chunk.value, { stream: true });
        let index: number;
        while ((index = text.indexOf("\n")) >= 0) {
          const event = JSON.parse(text.slice(0, index));
          text = text.slice(index + 1);
          if (event.type === "audio.delta") {
            const bytes = Uint8Array.from(atob(event.pcm), (char) =>
              char.charCodeAt(0),
            );
            const view = new DataView(bytes.buffer);
            const samples = new Float32Array(bytes.length / 2);
            for (let i = 0; i < samples.length; i++)
              samples[i] = view.getInt16(i * 2, true) / 32768;
            pending.push(samples);
            drain();
          } else if (event.type === "audio.done") {
            if (event.usage) onUsage?.(event.usage);
            finished = true;
            drain();
          } else if (event.type === "audio.error") throw new Error(event.error);
        }
      }
      if (!finished) throw new Error("Audio stream ended early");
    } catch (cause) {
      error = cause instanceof Error ? cause : new Error("Audio failed");
      check();
    }
  })();

  return {
    cancel,
    play: () =>
      new Promise<void>((done, failed) => {
        resolve = done;
        reject = failed;
        playing = true;
        drain();
        check();
      }),
  };
}
