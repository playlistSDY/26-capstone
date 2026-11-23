import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { categories, products, productImage } from "./catalog";
import { defaults, validateOptions } from "./domain";

test("all supplied photos are preserved and grouped into distinct menu items", () => {
  assert.equal(products.length, 113);
  assert.equal(new Set(products.map((p) => p.sourceName)).size, 112);
  assert.equal(
    products.reduce((n, p) => n + p.sourcePhotos.length, 0),
    151,
  );
  assert.equal(products.filter((p) => p.temperatures.length === 2).length, 38);
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

test("reviewed decaf photos stay exclusive to decaf products without a second surcharge", async () => {
  const policy = JSON.parse(
    readFileSync(
      new URL("../scripts/drink-photo-policy.json", import.meta.url),
      "utf8",
    ),
  );
  const decafPhotos = new Set<string>(policy.decafPhotos);
  const found = new Set<string>();
  for (const p of products) {
    for (const photo of p.sourcePhotos) {
      assert.equal(!!p.decafOnly, decafPhotos.has(photo.source), photo.source);
      if (p.decafOnly) found.add(photo.source);
    }
    if (p.decafOnly) {
      assert.deepEqual(p.categories, ["디카페인"]);
      const options = { ...defaults(p), temperature: p.temperatures[0] };
      const { unitPrice } = await import("./domain");
      assert.equal(unitPrice(p, options), p.price);
      assert.equal(options.decaf, true);
      assert.ok(validateOptions(p, { ...options, decaf: false }));
    }
  }
  assert.deepEqual(found, decafPhotos);
  assert.deepEqual(products.find((p) => p.id === "americano")?.temperatures, [
    "hot",
  ]);
  assert.deepEqual(
    products.find((p) => p.id === "americano-decaf")?.temperatures,
    ["ice"],
  );
});

test("recommended menu mixes coffee, iced tea, ade, blended drinks and tea", () => {
  const recommended = products.filter((p) =>
    p.categories.includes("추천 메뉴"),
  );
  assert.equal(recommended.length, 12);
  assert.ok(recommended.filter((p) => p.coffee).length >= 2);
  assert.ok(
    recommended.filter((p) => !p.coffee).length > recommended.length / 2,
  );
  for (const category of ["커피", "에이드", "블렌디드", "티"] as const)
    assert.ok(
      recommended.some((p) => p.categories.includes(category)),
      category,
    );
  assert.ok(recommended.some((p) => p.name.includes("아이스티")));
  assert.ok(recommended.every((p) => !p.soldOut));
});


test("blended drinks reject ice changes while ordinary iced drinks retain them", () => {
  const blended=products.filter(p=>p.categories.includes("블렌디드"));
  assert.equal(blended.length,14);
  for(const p of blended){
    assert.equal(p.iceAdjustable,false,p.name);
    assert.equal(validateOptions(p,defaults(p)),null,p.name);
    for(const ice of ["more","less","none"] as const)
      assert.match(validateOptions(p,{...defaults(p),ice})!,/얼음 양/,p.name);
  }
  const ade=products.find(p=>p.id==="lemon")!;
  assert.equal(validateOptions(ade,{...defaults(ade),ice:"more"}),null);
});
