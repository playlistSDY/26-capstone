import test from "node:test";
import assert from "node:assert/strict";
import { findProduct } from "./catalog";
import { completeOrder, defaults, type Order } from "./domain";
import {
  RECEIPT_PROFILE,
  receiptDocument,
  sampleReceiptOrder,
  readPrintRequests,
  savePrintRequest,
} from "./receiptModel";

class Store implements Storage {
  values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  key(i: number) {
    return [...this.values.keys()][i] ?? null;
  }
  clear() {
    this.values.clear();
  }
  getItem(k: string) {
    return this.values.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.values.set(k, v);
  }
  removeItem(k: string) {
    this.values.delete(k);
  }
}
test("sample receipt quantities, surcharges and totals reconcile", () => {
  const document = receiptDocument(sampleReceiptOrder());
  assert.equal(document.quantity, 4);
  assert.equal(document.total, 17200);
  assert.equal(
    document.items.reduce((n, item) => n + item.amount!, 0),
    document.total,
  );
  assert.match(document.items[1].optionsLabel, /오트밀크/);
  assert.equal(document.items[1].unitPrice, 6300);
  assert.equal(document.legacy, false);
});
test("completed orders keep names and prices when the menu changes", () => {
  const p = findProduct("americano")!,
    storage = new Store();
  const order = completeOrder(storage, {
    id: "snapshot-test",
    place: "store",
    method: "card",
    lines: [
      {
        id: "line",
        productId: p.id,
        quantity: 2,
        options: { ...defaults(p), temperature: "ice" },
      },
    ],
  });
  const original = { name: p.name, price: p.price };
  try {
    p.name = "바뀐 메뉴 이름";
    p.price = 9900;
    const document = receiptDocument(order);
    assert.equal(document.items[0].name, original.name);
    assert.equal(document.items[0].unitPrice, original.price);
    assert.equal(document.total, 6400);
  } finally {
    p.name = original.name;
    p.price = original.price;
  }
});
test("legacy order receipt still opens, even if a product has been removed", () => {
  const order = sampleReceiptOrder();
  const legacy: Order = {
    ...order,
    lines: order.lines.map(({ snapshot, ...line }) => line),
  };
  assert.equal(receiptDocument(legacy).legacy, true);
  legacy.lines[0].productId = "removed-product";
  assert.equal(receiptDocument(legacy).items[0].amount, null);
  assert.equal(receiptDocument(legacy).total, 17200);
});
test("USB receipt layout stays within the TM-m30 80mm printable area", () => {
  assert.equal(
    RECEIPT_PROFILE.paperWidthMm - RECEIPT_PROFILE.sideMarginMm * 2,
    RECEIPT_PROFILE.printableWidthMm,
  );
  assert.equal(RECEIPT_PROFILE.printableWidthMm * 8, RECEIPT_PROFILE.dots);
});
test("print attempts replace their status, never claim physical success, and keep a bounded history", () => {
  const storage = new Store();
  for (let i = 0; i < 55; i++)
    savePrintRequest(storage, {
      id: String(i),
      orderId: "one-order",
      variant: "receipt",
      createdAt: new Date().toISOString(),
      state: "dialog-opened",
    });
  savePrintRequest(storage, {
    id: "54",
    orderId: "one-order",
    variant: "receipt",
    createdAt: new Date().toISOString(),
    state: "dialog-closed",
  });
  const requests = readPrintRequests(storage);
  assert.equal(requests.length, 50);
  assert.equal(requests.filter((job) => job.id === "54").length, 1);
  assert.equal(requests.at(-1)?.state, "dialog-closed");
  assert.equal(readPrintRequests(new Store()).length, 0);
});
