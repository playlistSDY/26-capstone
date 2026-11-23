import { test, expect, type Page } from "@playwright/test";

import { mockBackend } from "./backend-fixture";
test.beforeEach(async ({ page }) => {
  await mockBackend(page);
});

async function addCoffee(page: Page) {
  await page.getByRole("button", { name: /포장할게요/ }).click();
  await page
    .getByRole("button", { name: "바닐라라떼 4,500원", exact: true })
    .click();
  await page.getByRole("button", { name: /차갑게/ }).click();
  await page.getByRole("button", { name: /4,500원 담기/ }).click();
}
async function checkout(page: Page) {
  await page.getByRole("button", { name: "결제하기", exact: true }).click();
  await page
    .getByRole("button", { name: "확인하고 결제하기", exact: true })
    .click();
}

test("complete takeaway order with required options, editing, surcharges and receipt", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.getByRole("button", { name: /포장할게요/ }).click();
  await page
    .getByRole("button", { name: "바닐라라떼 4,500원", exact: true })
    .click();
  await page.getByRole("button", { name: /4,500원 담기/ }).click();
  await expect(page.getByRole("alert")).toContainText("차갑게");
  await page.getByRole("button", { name: /차갑게/ }).click();
  await page.getByRole("button", { name: /라지/ }).click();
  await page
    .getByRole("button", { name: "추가 샷 늘리기", exact: true })
    .click();
  await page
    .getByRole("button", { name: "추가 시럽 늘리기", exact: true })
    .click();
  await page
    .getByRole("button", { name: "메뉴 수량 늘리기", exact: true })
    .click();
  await page.getByRole("button", { name: /11,600원 담기/ }).click();
  await page.getByRole("button", { name: "결제하기", exact: true }).click();
  await expect(
    page.getByText("ICE · 라지 · 샷 1 추가 · 시럽 1 추가"),
  ).toBeVisible();
  await page.getByRole("button", { name: "바닐라라떼 옵션 변경" }).click();
  await page.getByRole("button", { name: /따뜻하게/ }).click();
  await page.getByRole("button", { name: /11,600원 수정하기/ }).click();
  await expect(
    page.getByText("HOT · 라지 · 샷 1 추가 · 시럽 1 추가"),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "확인하고 결제하기", exact: true })
    .click();
  await page.getByRole("button", { name: "신용·체크카드" }).click();
  await page.getByRole("button", { name: "결제 리더기", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "주문이 완료됐어요" }),
  ).toBeVisible();
  await expect(page.locator(".order-number>strong")).toHaveText("001");
  await page.keyboard.press("Control+Alt+h");
  await page.getByRole("button", { name: /주문 001/ }).click();
  await expect(page.getByRole("dialog")).toContainText("11,600원");
  await page.getByRole("button", { name: "확인", exact: true }).click();
  await page
    .getByRole("button", { name: "처음으로 돌아가기", exact: true })
    .click();
  await expect(page.getByRole("button", { name: /먹고 갈게요/ })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("switch.kiosk.orders.v1") || "[]")
            .length,
      ),
    )
    .toBe(1);
  expect(errors).toEqual([]);
});

test("failure, retry with another method, and double click do not duplicate an order", async ({
  page,
}) => {
  await page.goto("/");
  await addCoffee(page);
  await checkout(page);
  await page.getByLabel("결제 테스트 결과").selectOption("failure");
  await page.getByRole("button", { name: "신용·체크카드" }).click();
  await page.getByRole("button", { name: "결제 리더기", exact: true }).click();
  await expect(page.getByText("결제가 승인되지 않았어요")).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => localStorage.getItem("switch.kiosk.orders.v1")),
    )
    .toBe(null);
  await page
    .getByRole("button", { name: "다른 결제수단 선택", exact: true })
    .click();
  await page.getByLabel("결제 테스트 결과").selectOption("success");
  await page.getByRole("button", { name: "네이버페이" }).click();
  await page
    .getByRole("button", { name: "결제 리더기", exact: true })
    .dblclick();
  await expect(
    page.getByRole("heading", { name: "주문이 완료됐어요" }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("switch.kiosk.orders.v1") || "[]")
            .length,
      ),
    )
    .toBe(1);
});

test("canceling an in-flight payment never completes it", async ({ page }) => {
  await page.goto("/");
  await addCoffee(page);
  await checkout(page);
  await page.getByRole("button", { name: "신용·체크카드" }).click();
  await page.getByRole("button", { name: "결제 리더기", exact: true }).click();
  await page.getByRole("button", { name: "결제 취소", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.waitForTimeout(1700);
  expect(
    await page.evaluate(() => localStorage.getItem("switch.kiosk.orders.v1")),
  ).toBe(null);
  await expect(page.getByRole("heading", { name: /결제수단을/ })).toBeVisible();
});

test("refresh restores cart, removing last item blocks payment", async ({
  page,
}) => {
  await page.goto("/");
  await addCoffee(page);
  await page.reload();
  await page.getByRole("button", { name: "결제하기", exact: true }).click();
  await expect(page.getByText("ICE · 레귤러", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "바닐라라떼 삭제" }).click();
  await expect(
    page.getByRole("button", { name: "확인하고 결제하기", exact: true }),
  ).toBeDisabled();
  await expect(page.getByText("아직 담은 메뉴가 없어요")).toBeVisible();
});

test("every category works, sold-out items are disabled, cancellation is confirmed", async ({
  page,
}) => {
  await page.goto("/");
  await addCoffee(page);
  for (const name of [
    "커피",
    "디카페인",
    "논커피",
    "에이드",
    "블렌디드",
    "과일 주스",
    "티",
  ]) {
    await page.getByRole("button", { name, exact: true }).click();
    await expect(page.locator(".product-card").first()).toBeVisible();
  }
  await expect(
    page.getByRole("button", { name: /얼그레이 티.*품절/ }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "처음으로", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "담아 둔 메뉴가 모두 지워져요",
  );
  await page
    .getByRole("button", { name: "계속 주문하기", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "결제하기", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "처음으로", exact: true }).click();
  await page
    .getByRole("button", { name: "주문 취소하기", exact: true })
    .click();
  expect(
    await page.evaluate(() => localStorage.getItem("switch.kiosk.draft.v1")),
  ).toBe(null);
});

test("portrait target and Mac preview stay inside the viewport", async ({
  page,
}) => {
  for (const [width, height] of [
    [1600, 2560],
    [1280, 800],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    await page.goto("/?kiosk=1");
    await page.getByRole("button", { name: /먹고 갈게요/ }).click();
    const rect = await page.locator(".kiosk").boundingBox();
    expect(rect!.x).toBeGreaterThanOrEqual(-1);
    expect(rect!.y).toBeGreaterThanOrEqual(-1);
    expect(rect!.x + rect!.width).toBeLessThanOrEqual(width + 1);
    expect(rect!.y + rect!.height).toBeLessThanOrEqual(height + 1);
    await expect
      .poll(() =>
        page
          .locator(".product-card img")
          .evaluateAll((imgs) =>
            imgs.every(
              (img) =>
                (img as HTMLImageElement).complete &&
                (img as HTMLImageElement).naturalWidth > 0,
            ),
          ),
      )
      .toBe(true);
  }
});

test("order dock supports editing, review before payment, and clearing", async ({
  page,
}) => {
  await page.goto("/");
  await addCoffee(page);
  const dock = page.getByRole("region", { name: "현재 주문 내역" });
  await expect(dock).toContainText("바닐라라떼");
  await expect(
    dock.getByRole("button", { name: "주문 취소", exact: true }),
  ).toHaveCount(0);
  await expect(dock.locator(".dock-scroll-buttons")).toBeHidden();
  await dock
    .getByRole("button", { name: "바닐라라떼 주문 수량 늘리기" })
    .click();
  await expect(dock.locator(".cart-tally strong")).toHaveText("9,000원");
  const gapDifference = await dock.locator(".counter").evaluate((counter) => {
    const [minus, number, plus] = [...counter.children].map((child) =>
      child.getBoundingClientRect(),
    );
    return Math.abs(number.left - minus.right - (plus.left - number.right));
  });
  expect(gapDifference).toBeLessThan(1);
  await dock.getByRole("button", { name: "바닐라라떼 옵션 변경" }).click();
  await page.getByRole("button", { name: /따뜻하게/ }).click();
  await page.getByRole("button", { name: "9,000원 수정하기" }).click();
  await expect(dock).toContainText("HOT · 레귤러");
  await dock.getByRole("button", { name: "결제하기", exact: true }).click();
  await expect(page.getByRole("heading", { name: /주문 내역/ })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "이전으로", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "확인하고 결제하기", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: /결제수단을/ })).toBeVisible();
  await page.getByRole("button", { name: "이전 화면", exact: true }).click();
  await page.getByRole("button", { name: "이전으로", exact: true }).click();
  await dock.getByRole("button", { name: "전체 삭제", exact: true }).click();
  await page
    .getByRole("button", { name: "전체 삭제하기", exact: true })
    .click();
  await expect(
    page
      .locator(".order-dock")
      .getByRole("button", {
        name: "결제하기",
        exact: true,
        includeHidden: true,
      }),
  ).toBeDisabled();
  await expect(page.locator(".order-dock")).toBeHidden();
  await expect(
    page.getByRole("button", { name: "포장", exact: true }),
  ).toBeVisible();
});

test("payment timeout retains the cart and can be retried", async ({
  page,
}) => {
  await page.goto("/");
  await addCoffee(page);
  await checkout(page);
  await page.getByLabel("결제 테스트 결과").selectOption("timeout");
  await page.clock.install();
  await page.getByRole("button", { name: "신용·체크카드" }).click();
  await page.getByRole("button", { name: "결제 리더기", exact: true }).click();
  await page.clock.runFor(45200);
  await expect(page.getByText("결제 시간이 초과됐어요")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "다시 시도하기" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("switch.kiosk.draft.v1")!).lines.length,
    ),
  ).toBe(1);
  expect(
    await page.evaluate(() => localStorage.getItem("switch.kiosk.orders.v1")),
  ).toBe(null);
});

test("inactivity warning preserves the cart until its countdown expires", async ({
  page,
}) => {
  await page.clock.install();
  await page.goto("/");
  await addCoffee(page);
  await page.clock.runFor(121000);
  await expect(
    page.getByRole("dialog", { name: "주문을 계속할까요?" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "계속 주문할게요" }).click();
  await expect(
    page.getByRole("region", { name: "현재 주문 내역" }),
  ).toContainText("바닐라라떼");
  await page.clock.runFor(121000);
  await expect(
    page.getByRole("dialog", { name: "주문을 계속할까요?" }),
  ).toBeVisible();
  await page.clock.runFor(21000);
  await expect(page.getByRole("button", { name: /먹고 갈게요/ })).toBeVisible();
  expect(
    await page.evaluate(() => localStorage.getItem("switch.kiosk.draft.v1")),
  ).toBe(null);
});

test("order list scrolls independently with both wheel and up/down buttons", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: /포장할게요/ }).click();
  for (const [name, price] of [
    ["바닐라라떼", "4,500"],
    ["연유라떼", "4,500"],
    ["복숭아 아이스티", "3,500"],
    ["감귤 레몬 에이드", "4,500"],
  ]) {
    await page
      .getByRole("button", { name: `${name} ${price}원`, exact: true })
      .click();
    await page.getByRole("button", { name: /차갑게/ }).click();
    await page
      .getByRole("button", { name: `${price}원 담기`, exact: true })
      .click();
  }
  const list = page.locator(".dock-lines"),
    up = page.getByRole("button", { name: "주문 내역 위로" }),
    down = page.getByRole("button", { name: "주문 내역 아래로" });
  await expect(up).toBeEnabled();
  const listBounds = await list.boundingBox();
  const rail = await page
    .locator(".dock-body .dock-scroll-buttons")
    .boundingBox();
  const upButton = await up.boundingBox();
  expect(rail!.height).toBeCloseTo(listBounds!.height, 0);
  expect(upButton!.height / rail!.height).toBeGreaterThan(0.45);
  await up.click();
  await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBe(0);
  await expect(down).toBeEnabled();
  await down.click();
  await expect
    .poll(() => list.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(0);
  await expect(down).toBeDisabled();
  await up.click();
  await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBe(0);
  await list.hover();
  await page.mouse.wheel(0, 250);
  await expect
    .poll(() => list.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(0);
  await expect(
    page.getByRole("button", { name: "전체보기", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "결제하기", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "주문 확인 목록 아래로" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "주문 확인 목록 아래로" }).click();
  await expect
    .poll(() => page.locator(".cart-lines").evaluate((el) => el.scrollTop))
    .toBeGreaterThan(0);
  await page.getByRole("button", { name: "주문 확인 목록 위로" }).click();
  await expect
    .poll(() => page.locator(".cart-lines").evaluate((el) => el.scrollTop))
    .toBe(0);
});
