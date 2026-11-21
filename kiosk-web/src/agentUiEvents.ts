import type { CartLine } from "./domain";
export type UiSnapshot = {
  lines: CartLine[];
  place: unknown;
  screen: string;
  payment: unknown;
  editor: unknown;
  category: string;
  overlay: unknown;
};
export type UiChange = { kind: string; before: unknown; after: unknown };
export type UiEvent = UiChange & {
  id: number;
  source: "ui_or_device" | "agent";
};
export function uiChanges(before: UiSnapshot, after: UiSnapshot): UiChange[] {
  const events: UiChange[] = [];
  const old = new Map(before.lines.map((l) => [l.id, l]));
  const current = new Map(after.lines.map((l) => [l.id, l]));
  for (const line of before.lines)
    if (!current.has(line.id))
      events.push({ kind: "remove_item", before: line, after: null });
  for (const line of after.lines) {
    const previous = old.get(line.id);
    if (!previous) events.push({ kind: "add_item", before: null, after: line });
    else if (JSON.stringify(previous) !== JSON.stringify(line))
      events.push({ kind: "edit_item", before: previous, after: line });
  }
  for (const field of [
    "place",
    "screen",
    "payment",
    "editor",
    "category",
    "overlay",
  ] as const)
    if (JSON.stringify(before[field]) !== JSON.stringify(after[field]))
      events.push({ kind: field, before: before[field], after: after[field] });
  return events;
}
