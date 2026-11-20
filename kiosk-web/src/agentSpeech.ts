/** Sentence queue for OpenAI audio. Keys and audio generation stay on the server. */
export type SpeechClip = { play: () => Promise<void>; cancel: () => void };
export type SpeechTransport = {
  stream?: (text: string, signal: AbortSignal) => SpeechClip;
  synthesize: (text: string, signal: AbortSignal) => Promise<Blob>;
  play: (blob: Blob, ended: () => void, failed: () => void) => () => void;
};

const playAudio: SpeechTransport["play"] = (blob, ended, failed) => {
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  const release = () => {
    audio.onended = null;
    audio.onerror = null;
    audio.pause();
    audio.removeAttribute("src");
    URL.revokeObjectURL(url);
  };
  audio.onended = () => {
    release();
    ended();
  };
  audio.onerror = () => {
    release();
    failed();
  };
  void audio.play().catch(() => {
    release();
    failed();
  });
  return release;
};

export class AgentSpeech {
  readonly supported: boolean;
  enabled = true;
  private generation = 0;
  private text = "";
  private consumed = 0;
  private queue: { audio?: Promise<Blob | null>; clip?: SpeechClip }[] = [];
  private controller = new AbortController();
  private stopPlayback: (() => void) | null = null;
  private active = false;
  private done: (() => void) | null = null;
  private failed = false;
  private transport: SpeechTransport;

  constructor(
    private onSpeaking: (speaking: boolean) => void,
    private onError: () => void,
    transport?: SpeechTransport,
  ) {
    this.supported = !!transport || typeof AudioContext !== "undefined";
    this.transport = transport ?? {
      synthesize: async () => {
        throw new Error("TTS not configured");
      },
      play: playAudio,
    };
  }

  configure(stream: NonNullable<SpeechTransport["stream"]>) {
    this.transport.stream = stream;
  }

  stop() {
    this.generation++;
    this.controller.abort();
    this.controller = new AbortController();
    this.stopPlayback?.();
    this.stopPlayback = null;
    this.queue = [];
    this.active = false;
    this.done = null;
    this.text = "";
    this.consumed = 0;
    this.failed = false;
    this.onSpeaking(false);
  }

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    if (!enabled) {
      const done = this.done;
      this.stop();
      done?.();
    }
  }

  begin() {
    this.stop();
  }

  append(delta: string) {
    this.text += delta;
    if (!this.enabled || !this.supported || this.failed) return;
    const remainder = this.text.slice(this.consumed);
    const complete = remainder.match(/^[\s\S]*?[.!?。！？](?:\s|$)/u);
    if (complete) {
      this.enqueue(complete[0]);
      this.consumed += complete[0].length;
      this.append("");
    }
    void this.pump();
  }

  finish(text: string, onDone: () => void) {
    if (text !== this.text) {
      this.stop();
      this.text = text;
    }
    if (!this.enabled || !this.supported) {
      onDone();
      return;
    }
    if (this.failed) return;
    const remaining = this.text.slice(this.consumed).trim();
    if (remaining) this.enqueue(remaining);
    this.consumed = this.text.length;
    this.done = onDone;
    void this.pump();
  }

  private enqueue(text: string) {
    if (this.transport.stream) {
      this.queue.push({
        clip: this.transport.stream(text.trim(), this.controller.signal),
      });
      return;
    }
    // Prefetch sentences while the preceding sentence plays; always play in order.
    this.queue.push({
      audio: this.transport
        .synthesize(text.trim(), this.controller.signal)
        .catch(() => null),
    });
  }

  private async pump() {
    if (this.active || this.failed) return;
    const next = this.queue.shift();
    if (!next) {
      this.onSpeaking(false);
      const done = this.done;
      this.done = null;
      done?.();
      return;
    }
    this.active = true;
    this.onSpeaking(true);
    const generation = this.generation;
    const fail = () => {
      if (generation !== this.generation) return;
      this.failed = true;
      this.queue = [];
      this.active = false;
      this.onSpeaking(false);
      this.onError();
    };
    if (next.clip) {
      try {
        await next.clip.play();
        if (generation !== this.generation) return;
        this.active = false;
        void this.pump();
      } catch {
        fail();
      }
      return;
    }
    const blob = await next.audio;
    if (generation !== this.generation) return;
    if (!blob) {
      fail();
      return;
    }
    this.stopPlayback = this.transport.play(
      blob,
      () => {
        if (generation !== this.generation) return;
        this.active = false;
        this.stopPlayback = null;
        void this.pump();
      },
      fail,
    );
  }
}
