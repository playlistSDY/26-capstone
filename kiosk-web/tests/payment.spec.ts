import { test, expect } from "@playwright/test";
import { mockBackend } from "./backend-fixture";

for (const [name, method, instruction, reading] of [
  [
    "신용·체크카드",
    "card",
    "카드를 리더기에 넣어 주세요",
    "카드를 읽고 있어요",
  ],
  [
    "삼성페이",
    "samsung",
    "휴대폰을 리더기에 대 주세요",
    "휴대폰을 인식하고 있어요",
  ],
  [
    "애플페이",
    "apple",
    "휴대폰을 리더기에 대 주세요",
    "휴대폰을 인식하고 있어요",
  ],
  ["카카오페이", "kakao", "결제코드를 보여 주세요", "결제코드를 읽고 있어요"],
  ["네이버페이", "naver", "결제코드를 보여 주세요", "결제코드를 읽고 있어요"],
]) {
  test(`${name}: automatic reader stages preserve method and send one receipt`, async ({
    page,
  }) => {
    const backend = await mockBackend(page, { autoPrint: true });
    await page.clock.install();
    await page.goto("/?kiosk=1");
    await page.getByRole("button", { name: /포장할게요/ }).click();
    await page
      .getByRole("button", { name: "바닐라라떼 4,500원", exact: true })
      .click();
    await page.getByRole("button", { name: /차갑게/ }).click();
    await page
      .getByRole("button", { name: "4,500원 담기", exact: true })
      .click();
    await page.getByRole("button", { name: "결제하기", exact: true }).click();
    await page
      .getByRole("button", { name: "확인하고 결제하기", exact: true })
      .click();
    await expect(page.locator(".payment-method")).toHaveCount(5);
    await page.getByRole("button", { name, exact: true }).click();
    const modal = page.getByRole("dialog", { name, exact: true });
    await expect(modal.getByRole("heading")).toHaveText(instruction);
    await expect(modal).not.toContainText("체험");
    await expect(
      modal.getByRole("button", { name: "결제 리더기" }),
    ).toBeEnabled();
    // A mock reader signals detection without asking the customer to approve it.
    await page.clock.runFor(3100);
    await expect(modal.getByRole("heading")).toHaveText(reading);
    await expect(
      modal.getByRole("button", { name: "결제 리더기" }),
    ).toBeDisabled();
    await page.clock.runFor(1700);
    await expect(modal.getByRole("heading")).toHaveText(
      "결제를 승인하고 있어요",
    );
    await page.clock.runFor(1800);
    await expect(modal.getByRole("heading")).toHaveText("결제가 완료됐어요");
    await expect(modal.getByRole("button", { name: "닫기" })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(modal).toBeVisible();
    await page.clock.runFor(1100);
    await expect.poll(() => backend.jobs.length).toBe(1);
    await expect(
      page.getByRole("heading", { name: "주문이 완료됐어요" }),
    ).toBeVisible();
    await expect(
      page.getByText("001번으로 알려드릴게요.", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("맛있게 드세요!", { exact: true }),
    ).toBeVisible();
    await expect.poll(() => backend.jobs.length).toBe(1);
    expect((backend.jobs[0].document as { method: string }).method).toBe(name);
    const orders = await page.evaluate(() =>
      JSON.parse(localStorage.getItem("switch.kiosk.orders.v1") || "[]"),
    );
    expect(orders).toHaveLength(1);
    expect(orders[0].method).toBe(method);
    const rect = await page
      .locator(".completed-screen")
      .evaluate((el) => ({ width: el.clientWidth, scroll: el.scrollWidth }));
    expect(rect.scroll).toBeLessThanOrEqual(rect.width);
  });
}
