import test from "node:test";
import assert from "node:assert/strict";
import { translateText, isLocale } from "./i18n";
import catalog from "./drink-catalog.json";
test("All menu names, descriptions and core order controls have four-language support", () => {
  for (const language of ["en", "zh", "ja"] as const) {
    for (const p of catalog)
      for (const value of [p.name, p.description])
        assert.notEqual(
          translateText(value, language),
          value,
          `${language}: ${value}`,
        );
    for (const text of [
      "커피",
      "티",
      "포장할게요",
      "결제하기",
      "신용·체크카드",
    ])
      assert.notEqual(translateText(text, language), text);
  }
});
test("Language changes preserve KRW prices and Korean mode is unchanged", () => {
  assert.equal(translateText("4,700원", "en"), "₩4,700");
  assert.equal(translateText("결제하기", "ko"), "결제하기");
  assert.equal(isLocale("en"), true);
  assert.equal(isLocale("__proto__"), false);
});
