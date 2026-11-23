import test from "node:test";
import assert from "node:assert/strict";
import { companionFeedback, waitingState } from "./companionFeedback";
import {
  companionPosition,
  clampPosition,
  overlaps,
} from "./companionPlacement";
test("Long waits update visible wording without claiming fictitious order progress", () => {
  assert.notEqual(
    companionFeedback("thinking", 0),
    companionFeedback("thinking", 7500),
  );
  assert.match(companionFeedback("thinking", 35000), /늦어|기다/);
  assert.match(companionFeedback("buffering", 15000), /음성/);
  assert.equal(waitingState("speaking"), false);
  assert.equal(waitingState("thinking"), true);
  assert.equal(companionFeedback("listening", 60000), "듣고 있어요");
});
test("Floating placement avoids a described control when a gap exists and clamps manual movement", () => {
  const stage = { width: 800, height: 1280 },
    size = { width: 400, height: 250 };
  const target = { x: 250, y: 1040, width: 400, height: 80 };
  const placed = companionPosition(stage, size, [target], target, "payment");
  assert.equal(overlaps({ ...placed, ...size }, target), false);
  assert.ok(placed.y + size.height <= stage.height);
  const dragged = clampPosition({ x: -900, y: 1900 }, size, stage);
  assert.equal(dragged.x, 12);
  assert.equal(dragged.y + size.height, stage.height - 12);
});
