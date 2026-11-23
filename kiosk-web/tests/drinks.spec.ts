import { test, expect } from "@playwright/test";
import { mockBackend } from "./backend-fixture";

test.beforeEach(async ({ page }) => {
  await mockBackend(page);
  await page.goto("/?kiosk=1");
  await page.getByRole("button", { name: /포장할게요/ }).click();
});
test("every primary category uses supplied photos and exposes all 113 distinct products", async ({
  page,
}) => {
  const names = new Set<string>();
  for (const name of [
    "커피",
    "디카페인",
    "논커피",
    "티",
    "에이드",
    "블렌디드",
    "과일 주스",
    "병음료",
  ]) {
    await page.getByRole("button", { name, exact: true }).click();
    await expect
      .poll(() =>
        page
          .locator(".product-card img")
          .evaluateAll(
            (imgs) =>
              imgs.length > 0 &&
              imgs.every(
                (i) =>
                  (i as HTMLImageElement).complete &&
                  (i as HTMLImageElement).naturalWidth === 328,
              ),
          ),
      )
      .toBe(true);
    for (const value of await page
      .locator(".product-card img")
      .evaluateAll((imgs) => imgs.map((i) => i.getAttribute("alt")!)))
      names.add(value);
    expect(
      await page
        .locator(".product-card img")
        .evaluateAll((imgs) =>
          imgs.every(
            (i) =>
              i.getAttribute("src")!.startsWith("/assets/drinks/") &&
              getComputedStyle(i).objectFit === "contain",
          ),
        ),
    ).toBe(true);
  }
  expect(names.size).toBe(113);
});
test("one menu switches HOT/ICE photographs and keeps the chosen photo through review and editing", async ({
  page,
}) => {
  const button = page.getByRole("button", {
    name: "바닐라라떼 4,500원",
    exact: true,
  });
  await expect(button).toHaveCount(1);
  await button.click();
  const modal = page.getByRole("dialog", { name: "메뉴 선택" }),
    image = modal.locator(".option-photo img");
  await modal.getByRole("button", { name: /차갑게/ }).click();
  const ice = await image.getAttribute("src");
  await modal.getByRole("button", { name: /따뜻하게/ }).click();
  const hot = await image.getAttribute("src");
  expect(hot).not.toBe(ice);
  await modal
    .getByRole("button", { name: "4,500원 담기", exact: true })
    .click();
  await page.getByRole("button", { name: "결제하기", exact: true }).click();
  await expect(page.locator(".cart-photo img")).toHaveAttribute("src", hot!);
  await page.getByRole("button", { name: "바닐라라떼 옵션 변경" }).click();
  await expect(page.locator(".option-photo img")).toHaveAttribute("src", hot!);
  await page.getByRole("button", { name: /차갑게/ }).click();
  await page
    .getByRole("button", { name: "4,500원 수정하기", exact: true })
    .click();
  await expect(page.locator(".cart-photo img")).toHaveAttribute("src", ice!);
  await page.reload();
  await page.getByRole("button", { name: "결제하기", exact: true }).click();
  await expect(page.locator(".cart-photo img")).toHaveAttribute("src", ice!);
});
test("HOT-only, ICE-only and packaged products do not offer unsupported options", async ({
  page,
}) => {
  await page.getByRole("button", { name: "커피", exact: true }).click();
  await page
    .getByRole("button", { name: "아메리카노 3,200원", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: /따뜻하게.*HOT ONLY/ }),
  ).toHaveClass(/selected/);
  await expect(page.getByRole("button", { name: /차갑게/ })).toHaveCount(0);

  await page.getByRole("button", { name: "닫기", exact: true }).click();
  await page
    .getByRole("button", { name: "콜드브루 3,200원", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: /차갑게.*ICE ONLY/ }),
  ).toHaveClass(/selected/);
  await expect(page.getByRole("button", { name: /따뜻하게/ })).toHaveCount(0);
  await page.getByRole("button", { name: "닫기", exact: true }).click();
  await page.getByRole("button", { name: "병음료", exact: true }).click();
  await page
    .getByRole("button", { name: "이디야 워터 1,500원", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: /라지|시럽 없이|추가 시럽 늘리기/ }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "메뉴 수량 늘리기" }).click();
  await page.getByRole("button", { name: "3,000원 담기", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "현재 주문 내역" }),
  ).toContainText("이디야 워터");
});
