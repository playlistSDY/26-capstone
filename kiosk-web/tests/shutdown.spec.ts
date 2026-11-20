import { test, expect, type Page } from "@playwright/test";
import { mockBackend } from "./backend-fixture";

async function tap(page: Page, count = 5) {
  const corner = page.getByRole("button", {
    name: "키오스크 종료 메뉴",
    exact: true,
  });
  for (let i = 0; i < count; i++) await corner.click();
}
test("five consecutive home-corner taps open confirmation, cancel keeps the kiosk running", async ({
  page,
}) => {
  const backend = await mockBackend(page);
  await page.clock.install();
  await page.goto("/?kiosk=1");
  await tap(page, 4);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.clock.runFor(5100);
  await tap(page, 1);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("heading").click(); // Another touch breaks the sequence.
  await tap(page, 4);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await tap(page, 1);
  const modal = page.getByRole("dialog", { name: "키오스크 종료" });
  await expect(modal.getByRole("heading")).toHaveText("종료하시겠습니까?");
  expect(backend.shutdownRequests).toBe(0);
  await modal.getByRole("button", { name: "아니요", exact: true }).click();
  await expect(modal).toHaveCount(0);
  expect(backend.shutdownRequests).toBe(0);
  await page.getByRole("button", { name: /포장할게요/ }).click();
  await expect(
    page.getByRole("button", { name: "키오스크 종료 메뉴" }),
  ).toHaveCount(0);
});
test("confirmation sends one authenticated shutdown and locks the dialog during cleanup", async ({
  page,
}) => {
  await mockBackend(page);
  let count = 0,
    release!: () => void;
  const pending = new Promise<void>((r) => (release = r));
  await page.route("**/api/shutdown", async (route) => {
    count++;
    expect(route.request().headers()["x-switch-token"]).toBe("test-token");
    await pending;
    await route.fulfill({
      contentType: "application/json",
      body: '{"stopping":true}',
    });
  });
  await page.goto("/?kiosk=1");
  await tap(page);
  const modal = page.getByRole("dialog", { name: "키오스크 종료" });
  await modal.getByRole("button", { name: "예", exact: true }).click();
  await expect(modal.getByRole("heading")).toHaveText(
    "키오스크를 종료하고 있어요",
  );
  await expect(modal.getByRole("button", { name: "종료 중" })).toBeDisabled();
  await expect(modal.getByRole("button", { name: "아니요" })).toBeDisabled();
  await expect(modal.getByRole("button", { name: "닫기" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+Alt+s");
  await expect(modal).toBeVisible();
  await expect.poll(() => count).toBe(1);
  release();
  await expect(modal).toBeVisible();
  expect(count).toBe(1);
});
test("failed shutdown displays an error and allows retry", async ({ page }) => {
  await mockBackend(page);
  let tries = 0;
  await page.route("**/api/shutdown", async (route) => {
    tries++;
    await route.fulfill({
      status: tries === 1 ? 503 : 200,
      contentType: "application/json",
      body:
        tries === 1
          ? '{"error":"종료 요청을 다시 시도해 주세요."}'
          : '{"stopping":true}',
    });
  });
  await page.goto("/?kiosk=1");
  await tap(page);
  const modal = page.getByRole("dialog", { name: "키오스크 종료" });
  await modal.getByRole("button", { name: "예", exact: true }).click();
  await expect(modal.getByRole("alert")).toContainText("다시 시도");
  await expect(modal.getByRole("button", { name: "아니요" })).toBeEnabled();
  await modal.getByRole("button", { name: "예", exact: true }).click();
  await expect(modal.getByRole("button", { name: "종료 중" })).toBeDisabled();
  await expect.poll(() => tries).toBe(2);
});
