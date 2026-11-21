import test from "node:test";
import assert from "node:assert/strict";
import { findProduct } from "./catalog";
import {
  completeOrder,
  defaults,
  normalizeOptions,
  putLine,
  readDraft,
  totalPrice,
  unitPrice,
  validateOptions,
  writeDraft,
  type CartLine,
} from "./domain";

const coffee = findProduct("americano")!,
  latte = findProduct("latte")!;
const line = (id = "one", quantity = 1): CartLine => ({
  id,
  productId: "americano",
  quantity,
  options: { ...defaults(coffee), temperature: "ice" },
});
class MemoryStorage implements Storage {
  data = new Map<string, string>();
  get length() {
    return this.data.size;
  }
  clear() {
    this.data.clear();
  }
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  key(i: number) {
    return [...this.data.keys()][i] ?? null;
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
}
test("temperature is required and iced-only drinks reject HOT", () => {
  assert.match(validateOptions(coffee, defaults(coffee))!, /온도|차갑게/);
  const p = findProduct("coldbrew")!;
  assert.match(
    validateOptions(p, { ...defaults(p), temperature: "hot" })!,
    /차갑게만/,
  );
});
test("all surcharge types and quantity are priced together", () => {
  const options = {
    ...defaults(latte),
    temperature: "ice" as const,
    size: "large" as const,
    shots: 2,
    syrup: 1,
    milk: "oat" as const,
    decaf: true,
  };
  assert.equal(unitPrice(latte, options), 7100);
  assert.equal(
    totalPrice([{ id: "latte", productId: "latte", quantity: 3, options }]),
    21300,
  );
});
test("matching options merge and different temperatures remain separate", () => {
  let cart = putLine([line()], line("two", 2));
  assert.equal(cart.length, 1);
  assert.equal(cart[0].quantity, 3);
  cart = putLine(cart, {
    ...line("hot"),
    options: { ...line().options, temperature: "hot" },
  });
  assert.equal(cart.length, 2);
});
test("editing a line can merge with an existing configuration", () => {
  const hot = {
    ...line("hot", 2),
    options: { ...line().options, temperature: "hot" as const },
  };
  const result = putLine(
    [line(), hot],
    { ...hot, options: line().options },
    "hot",
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].quantity, 3);
});
test("hidden ice choices on HOT drinks do not prevent merging", () => {
  const first = {
    ...line(),
    options: {
      ...line().options,
      temperature: "hot" as const,
      ice: "less" as const,
    },
  };
  const cart = putLine([], first);
  assert.equal(cart[0].options.ice, "normal");
  const edited = putLine(cart, {
    ...line("two"),
    options: { ...line().options, temperature: "hot" },
  });
  assert.equal(edited.length, 1);
});
test("line limits, duplicate IDs, sold out items, and total limit are enforced", () => {
  assert.throws(() => putLine([], line("bad", 0)));
  assert.throws(() => putLine([line("one", 20)], line("two")));
  assert.throws(() => putLine([line()], line()));
  assert.throws(() =>
    putLine([], {
      ...line(),
      productId: "earlgrey",
      options: { ...defaults(findProduct("earlgrey")!), temperature: "hot" },
    }),
  );
  const many = Array.from({ length: 5 }, (_, i) => ({
    ...line(String(i), 20),
    options: { ...line().options, shots: i % 4, syrup: Math.floor(i / 4) },
  }));
  assert.throws(
    () => many.reduce((cart, l) => putLine(cart, l), [] as CartLine[]),
    /99/,
  );
});
test("invalid customizations cannot be saved", () => {
  assert.match(
    validateOptions(coffee, { ...line().options, milk: "oat" })!,
    /없는 옵션/,
  );
  assert.match(
    validateOptions(coffee, { ...line().options, shots: 0.5 })!,
    /0~3/,
  );
  assert.deepEqual(normalizeOptions(line().options), line().options);
});
test("draft roundtrip and corrupted draft recovery", () => {
  const storage = new MemoryStorage();
  writeDraft(storage, "takeout", [line()]);
  assert.equal(readDraft(storage)?.place, "takeout");
  assert.equal(readDraft(storage)?.lines[0].productId, "americano");
  storage.setItem("switch.kiosk.draft.v1", "{bad json");
  assert.equal(readDraft(storage), null);
  storage.setItem(
    "switch.kiosk.draft.v1",
    JSON.stringify({
      place: "store",
      lines: [{ ...line(), productId: "missing" }],
    }),
  );
  assert.equal(readDraft(storage), null);
});
test("order completion is idempotent and generates daily order numbers", () => {
  const storage = new MemoryStorage(),
    date = new Date("2026-11-19T03:00:00Z");
  const input = {
    id: "attempt",
    place: "takeout" as const,
    lines: [line()],
    method: "card" as const,
  };
  const a = completeOrder(storage, input, date),
    b = completeOrder(storage, input, date);
  assert.equal(a.number, "001");
  assert.deepEqual(a, b);
  assert.equal(
    completeOrder(storage, { ...input, id: "second" }, date).number,
    "002",
  );
  assert.equal(
    completeOrder(
      storage,
      { ...input, id: "tomorrow" },
      new Date("2026-11-20T03:00:00Z"),
    ).number,
    "001",
  );
});
test("failed persistence never silently clears a draft", () => {
  const storage = new MemoryStorage();
  writeDraft(storage, "store", [line()]);
  storage.setItem = () => {
    throw new Error("disk full");
  };
  assert.throws(() =>
    completeOrder(storage, {
      id: "one",
      place: "store",
      lines: [line()],
      method: "card",
    }),
  );
  assert.equal(readDraft(storage)?.lines.length, 1);
});

test("An unchosen order type survives draft restoration without becoming store", () => {
  const storage = new MemoryStorage();
  writeDraft(storage, "store", [line()], false);
  assert.equal(readDraft(storage)?.placeChosen, false);
  writeDraft(storage, "takeout", [line()], true);
  assert.notEqual(readDraft(storage)?.placeChosen, false);
});
