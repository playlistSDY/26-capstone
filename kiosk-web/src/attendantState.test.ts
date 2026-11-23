import test from "node:test";
import assert from "node:assert/strict";
import { attendantState } from "./attendantState";
import { pcmLevel, activityAt } from "./audioActivity";
const idle = {
  ready: true,
  busy: false,
  speaking: false,
  audioPending: false,
  typing: false,
};
test("Text sessions do not pretend to capture a microphone", () => {
  assert.equal(attendantState(idle), "ready");
  assert.equal(attendantState({ ...idle, typing: true }), "typing");
  assert.equal(attendantState({ ...idle, voice: { phase: "off" } }), "ready");
  assert.equal(
    attendantState({ ...idle, voice: { phase: "listening" } }),
    "listening",
  );
  assert.equal(
    attendantState({ ...idle, speaking: true, voice: { phase: "speech" } }),
    "hearing",
  );
});
test("Preparing an answer or queued speech is distinct from audible playback", () => {
  assert.equal(
    attendantState({ ...idle, busy: true, audioPending: true }),
    "thinking",
  );
  assert.equal(attendantState({ ...idle, audioPending: true }), "buffering");
  assert.equal(
    attendantState({ ...idle, busy: true, speaking: true }),
    "speaking",
  );
  assert.equal(
    attendantState({ ...idle, ready: false, speaking: true }),
    "offline",
  );
});
test("Mouth activity follows actual samples and scheduled audio time, including silent gaps", () => {
  assert.equal(pcmLevel(new Float32Array(960)), 0);
  const quiet = pcmLevel(Float32Array.from({ length: 960 }, () => 0.01));
  const loud = pcmLevel(Float32Array.from({ length: 960 }, () => 0.2));
  assert.ok(loud > quiet && quiet > 0 && loud <= 1);
  const frames = [
    { start: 0.04, end: 0.08, level: loud },
    { start: 0.08, end: 0.12, level: 0 },
  ];
  assert.deepEqual(activityAt(frames, 0), { active: false, level: 0 });
  assert.deepEqual(activityAt(frames, 0.05), { active: true, level: loud });
  assert.deepEqual(activityAt(frames, 0.1), { active: true, level: 0 });
  assert.deepEqual(activityAt(frames, 0.13), { active: false, level: 0 });
});
