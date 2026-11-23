export type AudioActivity = { active: boolean; level: number };
export type AudioFrame = { start: number; end: number; level: number };

/** Actual output samples, not generated text length or a random talking timer. */
export function pcmLevel(samples: Float32Array): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  const rms = Math.sqrt(sum / samples.length);
  return rms < 0.003 ? 0 : Math.min(1, Math.sqrt(rms) * 2.2);
}
export function activityAt(
  frames: AudioFrame[],
  audioTime: number,
): AudioActivity {
  const frame = frames.find(
    (item) => item.start <= audioTime && audioTime < item.end,
  );
  return { active: !!frame, level: frame?.level ?? 0 };
}
