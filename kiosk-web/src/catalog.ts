import suppliedDrinks from "./drink-catalog.json";

export const categories = [
  "추천 메뉴",
  "커피",
  "디카페인",
  "논커피",
  "에이드",
  "블렌디드",
  "과일 주스",
  "티",
  "병음료",
] as const;
export type Category = (typeof categories)[number];
export type Temperature = "ice" | "hot";
export type Product = {
  id: string;
  name: string;
  sourceName: string;
  price: number;
  priceSource: "prototype";
  image: string;
  temperatures: Temperature[];
  temperatureImages: Partial<Record<Temperature, string>>;
  sourcePhotos: { path: string; source: string; sha256: string }[];
  description: string;
  categories: Category[];
  coffee: boolean;
  milk: boolean;
  decaf: boolean;
  decafOnly?: boolean;
  whippedCream?: boolean;
  packaged: boolean;
  fixedOptions: boolean;
  fixedSize: boolean;
  iceAdjustable: boolean;
  soldOut?: boolean;
};
export const assetBase = import.meta.env?.BASE_URL ?? "/";
export const assetUrl = (path: string) =>
  `${assetBase}${path.replace(/^\//, "")}`;
export const products: Product[] = suppliedDrinks.map((data) => {
  const temperatureImages = Object.fromEntries(
    Object.entries(data.temperatureImages).map(([t, path]) => [
      t,
      assetUrl(path!),
    ]),
  ) as Partial<Record<Temperature, string>>;
  return {
    ...data,
    priceSource: "prototype",
    categories: data.categories as Category[],
    temperatures: data.temperatures as Temperature[],
    temperatureImages,
    image: (temperatureImages.ice ?? temperatureImages.hot)!,
  };
});
export function productImage(
  product: Product,
  temperature?: Temperature | null,
) {
  return (
    (temperature && product.temperatureImages[temperature]) || product.image
  );
}
export function temperatureBadge(product: Product) {
  return product.temperatures.length === 2
    ? "ICE / HOT"
    : product.temperatures[0] === "hot"
      ? "HOT ONLY"
      : "ICE ONLY";
}
export const findProduct = (id: string) => products.find((p) => p.id === id);
export const money = (value: number) => `${value.toLocaleString("ko-KR")}원`;
