import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { categories, products, productImage } from "./catalog";
import { defaults, validateOptions } from "./domain";

test("all supplied photos are preserved and grouped into distinct menu items", () => {
  assert.equal(products.length, 112);
  assert.equal(new Set(products.map((p) => p.sourceName)).size, 112);
  assert.equal(
    products.reduce((n, p) => n + p.sourcePhotos.length, 0),
    151,
  );
  assert.equal(products.filter((p) => p.temperatures.length === 2).length, 39);
  for (const p of products) {
    assert.ok(p.categories.every((c) => categories.includes(c)));
    for (const photo of p.sourcePhotos) {
      const bytes = readFileSync(
        new URL("../public/" + photo.path, import.meta.url),
      );
      assert.ok(
        bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a" ||
          bytes.subarray(0, 2).toString("hex") === "ffd8",
      );
      assert.equal(
        createHash("sha256").update(bytes).digest("hex"),
        photo.sha256,
      );
    }
    if (p.temperatures.length === 2)
      assert.notEqual(productImage(p, "hot"), productImage(p, "ice"));
  }
});
test("every menu accepts only photographed temperatures and defaults single-temperature items", () => {
  for (const p of products) {
    const initial = defaults(p);
    assert.equal(
      initial.temperature,
      p.temperatures.length === 1 ? p.temperatures[0] : null,
    );
    for (const temperature of ["hot", "ice"] as const) {
      assert.equal(
        validateOptions(p, { ...initial, temperature }) === null,
        p.temperatures.includes(temperature),
        p.name + temperature,
      );
      if (p.temperatures.includes(temperature))
        assert.ok(productImage(p, temperature).startsWith("/assets/drinks/"));
    }
  }
});
test("bottled drinks cannot acquire preparation options through a restored draft", () => {
  for (const p of products.filter((p) => p.packaged)) {
    assert.ok(validateOptions(p, { ...defaults(p), size: "large" }));
    assert.ok(validateOptions(p, { ...defaults(p), syrup: 1 }));
    assert.ok(validateOptions(p, { ...defaults(p), ice: "less" }));
  }
});
