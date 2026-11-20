import { test, expect } from "@playwright/test";

import { mockBackend } from "./backend-fixture";
test.beforeEach(async ({ page }) => {
  await mockBackend(page);
});

test("receipt design switches between 80mm receipt and pickup slip without creating an order", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "영수증 시안", exact: true }).click();
  const paper = page.locator(".thermal-receipt");
  await expect(paper).toContainText("024");
  await expect(paper).toContainText("17,200원");
  await expect(paper).toContainText("오트밀크");
  const pdf = await page.request.get(
    (await page
      .getByRole("link", { name: "시안 PDF 다운로드" })
      .getAttribute("href"))!,
  );
  expect(pdf.headers()["content-type"]).toContain("application/pdf");
  expect((await pdf.body()).subarray(0, 4).toString()).toBe("%PDF");
  const geometry = await paper.evaluate((el) => ({
    width: (el as HTMLElement).offsetWidth,
    content: getComputedStyle(el).width,
    padding: getComputedStyle(el).paddingLeft,
    overflow: el.scrollWidth > el.clientWidth,
  }));
  expect(geometry.width).toBeCloseTo(302, 0);
  expect(geometry.overflow).toBe(false);
  await page.getByRole("button", { name: /픽업 주문서/ }).click();
  await expect(paper).toHaveClass(/thermal-pickup/);
  await expect(paper).toContainText("4개");
  await expect(paper).not.toContainText("17,200원");
  await page.getByRole("button", { name: "출력 안내", exact: true }).click();
  await expect(page.locator(".receipt-print-guide")).toContainText(
    "로컬 백엔드",
  );
  expect(
    await page.evaluate(() => localStorage.getItem("switch.kiosk.orders.v1")),
  ).toBe(null);
});

test("receipt goes to the backend and does not open browser printing", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.print = () => {
      throw Error("Unexpected browser printing");
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "영수증 시안", exact: true }).click();
  await page.getByRole("button", { name: "영수증 출력", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Windows 인쇄 대기열");
  await expect(page.locator("iframe[data-receipt-print]")).toHaveCount(0);
});

test("long menu names and many lines wrap inside the paper width", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(() => {
    const lines = Array.from({ length: 15 }, (_, i) => ({
      id: "long-" + i,
      productId: "americano",
      quantity: 1,
      options: {
        temperature: "ice",
        size: "large",
        shots: 3,
        syrup: 3,
        milk: "regular",
        ice: "less",
        sweetness: "less",
        decaf: true,
      },
      snapshot: {
        name: "아주 긴 메뉴 이름과 추가 옵션이 있는 시니어 친화형 테스트 음료",
        unitPrice: 6600,
        optionsLabel:
          "ICE · 라지 · 디카페인 · 샷 3 추가 · 시럽 3 추가 · 얼음 적게 · 덜 달게",
      },
    }));
    localStorage.setItem(
      "switch.kiosk.orders.v1",
      JSON.stringify([
        {
          id: "long-receipt",
          number: "099",
          createdAt: new Date().toISOString(),
          place: "takeout",
          lines,
          total: 99000,
          method: "card",
        },
      ]),
    );
  });
  await page.getByRole("button", { name: "주문 이력", exact: true }).click();
  await page.getByRole("button", { name: /주문 099/ }).click();
  await expect(page.locator(".thermal-item")).toHaveCount(15);
  const widths = await page
    .locator(".thermal-receipt,.thermal-item,.thermal-item-name")
    .evaluateAll((els) =>
      els.map((el) => ({ scroll: el.scrollWidth, width: el.clientWidth })),
    );
  expect(widths.every((w) => w.scroll <= w.width + 1)).toBe(true);
  await expect(page.locator(".thermal-grand-total")).toContainText("99,000원");
});
