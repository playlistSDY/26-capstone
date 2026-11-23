import { test, expect, type Page } from "@playwright/test";
import { mockBackend } from "./backend-fixture";

async function fixture(page: Page) {
  await mockBackend(page);
  const events = new Map<string, any>();
  let releaseAudio!: () => void;
  const audioGate = new Promise<void>((resolve) => {
    releaseAudio = resolve;
  });
  let audioCalls = 0;
  await page.route("**/agent-api/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (path.endsWith("/status"))
      return route.fulfill({
        json: {
          ready: true,
          token: "avatar-test",
          message: "OpenAI 에이전트 연결됨 · 가상 주문",
        },
      });
    if (path.endsWith("/sessions"))
      return route.fulfill({ json: { session_id: "avatar-session" } });
    if (path.endsWith("/speech")) {
      audioCalls++;
      await audioGate;
      const pcm = Buffer.alloc(24000 * 2 * 2);
      for (let i = 0; i < 24000 * 2; i++) {
        const silent = i >= 12000 && i < 18000;
        pcm.writeInt16LE(
          silent ? 0 : Math.round(Math.sin(i * 0.08) * 9000),
          i * 2,
        );
      }
      return route.fulfill({
        contentType: "application/x-ndjson",
        body:
          JSON.stringify({
            type: "audio.delta",
            pcm: pcm.toString("base64"),
            sample_rate: 24000,
          }) +
          "\n" +
          JSON.stringify({ type: "audio.done" }) +
          "\n",
      });
    }
    if (path.endsWith("/turns")) {
      const body = request.postDataJSON();
      events.set(body.request_id, {
        type: "final",
        sequence: 1,
        ok: true,
        text: "따뜻한 라떼 한 잔이에요. 크기와 온도는 말씀하시면 바꿔드릴게요.",
        needs_delivery: false,
        state: {
          phase: "ordering",
          view: "menu",
          place: null,
          lines: [],
          total: 0,
        },
      });
      return route.fulfill({ json: { ok: true } });
    }
    if (path.endsWith("/events"))
      return route.fulfill({
        contentType: "application/x-ndjson",
        body: JSON.stringify(events.get(path.split("/").at(-2)!)) + "\n",
      });
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto("/");
  const avatar = page.locator(".kiosk-companion .agent-avatar");
  await expect(avatar).toHaveAttribute("data-state", "ready");
  async function say(text: string) {
    await page.getByRole("textbox", { name: "주문 메시지" }).fill(text);
    await page
      .getByRole("button", { name: "메시지 보내기", exact: true })
      .click();
    await expect(page.locator(".agent-chat-thinking")).toHaveCount(0);
    await expect(page.locator(".companion-caption")).toContainText(
      "따뜻한 라떼",
    );
  }
  return { avatar, say, releaseAudio, audioCalls: () => audioCalls };
}

test("The supplied clerk stays visible with honest input status and existing history", async ({
  page,
}) => {
  const f = await fixture(page);
  await expect(f.avatar).toBeVisible();
  await expect(f.avatar).toHaveAttribute("data-mouth", "closed");
  await expect(page.getByText("듣고 있어요", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("log", { name: "주문 대화" })).toBeHidden();
  await page
    .getByRole("button", { name: "대화 내역 보기", exact: true })
    .click();
  await expect(page.getByRole("log", { name: "주문 대화" })).toContainText(
    "안녕하세요",
  );
  await page.locator(".kiosk-history-heading button").click();
  await expect(page.locator(".agent-guidance")).toHaveCount(0);
  expect((await page.request.get("/agent/clerk-atlas.png")).status()).toBe(200);
  await page.getByRole("textbox", { name: "주문 메시지" }).fill("라떼");
  await expect(f.avatar).toHaveAttribute("data-state", "typing");
  await expect(page.getByLabel("내가 한 말")).toContainText("라떼");
  await page.screenshot({ path: "/tmp/switch-avatar-desktop.png" });
});

test("The mouth waits for actual PCM playback and closes immediately on interruption", async ({
  page,
}) => {
  const f = await fixture(page);
  await f.say("따뜻한 라떼 설명해줘");
  await expect(page.getByLabel("내가 한 말")).toContainText(
    "따뜻한 라떼 설명해줘",
  );
  await expect(f.avatar).toHaveAttribute("data-state", "buffering");
  await expect(f.avatar).toHaveAttribute("data-mouth", "closed");
  f.releaseAudio();
  await expect(f.avatar).toHaveAttribute("data-state", "speaking");
  await expect(f.avatar).toHaveAttribute("data-mouth", "open");
  await page.screenshot({ path: "/tmp/switch-avatar-speaking.png" });
  await page.getByRole("button", { name: "말 끊기", exact: true }).click();
  await expect(f.avatar).toHaveAttribute("data-mouth", "closed");
  await expect(f.avatar).toHaveAttribute("data-state", "ready");
  await page.waitForTimeout(250);
  await expect(f.avatar).toHaveAttribute("data-mouth", "closed");
});

test("Muted replies retain subtitles and can expand or fold full conversation history", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.getByRole("button", { name: "음성 끄기", exact: true }).click();
  await f.say("라떼 설명해줘");
  expect(f.audioCalls()).toBe(0);
  await expect(f.avatar).toHaveAttribute("data-mouth", "closed");
  await expect(page.getByRole("log", { name: "주문 대화" })).toBeHidden();
  await expect(page.locator(".companion-caption")).toContainText("따뜻한 라떼");
  await page
    .getByRole("button", { name: "대화 내역 보기", exact: true })
    .click();
  await expect(page.getByRole("log", { name: "주문 대화" })).toContainText(
    "라떼 설명해줘",
  );
  await page.locator(".kiosk-history-heading button").click();
  await expect(page.getByRole("log", { name: "주문 대화" })).toBeHidden();
});

test("The character lives inside the kiosk and follows screen changes without covering buttons", async ({
  page,
}) => {
  await page.setViewportSize({ width: 430, height: 960 });
  await fixture(page);
  const companion = page.locator(".kiosk-companion");
  await expect(companion).toBeVisible();
  await expect(page.locator(".agent-chat-dialog")).toHaveCount(0);
  const initialY = await companion.getAttribute("data-y");
  await page.getByRole("button", { name: /먹고 갈게요/ }).click();
  await page
    .locator('[data-guide="product"][data-guide-product="latte"]')
    .click();
  await page
    .locator('[data-guide-option="temperature"][data-guide-value="hot"]')
    .click();
  await page.locator('[data-guide="editor.add"]').click();
  await page.getByRole("button", { name: "결제하기", exact: true }).click();
  await expect(companion).toHaveAttribute("data-screen", "cart");
  await expect.poll(() => companion.getAttribute("data-y")).not.toBe(initialY);
  await page.waitForTimeout(650);
  const character = await companion.boundingBox();
  const kiosk = await page.locator(".kiosk").boundingBox();
  expect(character!.x).toBeGreaterThanOrEqual(kiosk!.x);
  expect(character!.x + character!.width).toBeLessThanOrEqual(
    kiosk!.x + kiosk!.width + 1,
  );
  expect(character!.y + character!.height).toBeLessThanOrEqual(
    kiosk!.y + kiosk!.height + 1,
  );
  const button = await page
    .getByRole("button", { name: "확인하고 결제하기", exact: true })
    .boundingBox();
  const overlap =
    character!.x < button!.x + button!.width &&
    character!.x + character!.width > button!.x &&
    character!.y < button!.y + button!.height &&
    character!.y + character!.height > button!.y;
  expect(overlap).toBe(false);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "/tmp/switch-avatar-mobile.png",
    fullPage: true,
  });
});

test("Natural audio completion closes the mouth and reduced motion disables idle gestures", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const f = await fixture(page);
  expect(
    await f.avatar
      .locator(".avatar-rig")
      .evaluate((node) => getComputedStyle(node).animationName),
  ).toBe("none");
  await f.say("설명해줘");
  f.releaseAudio();
  await expect(f.avatar).toHaveAttribute("data-mouth", "open");
  await expect(f.avatar).toHaveAttribute("data-state", "ready", {
    timeout: 8000,
  });
  await expect(f.avatar).toHaveAttribute("data-mouth", "closed");
});
