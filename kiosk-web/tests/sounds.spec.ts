import { test, expect } from "@playwright/test";
import { mockBackend } from "./backend-fixture";

test("all twelve local sound previews play once with distinct recordings", async ({
  page,
}) => {
  await mockBackend(page);
  await page.addInitScript(() => {
    const probe = window as unknown as { played: number[] };
    probe.played = [];
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (
      ...args: Parameters<typeof start>
    ) {
      probe.played.push(Math.round((this.buffer?.duration ?? 0) * 1000));
      return start.apply(this, args);
    };
  });
  await page.goto("/?printerSetup=1");
  const manifest = await (
    await page.request.get("/assets/sounds/v2/manifest.json")
  ).json();
  const buttons = page.locator("[data-sound-preview]");
  await expect(buttons).toHaveCount(12);
  for (let i = 0; i < manifest.sounds.length; i++) {
    const cue = manifest.sounds[i];
    await page
      .getByRole("button", { name: `${cue.label} 소리 듣기`, exact: true })
      .click();
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as unknown as { played: number[] }).played.length,
        ),
      )
      .toBe(i + 1);
    expect(
      await page.evaluate(() =>
        (window as unknown as { played: number[] }).played.at(-1),
      ),
    ).toBe(cue.durationMs);
  }
  await page.screenshot({ path: "qa/sound-settings.png", fullPage: true });
});

test("the browser plays softer touch cues and distinct confirmations without clipping", async ({
  page,
}) => {
  await mockBackend(page);
  await page.goto("/");
  const levels = await page.evaluate(async () => {
    const manifest = await (
      await fetch("/assets/sounds/v2/manifest.json")
    ).json();
    const output = [];
    for (const cue of manifest.sounds) {
      const decoder = new OfflineAudioContext(1, 1, 48000);
      const buffer = await decoder.decodeAudioData(
        await (await fetch(`/assets/sounds/v2/${cue.file}`)).arrayBuffer(),
      );
      const ctx = new OfflineAudioContext(1, buffer.length, 48000);
      const source = ctx.createBufferSource(),
        gain = ctx.createGain();
      source.buffer = buffer;
      gain.gain.value = 0.95;
      source.connect(gain);
      gain.connect(ctx.destination);
      source.start();
      const samples = (await ctx.startRendering()).getChannelData(0);
      let peak = 0,
        power = 0;
      for (const sample of samples) {
        peak = Math.max(peak, Math.abs(sample));
        power += sample * sample;
      }
      output.push({
        id: cue.id,
        durationMs: Math.round(buffer.duration * 1000),
        peak,
        rms: Math.sqrt(power / samples.length),
        start: samples[0],
        end: samples.at(-1),
      });
    }
    return output;
  });
  expect(levels).toHaveLength(12);
  for (const level of levels) {
    expect(level.peak).toBeLessThan(0.6);
    expect(level.rms).toBeGreaterThan(0.08);
    expect(Math.abs(level.start)).toBeLessThan(0.001);
    expect(Math.abs(level.end ?? 0)).toBeLessThan(0.001);
  }
  const tap = levels.find((level) => level.id === "tap")!;
  const scroll = levels.find((level) => level.id === "scroll")!;
  const success = levels.find((level) => level.id === "success")!;
  expect(tap.durationMs).toBeLessThan(100);
  expect(scroll.peak).toBeLessThan(tap.peak);
  expect(tap.peak).toBeLessThan(success.peak);
  expect(success.durationMs).toBeLessThan(350);
});
