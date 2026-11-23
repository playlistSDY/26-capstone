import { test, expect, type Page } from "@playwright/test";
import { mockBackend } from "./backend-fixture";

async function fixture(page: Page, delayedReply = false) {
  await mockBackend(page);
  const events = new Map<string, any>();
  let releaseAudio!: () => void;
  const audioGate = new Promise<void>((resolve) => {
    releaseAudio = resolve;
  });
  let releaseReply!: () => void;
  const replyGate = new Promise<void>((resolve) => {
    releaseReply = resolve;
  });
  let turns = 0;
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
      turns++;
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
    if (path.endsWith("/events")) {
      if (delayedReply) await replyGate;
      return route.fulfill({
        contentType: "application/x-ndjson",
        body: JSON.stringify(events.get(path.split("/").at(-2)!)) + "\n",
      });
    }
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
  return {
    avatar,
    say,
    releaseAudio,
    releaseReply,
    turns: () => turns,
    audioCalls: () => audioCalls,
  };
}

test("The large clerk shows a listening bubble during the STT substitute input", async ({
  page,
}) => {
  const f = await fixture(page);
  await expect(f.avatar).toBeVisible();
  await expect(f.avatar).toHaveAttribute("data-mouth", "closed");
  await expect(page.getByText("듣고 있어요", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("log", { name: "주문 대화" })).toBeHidden();
  await expect(page.getByRole("button", { name: /대화 내역/ })).toHaveCount(0);
  await expect(page.locator(".agent-guidance")).toHaveCount(0);
  expect((await page.request.get("/agent/clerk-atlas.png")).status()).toBe(200);
  await page.getByRole("textbox", { name: "주문 메시지" }).fill("라떼");
  await expect(f.avatar).toHaveAttribute("data-state", "typing");
  await expect(page.getByLabel("내가 한 말")).toHaveCount(0);
  await expect(page.locator(".companion-caption")).toHaveText("듣고 있어요");
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
  await page.waitForTimeout(850);
  const inSpace = await page.evaluate(() => {
    const actor = document
      .querySelector(".kiosk-companion")!
      .getBoundingClientRect();
    const space = document
      .querySelector(".agent-dialogue-space")!
      .getBoundingClientRect();
    const menu = document
      .querySelector(".catalog-scroll")!
      .getBoundingClientRect();
    return {
      actor: { y: actor.y, bottom: actor.bottom },
      space: { y: space.y, bottom: space.bottom },
      menu: { y: menu.y, bottom: menu.bottom },
    };
  });
  expect(inSpace.menu.bottom).toBeLessThanOrEqual(inSpace.space.y + 1);
  expect(inSpace.actor.y).toBeGreaterThanOrEqual(inSpace.space.y - 1);
  expect(inSpace.actor.bottom).toBeLessThanOrEqual(inSpace.space.bottom + 1);
  const character = await f.avatar.boundingBox();
  const bubbles = await page.locator(".companion-bubbles").boundingBox();
  expect(
    character!.height / (inSpace.actor.bottom - inSpace.actor.y),
  ).toBeGreaterThan(0.9);
  expect(character!.x + character!.width).toBeLessThanOrEqual(bubbles!.x);
  await page.screenshot({ path: "/tmp/switch-avatar-speaking.png" });
  await page.getByRole("button", { name: "말 끊기", exact: true }).click();
  await expect(f.avatar).toHaveAttribute("data-mouth", "closed");
  await expect(f.avatar).toHaveAttribute("data-state", "ready");
  await page.waitForTimeout(250);
  await expect(f.avatar).toHaveAttribute("data-mouth", "closed");
});

test("Finished user speech appears in an opposite-colored bubble without idle labels or history controls", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.getByRole("button", { name: "음성 끄기", exact: true }).click();
  await f.say("라떼 설명해줘");
  expect(f.audioCalls()).toBe(0);
  await expect(f.avatar).toHaveAttribute("data-mouth", "closed");
  await expect(page.getByLabel("내가 한 말")).toHaveText("라떼 설명해줘");
  const userColor = await page
    .locator(".companion-user-bubble")
    .evaluate((node) => getComputedStyle(node).backgroundColor);
  const agentColor = await page
    .locator(".companion-speech")
    .last()
    .evaluate((node) => getComputedStyle(node).backgroundColor);
  expect(userColor).not.toBe(agentColor);
  await expect(page.getByRole("button", { name: /대화 내역/ })).toHaveCount(0);
  await expect(page.getByText("입력 대기", { exact: true })).toHaveCount(0);
  await page.getByRole("textbox", { name: "주문 메시지" }).fill("다른 메뉴도");
  await expect(page.locator(".companion-user-bubble").last()).toContainText(
    "듣고 있어요",
  );
  await expect(page.locator(".companion-speech").last()).toContainText(
    "따뜻한 라떼",
  );
  const order = await page
    .locator(".companion-bubbles > div")
    .evaluateAll((nodes) =>
      nodes.map((node) => ({
        user: node.classList.contains("companion-user-bubble"),
        text: node.textContent,
      })),
    );
  expect(order.at(-1)?.user).toBe(true);
  expect(order.at(-2)?.text).toContain("따뜻한 라떼");
});

test("The character lives inside the kiosk and follows screen changes without covering buttons", async ({
  page,
}) => {
  await page.setViewportSize({ width: 430, height: 960 });
  await fixture(page);
  const companion = page.locator(".kiosk-companion");
  await expect(companion).toBeVisible();
  const kioskBounds = await page.locator(".kiosk").boundingBox();
  const characterBounds = await page
    .locator(".companion-character")
    .boundingBox();
  expect(characterBounds!.width / kioskBounds!.width).toBeCloseTo(460 / 800, 2);
  expect(characterBounds!.x + characterBounds!.width / 2).toBeCloseTo(
    kioskBounds!.x + kioskBounds!.width / 2,
    0,
  );
  const greeting = page.getByRole("heading", {
    name: "안녕하세요. 무엇을 드릴까요?",
  });
  const greetingBounds = await greeting.boundingBox();
  expect(greetingBounds!.y).toBeGreaterThan(
    characterBounds!.y + characterBounds!.height,
  );
  const choices = await page.locator(".place-cards").boundingBox();
  const gap = choices!.y - (greetingBounds!.y + greetingBounds!.height);
  expect(gap).toBeGreaterThan(0);
  expect(gap / kioskBounds!.width).toBeLessThan(0.17);
  for (const text of [
    "SWitch 커피",
    "반가워요, 오늘도 SWitch",
    "오늘은 어디서",
    "취향에 맞는 한 잔을 준비해 드릴게요.",
    "좋은 하루의 시작, 좋은 커피 한 잔.",
  ]) {
    await expect(page.getByText(text, { exact: true })).toHaveCount(0);
  }
  await expect(
    page.getByRole("button", { name: "도움이 필요해요" }),
  ).toHaveCount(0);
  const centerX = characterBounds!.x + characterBounds!.width / 2;
  const centerY = characterBounds!.y + characterBounds!.height / 2;
  await page.mouse.click(centerX, centerY);
  await page.mouse.move(centerX, centerY);
  await page.mouse.down();
  await page.mouse.move(centerX + 36, centerY + 24, { steps: 4 });
  await page.mouse.up();
  await expect(greeting).toBeVisible();
  const afterGesture = await page.locator(".companion-character").boundingBox();
  expect(Math.abs(afterGesture!.x - characterBounds!.x)).toBeLessThan(2);
  expect(Math.abs(afterGesture!.y - characterBounds!.y)).toBeLessThan(2);
  expect(
    await page
      .locator(".kiosk")
      .evaluate((node) => getComputedStyle(node).paddingBottom),
  ).toBe("0px");

  await expect(page.locator(".agent-chat-dialog")).toHaveCount(0);
  const initialY = await companion.getAttribute("data-y");
  await page.getByRole("button", { name: /먹고 갈게요/ }).click();
  await expect(companion).toHaveAttribute("data-screen", "menu");
  await expect(companion.locator(".companion-caption")).toHaveCSS(
    "font-size",
    "24px",
  );
  await page.getByRole("button", { name: "디카페인", exact: true }).click();
  await page
    .locator('[data-guide="product"][data-guide-product="latte"]')
    .click();
  await page
    .locator('[data-guide-option="temperature"][data-guide-value="hot"]')
    .click();
  await page.locator('[data-guide="editor.add"]').click();
  await expect(page.locator(".agent-dialogue-space")).toHaveCSS(
    "margin-bottom",
    "14px",
  );
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

test("The option dialogue sits above product details and stays fixed while scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 960 });
  await fixture(page);
  await page.getByRole("button", { name: /먹고 갈게요/ }).click();
  await page.getByRole("button", { name: /복숭아 아이스티.*3,500원/ }).click();
  const modal = page.getByRole("dialog", { name: "메뉴 선택" });
  await expect(modal.getByText("메뉴 선택", { exact: true })).toHaveCount(0);
  await expect(modal.getByText("SWitch COFFEE", { exact: true })).toHaveCount(0);
  await expect(modal.getByRole("button", { name: "닫기" })).toBeVisible();
  const topBar = modal.locator(".modal-top");
  await expect(topBar).toHaveCSS("border-bottom-width", "0px");
  const dialogue = modal.locator(".option-companion-slot");
  await expect(dialogue.locator(".agent-avatar")).toBeVisible();
  await expect(dialogue).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect(dialogue).toHaveCSS("border-bottom-width", "1px");
  const header = await topBar.boundingBox();
  const companion = await dialogue.boundingBox();
  const product = await modal.locator(".option-intro").boundingBox();
  const photo = await modal.locator(".option-photo").boundingBox();
  const avatar = await dialogue.locator(".agent-avatar").boundingBox();
  const bubble = await dialogue.locator(".companion-speech").boundingBox();
  const temperature = await modal
    .getByRole("heading", { name: /온도/ })
    .boundingBox();
  expect(header!.y + header!.height).toBeLessThanOrEqual(companion!.y + 1);
  expect(companion!.y + companion!.height).toBeLessThanOrEqual(product!.y + 1);
  expect(product!.y + product!.height).toBeLessThanOrEqual(temperature!.y);
  const photoTopGap = photo!.y - product!.y;
  const photoBottomGap = product!.y + product!.height - photo!.y - photo!.height;
  expect(Math.abs(photoTopGap - photoBottomGap)).toBeLessThan(1);
  const divider = companion!.y + companion!.height;
  expect(divider - (avatar!.y + avatar!.height)).toBeGreaterThan(10);
  expect(divider - (bubble!.y + bubble!.height)).toBeGreaterThan(10);

  const options = modal.locator(".option-scroll");
  await options.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  expect(await options.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  const large = modal.getByRole("button", { name: /라지/ });
  await large.click();
  await expect(large).toHaveAttribute("aria-pressed", "true");
  await expect(large).toHaveCSS("border-color", "rgb(74, 107, 237)");
  await expect(large).toHaveCSS("background-color", "rgb(245, 247, 255)");
  await expect(large.locator("svg")).toHaveCount(0);
  const afterSelection = await dialogue.boundingBox();
  expect(afterSelection!.x).toBeCloseTo(companion!.x, 0);
  expect(afterSelection!.y).toBeCloseTo(companion!.y, 0);
  await expect(modal.getByRole("heading", { name: "복숭아 아이스티" })).toBeVisible();
});

test("The raised hand uses an unclipped full avatar frame", async ({ page }) => {
  const { avatar } = await fixture(page);
  const sprite = avatar.locator(".avatar-body");
  await sprite.evaluate((element) => {
    const wave = element.getAnimations().find(
      (animation) =>
        (animation as CSSAnimation).animationName === "attendant-wave",
    )!;
    wave.pause();
    wave.currentTime = 17_000;
  });
  await expect(sprite).toHaveCSS("background-position", "100% 100%");
  await expect(sprite).toHaveCSS("clip-path", "none");
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

test("Long thinking updates a chat bubble without moving the character or repeating the request", async ({
  page,
}) => {
  await page.clock.install();
  const f = await fixture(page, true);
  await page.getByRole("button", { name: "음성 끄기", exact: true }).click();
  await page
    .getByRole("textbox", { name: "주문 메시지" })
    .fill("라떼 설명해줘");
  await expect(page.locator(".companion-caption")).toHaveText("듣고 있어요");
  await page
    .getByRole("button", { name: "메시지 보내기", exact: true })
    .click();
  await expect(f.avatar).toHaveAttribute("data-state", "thinking");
  await page.clock.runFor(1500);
  const anchor = await page
    .locator(".kiosk-companion")
    .evaluate(
      (node) => `${node.getAttribute("data-x")},${node.getAttribute("data-y")}`,
    );
  const first = await page.locator(".companion-caption").textContent();
  await page.clock.runFor(8000);
  await expect(page.locator(".companion-caption")).not.toHaveText(first!);
  await page.clock.runFor(24000);
  await expect(page.locator(".companion-caption")).toContainText(/늦어|기다/);
  expect(
    await page
      .locator(".kiosk-companion")
      .evaluate(
        (node) =>
          `${node.getAttribute("data-x")},${node.getAttribute("data-y")}`,
      ),
  ).toBe(anchor);
  expect(f.turns()).toBe(1);
  f.releaseReply();
  await expect(page.locator(".companion-caption")).toContainText("따뜻한 라떼");
  await page.clock.runFor(1000);
  expect(
    await page
      .locator(".kiosk-companion")
      .evaluate(
        (node) =>
          `${node.getAttribute("data-x")},${node.getAttribute("data-y")}`,
      ),
  ).toBe(anchor);
  await page.screenshot({ path: "/tmp/switch-hover-waiting.png" });
});

test("The companion keeps the kiosk's proportions across test screens and native size", async ({
  page,
}) => {
  await fixture(page);
  for (const [width, height] of [
    [1600, 2560],
    [1360, 1040],
    [820, 1180],
    [430, 960],
    [320, 740],
    [1200, 600],
  ]) {
    await page.setViewportSize({ width, height });
    await expect
      .poll(async () => {
        const stage = await page.locator(".kiosk").boundingBox();
        const character = await page
          .locator(".companion-character")
          .boundingBox();
        const dialogue = await page.locator(".kiosk-companion").boundingBox();
        if (stage!.x < -1 || stage!.x + stage!.width > width + 1) return 1;
        return (
          Math.abs(character!.width / stage!.width - 460 / 800) +
          Math.abs(dialogue!.width / stage!.width - 640 / 800)
        );
      })
      .toBeLessThan(0.01);
    const font = await page
      .locator(".companion-text")
      .last()
      .evaluate((n) => getComputedStyle(n).fontSize);
    expect(font).toBe("46px");
  }
  await page.setViewportSize({ width: 1360, height: 1700 });
  await page.getByRole("button", { name: "실제 크기", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await page.locator(".companion-character").boundingBox())!.width,
    )
    .toBeCloseTo(460, 0);
  expect(
    (await page.locator(".kiosk-companion").boundingBox())!.height,
  ).toBeCloseTo(600, 0);
});
