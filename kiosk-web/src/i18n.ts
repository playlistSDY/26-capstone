import { useSyncExternalStore } from "react";
import translations from "./ui-translations.json";
export const languages = {
  ko: "한국어",
  en: "English",
  zh: "简体中文",
  ja: "日本語",
} as const;
export type Locale = keyof typeof languages;
const dictionary = translations as Record<
  string,
  Record<Exclude<Locale, "ko">, string>
>;
const listeners = new Set<() => void>();
export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && Object.hasOwn(languages, value);
}
let locale: Locale = "ko";
try {
  const saved = localStorage.getItem("switch.kiosk.language");
  if (isLocale(saved)) locale = saved;
} catch {
  /* Storage may be disabled. */
}
if (typeof document !== "undefined") document.documentElement.lang = locale;
export function getLocale() {
  return locale;
}
export function setLocale(next: Locale) {
  if (next === locale) return;
  locale = next;
  try {
    localStorage.setItem("switch.kiosk.language", next);
  } catch {
    /* Session-only choice still works. */
  }
  document.documentElement.lang = next;
  listeners.forEach((listener) => listener());
}
export function useLocale() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getLocale,
    () => "ko" as Locale,
  );
}
const keys = Object.keys(dictionary).sort((a, b) => b.length - a.length);
const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const pattern = keys.length
  ? new RegExp(keys.map(escaped).join("|"), "g")
  : null;
export function translateText(text: string, language: Locale = locale): string {
  if (language === "ko") return text;
  const trimmed = text.trim(),
    exact = dictionary[trimmed]?.[language];
  if (exact) return text.replace(trimmed, exact);
  let result = pattern
    ? text.replace(pattern, (matched) => dictionary[matched][language])
    : text;
  result = result
    .replace(/([\d,]+)원/g, (_, n) => `₩${n}`)
    .replace(/([\d,]+)개/g, (_, n) =>
      language === "en" ? `${n} ${n === "1" ? "item" : "items"}` : `${n}杯`,
    );
  return result;
}
export function uiText<T>(value: T): T {
  return (typeof value === "string" ? translateText(value) : value) as T;
}
