import { test, expect, type Page } from "@playwright/test";
import { mockBackend } from "./backend-fixture";
async function finish(page: Page) {
  await page.getByRole("button", { name: /포장할게요/ }).click();
  await page
    .getByRole("button", { name: "바닐라라떼 4,500원", exact: true })
    .click();
  await page.getByRole("button", { name: /차갑게/ }).click();
  await page.getByRole("button", { name: "4,500원 담기", exact: true }).click();
  await page.getByRole("button", { name: "결제하기", exact: true }).click();
  await expect(
    page
      .locator(".kiosk-header")
      .getByRole("button", { name: /돌아가기|이전/ }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "이전으로", exact: true }),
  ).toHaveCount(1);
  await page
    .getByRole("button", { name: "확인하고 결제하기", exact: true })
    .click();
  await page
    .getByRole("button", { name: "신용·체크카드", exact: true })
    .click();
  await page.getByRole("button", { name: "결제 리더기", exact: true }).click();
}
test("backend settings select a real printer and a completed order is sent once without window.print", async ({
  page,
}) => {
  const api = await mockBackend(page, { printerName: "" });
  await page.addInitScript(() => {
    window.print = () => {
      throw Error("Browser printing must not be used");
    };
  });
  await page.goto("/?printerSetup=1");
  const modal = page.getByRole("dialog", { name: "프린터 설정" });
  await modal
    .getByLabel("출력 대상", { exact: true })
    .selectOption("EPSON TM-m30");
  await modal
    .getByRole("checkbox", { name: /결제 완료 후 영수증 자동 출력/ })
    .check();
  await modal.getByLabel("볼륨 45%").fill("30");
  await modal.getByRole("button", { name: "설정 저장", exact: true }).click();
  await expect(modal).toHaveCount(0);
  expect(api.settings.soundVolume).toBe(30);
  await finish(page);
  await expect.poll(() => api.jobs.length).toBe(1);
  expect(api.jobs[0].kind).toBe("auto");
  expect(JSON.stringify(api.jobs[0])).not.toMatch(
    /DESIGN SAMPLE|DEMO ORDER|체험/,
  );
  await expect(
    page.getByRole("heading", { name: "주문이 완료됐어요" }),
  ).toBeVisible();
  await page.keyboard.press("Control+Alt+h");
  await page.getByRole("button", { name: /주문 001/ }).click();
  await page.getByRole("button", { name: "확인", exact: true }).click();
  expect(api.jobs.length).toBe(1);
  await page
    .getByRole("button", { name: "처음으로 돌아가기", exact: true })
    .click();
  await finish(page);
  await expect.poll(() => api.jobs.length).toBe(2);
});
test("failed payment and history never auto-print; pickup variant is preserved", async ({
  page,
}) => {
  const api = await mockBackend(page, { autoPrint: true, variant: "pickup" });
  await page.goto("/");
  await page.getByLabel("결제 테스트 결과").selectOption("failure");
  await finish(page);
  await expect(page.getByText("결제가 승인되지 않았어요")).toBeVisible();
  expect(api.jobs.length).toBe(0);
  await page.getByLabel("결제 테스트 결과").selectOption("success");
  await page
    .getByRole("button", { name: "다시 시도하기", exact: true })
    .click();
  await page.getByRole("button", { name: "결제 리더기", exact: true }).click();
  await expect.poll(() => api.jobs.length).toBe(1);
  expect(api.jobs[0].variant).toBe("pickup");
  await page.reload();
  await page.getByRole("button", { name: "주문 이력", exact: true }).click();
  await page.getByRole("button", { name: /주문 001/ }).click();
  expect(api.jobs.length).toBe(1);
});
test("touch and payment sounds play locally, while mute suppresses all tones", async ({
  page,
}) => {
  await mockBackend(page);
  await page.addInitScript(() => {
    (window as unknown as { toneCount: number }).toneCount = 0;
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (
      ...args: Parameters<typeof start>
    ) {
      (window as unknown as { toneCount: number }).toneCount++;
      return start.apply(this, args);
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: /포장할게요/ }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { toneCount: number }).toneCount,
      ),
    )
    .toBeGreaterThan(0);
  await page.getByRole("button", { name: "프린터 설정", exact: true }).click();
  await page
    .getByRole("checkbox", { name: "터치·주문·결제 효과음 사용", exact: true })
    .uncheck();
  await page.getByRole("button", { name: "설정 저장", exact: true }).click();
  const count = await page.evaluate(
    () => (window as unknown as { toneCount: number }).toneCount,
  );
  await page.getByRole("button", { name: "커피", exact: true }).click();
  expect(
    await page.evaluate(
      () => (window as unknown as { toneCount: number }).toneCount,
    ),
  ).toBe(count);
});

async function advancePaymentToFinalization(page: Page) {
  await expect(
    page.getByRole("heading", { name: "카드를 읽고 있어요" }),
  ).toBeVisible();
  await page.clock.runFor(1600);
  await expect(
    page.getByRole("heading", { name: "결제를 승인하고 있어요" }),
  ).toBeVisible();
  await page.clock.runFor(1800);
  await expect(
    page.getByRole("heading", { name: "결제가 완료됐어요" }),
  ).toBeVisible();
  await page.clock.runFor(1000);
}
async function freezeClock(page: Page) {
  await page.clock.install();
  await page.clock.pauseAt(Date.now() + 1000);
}

test("disabled automatic printing completes without hanging and returns home after five seconds", async ({
  page,
}) => {
  const backend = await mockBackend(page, { autoPrint: false });
  await freezeClock(page);
  await page.goto("/?kiosk=1");
  await finish(page);
  await advancePaymentToFinalization(page);
  await expect(
    page.getByRole("heading", { name: "주문이 완료됐어요" }),
  ).toBeVisible();
  await expect(
    page.getByText("주문번호로 받아 주세요.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("5초 후 처음 화면으로 돌아가요.", { exact: true }),
  ).toBeVisible();
  expect(backend.jobs.length).toBe(0);
  await page.clock.runFor(4000);
  await expect(
    page.getByText("1초 후 처음 화면으로 돌아가요.", { exact: true }),
  ).toBeVisible();
  await page.clock.runFor(1000);
  await expect(page.getByRole("button", { name: /먹고 갈게요/ })).toBeVisible();
});

for (const state of ["queued", "file-saved"] as const) {
  test(`loading waits beyond two seconds until ${state} acknowledgement, then reveals without an extra delay`, async ({
    page,
  }) => {
    await mockBackend(page, { autoPrint: true });
    let holdPreparation = false,
      releasePreparation!: () => void,
      releaseSpool!: () => void,
      count = 0;
    const preparation = new Promise<void>((r) => (releasePreparation = r)),
      spooling = new Promise<void>((r) => (releaseSpool = r));
    await page.route("**/api/status", async (route) => {
      if (holdPreparation) await preparation;
      await route.fallback();
    });
    await page.route("**/api/print", async (route) => {
      count++;
      await spooling;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ id: "one", state }),
      });
    });
    await freezeClock(page);
    await page.goto("/?kiosk=1");
    await finish(page);
    holdPreparation = true;
    await advancePaymentToFinalization(page);
    const loading = page.getByRole("heading", {
      name: "주문을 완료하고 있어요",
    });
    await expect(loading).toBeVisible();
    await page.clock.runFor(3000);
    await expect(loading).toBeVisible();
    expect(count).toBe(0);
    releasePreparation();
    await expect.poll(() => count).toBe(1);
    await page.clock.runFor(7000);
    await expect(loading).toBeVisible();
    await expect(page.locator(".completed-screen")).toHaveCount(0);
    await expect(page.locator(".receipt-machine-paper")).toHaveCount(0);
    releaseSpool(); // Page time remains paused: completion must depend on this response alone.
    const complete = page.locator(".completed-screen");
    await expect(complete.getByRole("heading")).toHaveText("주문이 완료됐어요");
    await expect(complete.getByRole("status")).toHaveText(
      "영수증 출력중이에요.",
    );
    await expect(
      complete.getByText("5초 후 처음 화면으로 돌아가요.", { exact: true }),
    ).toBeVisible();
    await expect(complete).toContainText("001번으로 알려드릴게요.");
    await expect(complete).toContainText("맛있게 드세요!");
    await expect(
      complete.getByRole("button", { name: "영수증 보기", exact: true }),
    ).toHaveCount(0);
    expect(count).toBe(1);
  });
}

test("spool failure ends loading with an honest notice and never retries printing automatically", async ({
  page,
}) => {
  await mockBackend(page, { autoPrint: true });
  let count = 0,
    release!: () => void;
  const spool = new Promise<void>((r) => (release = r));
  await page.route("**/api/print", async (route) => {
    count++;
    await spool;
    await route.fulfill({
      contentType: "application/json",
      body: '{"id":"one","state":"uncertain","message":"worker timeout"}',
    });
  });
  await freezeClock(page);
  await page.goto("/?kiosk=1");
  await finish(page);
  await advancePaymentToFinalization(page);
  await expect(
    page.getByRole("heading", { name: "주문을 완료하고 있어요" }),
  ).toBeVisible();
  await expect.poll(() => count).toBe(1);
  release();
  const complete = page.locator(".completed-screen");
  await expect(complete.getByRole("heading")).toHaveText("주문이 완료됐어요");
  await expect(complete.getByRole("status")).toHaveText(
    "영수증 출력 확인이 필요해요.",
  );
  await expect(complete).not.toContainText("worker timeout");
  await expect(complete).not.toContainText("영수증 출력중이에요.");
  await page.clock.runFor(5000);
  await expect(page.getByRole("button", { name: /먹고 갈게요/ })).toBeVisible();
  expect(count).toBe(1);
});
