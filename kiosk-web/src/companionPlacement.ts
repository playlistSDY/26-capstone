export type Rect = { x: number; y: number; width: number; height: number };
export function overlaps(a: Rect, b: Rect, gap = 8) {
  return (
    a.x < b.x + b.width + gap &&
    a.x + a.width + gap > b.x &&
    a.y < b.y + b.height + gap &&
    a.y + a.height + gap > b.y
  );
}
export function clampPosition(
  position: { x: number; y: number },
  size: { width: number; height: number },
  stage: { width: number; height: number },
) {
  return {
    x: Math.max(12, Math.min(stage.width - size.width - 12, position.x)),
    y: Math.max(
      72,
      Math.min(Math.max(72, stage.height - size.height - 12), position.y),
    ),
  };
}
/** Preserve the existing layout; choose the least obstructive overlay position. */
export function companionPosition(
  stage: { width: number; height: number },
  size: { width: number; height: number },
  obstacles: Rect[],
  focus: Rect | null,
  screen: string,
) {
  const preferred = focus
    ? {
        x: focus.x + focus.width / 2 - size.width / 2,
        y: focus.y - size.height - 18,
      }
    : {
        x: screen === "cart" ? 20 : stage.width - size.width - 20,
        y:
          screen === "cart"
            ? stage.height * 0.42
            : stage.height - size.height - 24,
      };
  const candidates = [
    preferred,
    ...(focus ? [{ x: preferred.x, y: focus.y + focus.height + 18 }] : []),
  ];
  for (const y of [
    92,
    stage.height * 0.24,
    stage.height * 0.42,
    stage.height * 0.62,
    stage.height - size.height - 24,
  ])
    for (const x of [20, stage.width - size.width - 20])
      candidates.push({ x, y });
  const score = (p: { x: number; y: number }) => {
    const box = { ...p, ...size };
    let total = focus && overlaps(box, focus, 12) ? 1e8 : 0;
    for (const o of obstacles) {
      const area =
        Math.max(
          0,
          Math.min(box.x + box.width, o.x + o.width) - Math.max(box.x, o.x),
        ) *
        Math.max(
          0,
          Math.min(box.y + box.height, o.y + o.height) - Math.max(box.y, o.y),
        );
      total += area;
    }
    return (
      total + (Math.abs(p.x - preferred.x) + Math.abs(p.y - preferred.y)) * 0.2
    );
  };
  return candidates
    .map((p) => clampPosition(p, size, stage))
    .sort((a, b) => score(a) - score(b))[0];
}
