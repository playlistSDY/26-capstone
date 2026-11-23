import { test, expect } from "@playwright/test";
import { mockBackend } from "./backend-fixture";

test("decaf, whipping and more ice persist through edit, reload, checkout and receipt", async ({
  page,
}) => {
  const backend = await mockBackend(page, { autoPrint: true });
  await page.clock.install();
  await page.goto("/?kiosk=1");
  await page.getByRole("button", { name: /포장할게요/ }).click();
  await page.getByRole("button", { name: "디카페인", exact: true }).click();
  await expect(page.locator(".product-card")).toHaveCount(9);
  await expect(page.locator(".product-card")).not.toContainText(["바닐라라떼"]);
  await page
    .getByRole("button", { name: "디카페인 카페모카 4,700원", exact: true })
    .click();
  let modal = page.getByRole("dialog", { name: "메뉴 선택" });
  await expect(
    modal.getByRole("heading", { name: "원두", exact: true }),
  ).toHaveCount(0);
  await modal.getByRole("button", { name: /차갑게/ }).click();
  await modal.getByRole("button", { name: "많이", exact: true }).click();
  await modal.getByRole("button", { name: "휘핑 제거", exact: true }).click();
  await expect(
    modal.getByRole("heading", { name: "시럽 추가", exact: true }),
  ).toBeVisible();
  await expect(
    modal.getByRole("heading", { name: "바닐라 시럽 추가", exact: true }),
  ).toHaveCount(0);
  await modal.getByRole("button", { name: "추가 시럽 늘리기" }).click();
  await modal
    .getByRole("button", { name: "5,000원 담기", exact: true })
    .click();
  await page.getByRole("button", { name: "결제하기", exact: true }).click();
  await page
    .getByRole("button", { name: "디카페인 카페모카 옵션 변경" })
    .click();
  modal = page.getByRole("dialog", { name: "메뉴 수정" });
  await expect(
    modal.getByRole("button", { name: "많이", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    modal.getByRole("button", { name: "휘핑 제거", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await modal.getByRole("button", { name: "휘핑 추가", exact: true }).click();
  await modal
    .getByRole("button", { name: "5,000원 수정하기", exact: true })
    .click();
  await page.reload();
  await page.getByRole("button", { name: "결제하기", exact: true }).click();
  await expect(page.locator(".cart-line")).toContainText("얼음 많이");
  await expect(page.locator(".cart-line")).toContainText("휘핑 추가");
  await page
    .getByRole("button", { name: "확인하고 결제하기", exact: true })
    .click();
  await page
    .getByRole("button", { name: "신용·체크카드", exact: true })
    .click();
  await page.getByRole("button", { name: "결제 리더기", exact: true }).click();
  await page.clock.runFor(5000);
  await expect.poll(() => backend.jobs.length).toBe(1);
  expect(JSON.stringify(backend.jobs[0])).toContain("휘핑 추가");
  expect(JSON.stringify(backend.jobs[0])).toContain("얼음 많이");
  expect(JSON.stringify(backend.jobs[0])).toContain("시럽 1 추가");
});

test("recommendations cover different drinks and ordinary coffee has no cream control", async ({
  page,
}) => {
  await mockBackend(page);
  await page.goto("/?kiosk=1");
  await page.getByRole("button", { name: /포장할게요/ }).click();
  await expect(page.locator(".product-card")).toHaveCount(12);
  for (const name of [
    "바닐라라떼",
    "복숭아 아이스티",
    "감귤 레몬 에이드",
    "망고 플랫치노",
    "캐모마일 티",
  ])
    await expect(
      page.locator(".product-card").filter({ hasText: name }),
    ).toHaveCount(1);
  await page
    .getByRole("button", { name: "바닐라라떼 4,500원", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "휘핑 추가", exact: true }),
  ).toHaveCount(0);
});
