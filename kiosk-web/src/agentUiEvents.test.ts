import test from "node:test";
import assert from "node:assert/strict";
import { uiChanges, type UiSnapshot } from "./agentUiEvents";
import { defaults } from "./domain";
import { findProduct } from "./catalog";
const empty: UiSnapshot = {
  lines: [],
  place: "store",
  screen: "menu",
  payment: null,
  editor: null,
  category: "커피",
  overlay: null,
};
const line = {
  id: "line",
  productId: "americano",
  quantity: 1,
  options: {
    ...defaults(findProduct("americano")!),
    temperature: "ice" as const,
  },
};
test("Direct add, edit and delete are preserved even when the final cart is empty", () => {
  const added = { ...empty, lines: [line] };
  const edited = { ...added, lines: [{ ...line, quantity: 2 }] };
  assert.equal(uiChanges(empty, added)[0].kind, "add_item");
  assert.equal(uiChanges(added, edited)[0].kind, "edit_item");
  assert.equal(uiChanges(edited, empty)[0].kind, "remove_item");
});
test("Place, navigation, editor selection and payment changes are represented", () => {
  const kinds = uiChanges(empty, {
    ...empty,
    place: "takeout",
    screen: "payment",
    payment: { method: "card", status: "waiting" },
    editor: { product_id: "latte" },
  }).map((e) => e.kind);
  assert.deepEqual(kinds, ["place", "screen", "payment", "editor"]);
});
