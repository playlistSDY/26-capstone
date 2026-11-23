import { findProduct, assetBase, type Product } from "./catalog";

export type Place = "store" | "takeout";
export type Options = {
  temperature: "ice" | "hot" | null;
  size: "regular" | "large";
  shots: number;
  syrup: number;
  milk: "regular" | "oat";
  ice: "normal" | "more" | "less" | "none";
  whippedCream?: "normal" | "extra" | "none";
  sweetness: "normal" | "less" | "none";
  decaf: boolean;
};
export type CartLine = {
  id: string;
  productId: string;
  quantity: number;
  options: Options;
  snapshot?: { name: string; unitPrice: number; optionsLabel: string };
};
export type PaymentMethod = "card" | "samsung" | "apple" | "kakao" | "naver";
export const paymentMethodName = (method: PaymentMethod) =>
  ({
    card: "신용·체크카드",
    samsung: "삼성페이",
    apple: "애플페이",
    kakao: "카카오페이",
    naver: "네이버페이",
  })[method];
export type Order = {
  id: string;
  number: string;
  createdAt: string;
  place: Place;
  lines: CartLine[];
  total: number;
  method: PaymentMethod;
};
export const defaults = (p: Product, decaf = false): Options => ({
  temperature: p.temperatures.length === 1 ? p.temperatures[0] : null,
  size: "regular",
  shots: 0,
  syrup: 0,
  milk: "regular",
  ice: "normal",
  sweetness: "normal",
  decaf: !!p.decafOnly || (!!p.decaf && decaf),
  whippedCream: "normal",
});
export function validateOptions(p: Product, o: Options): string | null {
  if (o.temperature !== "ice" && o.temperature !== "hot")
    return "차갑게 또는 따뜻하게를 선택해 주세요.";
  if (!p.temperatures.includes(o.temperature))
    return p.temperatures[0] === "ice"
      ? "이 메뉴는 차갑게만 주문할 수 있어요."
      : "이 메뉴는 따뜻하게만 주문할 수 있어요.";
  if (p.fixedSize && o.size !== "regular")
    return "이 메뉴는 기본 사이즈로만 주문할 수 있어요.";
  if (
    p.fixedOptions &&
    (o.size !== "regular" ||
      o.shots !== 0 ||
      o.syrup !== 0 ||
      o.milk !== "regular" ||
      o.ice !== "normal" ||
      o.sweetness !== "normal" ||
      o.decaf ||
      (o.whippedCream ?? "normal") !== "normal")
  )
    return "이 메뉴는 수량만 변경할 수 있어요.";
  if (!p.iceAdjustable && o.ice !== "normal")
    return "이 메뉴는 얼음 양을 변경할 수 없어요.";
  if (
    !["regular", "large"].includes(o.size) ||
    !["regular", "oat"].includes(o.milk) ||
    !["normal", "more", "less", "none"].includes(o.ice) ||
    !["normal", "less", "none"].includes(o.sweetness) ||
    !["normal", "extra", "none"].includes(o.whippedCream ?? "normal") ||
    typeof o.decaf !== "boolean"
  )
    return "옵션을 다시 선택해 주세요.";
  if (p.decafOnly && !o.decaf)
    return "이 메뉴는 디카페인 원두로만 주문할 수 있어요.";
  if (!p.whippedCream && (o.whippedCream ?? "normal") !== "normal")
    return "이 메뉴는 휘핑을 변경할 수 없어요.";
  if (![o.shots, o.syrup].every((n) => Number.isInteger(n) && n >= 0 && n <= 3))
    return "추가 옵션은 0~3개까지 선택할 수 있어요.";
  if (
    (!p.coffee && o.shots > 0) ||
    (!p.milk && o.milk !== "regular") ||
    (!p.decaf && o.decaf)
  )
    return "이 메뉴에서 선택할 수 없는 옵션이에요.";
  return null;
}
export const normalizeOptions = (o: Options): Options => ({
  temperature: o.temperature,
  size: o.size,
  shots: o.shots,
  syrup: o.syrup,
  milk: o.milk,
  ice: o.temperature === "hot" ? "normal" : o.ice,
  sweetness: o.sweetness,
  decaf: o.decaf,
  whippedCream: o.whippedCream ?? "normal",
});
export function unitPrice(p: Product, o: Options) {
  return (
    p.price +
    (o.size === "large" ? 500 : 0) +
    o.shots * 500 +
    o.syrup * 300 +
    (o.milk === "oat" ? 600 : 0) +
    (o.decaf && !p.decafOnly ? 500 : 0)
  );
}
export function totalPrice(lines: CartLine[]) {
  return lines.reduce(
    (sum, l) =>
      sum + unitPrice(findProduct(l.productId)!, l.options) * l.quantity,
    0,
  );
}
export function summary(o: Options) {
  return [
    o.temperature === "hot" ? "HOT" : "ICE",
    o.size === "large" ? "라지" : "레귤러",
    o.decaf ? "디카페인" : null,
    o.shots ? `샷 ${o.shots} 추가` : null,
    o.syrup ? `시럽 ${o.syrup} 추가` : null,
    o.milk === "oat" ? "오트밀크" : null,
    o.temperature === "ice" && o.ice !== "normal"
      ? o.ice === "more"
        ? "얼음 많이"
        : o.ice === "less"
          ? "얼음 적게"
          : "얼음 없이"
      : null,
    o.whippedCream === "extra"
      ? "휘핑 추가"
      : o.whippedCream === "none"
        ? "휘핑 제거"
        : null,
    o.sweetness !== "normal"
      ? o.sweetness === "less"
        ? "덜 달게"
        : "시럽 없이"
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
export function putLine(
  lines: CartLine[],
  next: CartLine,
  replaceId?: string,
): CartLine[] {
  if (!next || typeof next.id !== "string" || !next.id || !next.options)
    throw new Error("주문 내용을 다시 확인해 주세요.");
  if (lines.some((l) => l.id === next.id && l.id !== replaceId))
    throw new Error("중복된 주문 항목이에요.");
  const p = findProduct(next.productId);
  if (!p || p.soldOut) throw new Error("지금 주문할 수 없는 메뉴예요.");
  const error = validateOptions(p, next.options);
  if (error) throw new Error(error);
  if (
    !Number.isInteger(next.quantity) ||
    next.quantity < 1 ||
    next.quantity > 20
  )
    throw new Error("한 메뉴는 1~20개까지 담을 수 있어요.");
  const normalized = { ...next, options: normalizeOptions(next.options) };
  const base = lines.filter((l) => l.id !== replaceId);
  const same = base.find(
    (l) =>
      l.productId === normalized.productId &&
      JSON.stringify(l.options) === JSON.stringify(normalized.options),
  );
  if (same && same.quantity + next.quantity > 20)
    throw new Error("같은 옵션의 메뉴는 20개까지 담을 수 있어요.");
  const updated = same
    ? base.map((l) =>
        l.id === same.id ? { ...l, quantity: l.quantity + next.quantity } : l,
      )
    : [...base, normalized];
  if (updated.reduce((sum, l) => sum + l.quantity, 0) > 99)
    throw new Error("한 번에 총 99개까지 주문할 수 있어요.");
  return updated;
}

const storageNamespace =
  assetBase === "/"
    ? "switch.kiosk"
    : `switch.kiosk.${assetBase.replace(/[^a-zA-Z0-9-]/g, "")}`;
const DRAFT = `${storageNamespace}.draft.v1`,
  ORDERS = `${storageNamespace}.orders.v1`;
export function readDraft(
  storage: Storage,
): { place: Place; lines: CartLine[] } | null {
  try {
    const data = JSON.parse(storage.getItem(DRAFT) || "null");
    if (
      !data ||
      !["store", "takeout"].includes(data.place) ||
      !Array.isArray(data.lines) ||
      data.lines.length > 99
    )
      return null;
    let valid: CartLine[] = [];
    for (const line of data.lines) valid = putLine(valid, line);
    return valid.length ? { place: data.place, lines: valid } : null;
  } catch {
    return null;
  }
}
export function writeDraft(storage: Storage, place: Place, lines: CartLine[]) {
  try {
    if (lines.length) storage.setItem(DRAFT, JSON.stringify({ place, lines }));
    else storage.removeItem(DRAFT);
    return true;
  } catch {
    return false;
  }
}
export function readOrders(storage: Storage): Order[] {
  try {
    const list = JSON.parse(storage.getItem(ORDERS) || "[]");
    return Array.isArray(list)
      ? list
          .filter(
            (o) =>
              o &&
              typeof o.id === "string" &&
              typeof o.number === "string" &&
              Array.isArray(o.lines),
          )
          .slice(-200)
      : [];
  } catch {
    return [];
  }
}
export function completeOrder(
  storage: Storage,
  input: Omit<Order, "number" | "createdAt" | "total">,
  now = new Date(),
): Order {
  const existing = readOrders(storage);
  const previous = existing.find((o) => o.id === input.id);
  if (previous) return previous;
  if (
    !["store", "takeout"].includes(input.place) ||
    !["card", "samsung", "apple", "kakao", "naver"].includes(input.method) ||
    !input.lines.length
  )
    throw new Error("주문 내용을 확인해 주세요.");
  let valid: CartLine[] = [];
  for (const line of input.lines) valid = putLine(valid, line);
  const dateKey = now.toLocaleDateString("sv-SE");
  const today = existing.filter(
    (o) => new Date(o.createdAt).toLocaleDateString("sv-SE") === dateKey,
  );
  const sequence =
    today.reduce((n, o) => Math.max(n, Number(o.number) || 0), 0) + 1;
  const order: Order = {
    ...input,
    lines: valid.map((line) => {
      const product = findProduct(line.productId)!;
      return {
        ...line,
        snapshot: {
          name: product.name,
          unitPrice: unitPrice(product, line.options),
          optionsLabel: summary(line.options),
        },
      };
    }),
    number: String(sequence).padStart(3, "0"),
    createdAt: now.toISOString(),
    total: totalPrice(valid),
  };
  // If persistence fails, keep this attempt open instead of announcing success.
  storage.setItem(ORDERS, JSON.stringify([...existing, order].slice(-200)));
  storage.removeItem(DRAFT);
  return order;
}
