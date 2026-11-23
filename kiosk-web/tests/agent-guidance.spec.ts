import { test, expect, type Page } from "@playwright/test";
import { mockBackend } from "./backend-fixture";

const options = {
  temperature: "ice",
  size: "regular",
  shots: 0,
  syrup: 0,
  milk: "regular",
  ice: "normal",
  sweetness: "normal",
  decaf: true,
};
async function fixture(page: Page) {
  await mockBackend(page);
  const requests: any[] = [];
  const turns = new Map<string, any>();
  let respond: (body: any) => any = () => ({});
  let report: any = undefined;
  await page.route("**/agent-api/**", async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    if (path.endsWith("/status"))
      return route.fulfill({
        json: { ready: true, token: "test", message: "테스트 연결" },
      });
    if (path.endsWith("/sessions"))
      return route.fulfill({ json: { session_id: "guide-session" } });
    if (path.endsWith("/turns")) {
      const body = req.postDataJSON();
      requests.push(body);
      const state = {
        phase: "ordering",
        view: "menu",
        place: body.cart.place,
        lines: body.cart.lines.map((line: any) => ({
          id: line.id,
          product_id: line.productId,
          quantity: line.quantity,
          options: line.options,
        })),
        total: body.cart.lines.reduce(
          (sum: number, line: any) =>
            sum +
            (4700 + (line.options.size === "large" ? 500 : 0)) * line.quantity,
          0,
        ),
        ...respond(body),
      };
      turns.set(body.request_id, {
        type: "final",
        sequence: 1,
        ok: true,
        text: "현재 화면에 설명하는 위치를 표시했어요.",
        state,
        needs_delivery: false,
        usage: report,
      });
      return route.fulfill({ json: { ok: true } });
    }
    if (path.endsWith("/events"))
      return route.fulfill({
        contentType: "application/x-ndjson",
        body: JSON.stringify(turns.get(path.split("/").at(-2)!)) + "\n",
      });
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "음성 끄기", exact: true }).click();
  async function say(text: string) {
    const previous = requests.length;
    await page.getByRole("textbox", { name: "주문 메시지" }).fill(text);
    await page
      .getByRole("button", { name: "메시지 보내기", exact: true })
      .click();
    await expect.poll(() => requests.length).toBe(previous + 1);
    await expect(page.locator(".agent-chat-thinking")).toHaveCount(0);
  }
  return {
    requests,
    say,
    reportUsage: (value: any) => {
      report = value;
    },
    respond: (fn: typeof respond) => {
      respond = fn;
    },
  };
}
const guide = (target: string, extra = {}) => ({
  id: crypto.randomUUID(),
  target,
  instruction: "설명하는 버튼이에요. 직접 누르거나 말로 부탁하셔도 돼요.",
  ...extra,
});

test("Option dialogue opens its drink and highlights the discussed option without selecting it", async ({
  page,
}) => {
  const f = await fixture(page);
  f.respond(() => ({
    item_drafts: [
      {
        product_id: "latte",
        quantity: 2,
        options: { ...options, temperature: null },
        next_option: "temperature",
        question: "따뜻하게 드릴까요, 차갑게 드릴까요?",
      },
    ],
  }));
  await f.say("라떼 두 잔 줘");
  await expect(
    page.getByRole("dialog", { name: "메뉴 선택", exact: true }),
  ).toContainText("카페라떼");
  await expect(page.locator(".agent-guide-ring")).toBeVisible();
  await expect(
    page.locator(
      '[data-guide="option"][data-guide-option="temperature"][data-guide-value="ice"]',
    ),
  ).toHaveAttribute("aria-pressed", "false");
  f.respond(() => ({
    guidance: guide("option", {
      product_id: "latte",
      option: "size",
      value: "large",
    }),
  }));
  await f.say("큰 크기는 뭐야?");
  await expect(
    page.locator(
      '[data-guide="option"][data-guide-option="size"][data-guide-value="large"]',
    ),
  ).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".agent-guide-ring")).toBeVisible();
  expect(f.requests.at(-1).cart.lines).toHaveLength(0);
});

test("A customer can choose options and add manually after a brief non-prescriptive explanation", async ({
  page,
}) => {
  const f = await fixture(page);
  f.respond(() => ({
    item_drafts: [
      { product_id: "latte", quantity: 2, options, next_option: "size" },
    ],
    guidance: guide("editor.add", {
      product_id: "latte",
      instruction: "원하는 옵션을 고른 뒤 담기를 눌러 주세요.",
    }),
  }));
  await f.say("귀찮으니까 나머지는 내가 고를게");
  await expect(page.locator(".agent-guidance")).toHaveCount(0);
  await expect(page.locator(".agent-guide-ring")).toBeVisible();
  await page
    .locator('[data-guide-option="size"][data-guide-value="large"]')
    .click();
  await expect(page.locator(".agent-guide-ring")).toHaveCount(0);
  await page
    .locator('[data-guide-option="ice"][data-guide-value="less"]')
    .click();
  await page.locator('[data-guide="editor.add"]').click();
  await f.say("이제 어떻게 해?");
  const cart = f.requests.at(-1).cart;
  expect(cart.lines[0].quantity).toBe(2);
  expect(cart.lines[0].options).toMatchObject({ size: "large", ice: "less" });
  expect(cart.ui_context.interaction.option_changes).toBe(2);
  expect(cart.ui_context.interaction.activations).toBeGreaterThanOrEqual(3);
});

test("Highlights work through conversation without tutorial controls and preserve touch choices", async ({
  page,
}) => {
  const f = await fixture(page);
  f.respond(() => ({
    lines: [{ id: "line-one", product_id: "latte", quantity: 1, options }],
    total: 4700,
  }));
  await f.say("아이스 라떼 기본으로 담아줘");
  await expect(page.locator(".agent-guide-ring")).toBeVisible();
  await expect(page.locator(".agent-guidance")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "사용법 알려줘", exact: true }),
  ).toHaveCount(0);
  if (process.env.SWITCH_GUIDANCE_SCREENSHOT)
    await page.screenshot({ path: "/tmp/switch-guidance-desktop.png" });
  f.respond(() => ({
    guidance: guide("cart.quantity", { line_id: "line-one" }),
  }));
  await f.say("수량 버튼은 어디야?");
  await expect(page.locator(".agent-guide-ring")).toBeVisible();
  await page
    .getByRole("button", {
      name: "디카페인 카페라떼 주문 수량 늘리기",
      exact: true,
    })
    .click();
  await expect(page.locator(".agent-guide-ring")).toHaveCount(0);
  f.respond(() => ({
    guidance: guide("cart.options", { line_id: "line-one" }),
  }));
  await f.say("옵션 버튼은 어디야?");
  await expect(page.locator(".agent-guide-ring")).toBeVisible();
  await page
    .getByRole("button", { name: "디카페인 카페라떼 옵션 변경", exact: true })
    .click();
  await page
    .locator('[data-guide-option="size"][data-guide-value="large"]')
    .click();
  f.respond(() => ({
    guidance: guide("editor.add", {
      product_id: "latte",
      line_id: "line-one",
      instruction: "원하는 옵션을 고른 뒤 수정하기를 눌러 주세요.",
    }),
  }));
  await f.say("원하는대로 고르고 있어");
  await expect(page.locator(".agent-guide-ring")).toBeVisible();
  f.respond((body) => ({
    lines: [
      {
        id: "line-one",
        product_id: "latte",
        quantity: body.cart.ui_context.editor.quantity,
        options: body.cart.ui_context.editor.options,
      },
    ],
    total: 10400,
  }));
  await f.say("이대로 대신 수정해줘");
  const request = f.requests.at(-1);
  expect(request.text).toContain("대신");
  expect(request.cart.ui_context.editor.quantity).toBe(2);
  expect(request.cart.ui_context.editor.options.size).toBe("large");
  expect(
    request.cart.ui_context.interaction.guidance_completed,
  ).toBeGreaterThanOrEqual(1);
  await expect(page.locator(".cart-tally")).toContainText("10,400");
});

test("Payment explanation highlights a method without starting the reader", async ({
  page,
}) => {
  const f = await fixture(page);
  f.respond(() => ({
    phase: "checkout",
    view: "payment",
    place: "store",
    lines: [{ id: "one", product_id: "latte", quantity: 1, options }],
    total: 4700,
    guidance: guide("payment.method", { value: "card" }),
  }));
  await f.say("카드 버튼이 어디야");
  await expect(page.locator(".agent-guide-ring")).toBeVisible();
  await expect(page.locator(".payment-method.card")).toBeVisible();
  await expect(page.getByRole("dialog", { name: /카드/ })).toHaveCount(0);
});

test("Narrow screen and reduced motion keep the target visible without covering navigation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const f = await fixture(page);
  f.respond(() => ({ guidance: guide("product", { product_id: "latte" }) }));
  await f.say("라떼를 설명해줘");
  const ring = page.locator(".agent-guide-ring");
  await expect(ring).toBeVisible();
  await expect(ring).toBeEmpty();
  const outline = await ring.evaluate((node) => {
    const style = getComputedStyle(node, "::before");
    return {
      gap: -parseFloat(style.top) - parseFloat(style.borderTopWidth),
      animation: style.animationName,
      shadow: style.boxShadow,
    };
  });
  expect(outline.gap).toBe(5);
  expect(outline.animation).toBe("none");
  expect(outline.shadow).not.toBe("none");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect
    .poll(() =>
      ring.evaluate((node) => getComputedStyle(node, "::before").animationName),
    )
    .toBe("guide-product-breathe");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(
    await ring.evaluate((node) => getComputedStyle(node).pointerEvents),
  ).toBe("none");
  if (process.env.SWITCH_GUIDANCE_SCREENSHOT)
    await page.screenshot({
      path: "/tmp/switch-guidance-mobile.png",
      fullPage: true,
    });
  await page
    .locator('[data-guide="product"][data-guide-product="latte"]')
    .click();
  await expect(ring).toHaveCount(0);
  await expect(page.locator(".agent-guidance")).toHaveCount(0);
});

test("Explanation preserves touch choices even when an older option draft remains", async ({
  page,
}) => {
  const f = await fixture(page);
  const oldDraft = {
    product_id: "latte",
    quantity: 2,
    options,
    next_option: "size",
  };
  f.respond(() => ({ item_drafts: [oldDraft] }));
  await f.say("아이스 라떼 두 잔");
  await page
    .locator('[data-guide-option="size"][data-guide-value="large"]')
    .click();
  f.respond((body) => ({
    item_drafts: [oldDraft],
    ui_context: body.cart.ui_context,
    guidance: guide("editor.add", {
      product_id: "latte",
      instruction: "원하는 옵션을 고른 뒤 담기를 눌러 주세요.",
    }),
  }));
  await f.say("설명은 짧게 해줘");
  await expect(
    page.locator('[data-guide-option="size"][data-guide-value="large"]'),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('[data-guide="editor.add"]')).toContainText(
    "10,400원",
  );
});

test("New cream and ice controls are highlighted and direct changes reach the next turn", async ({
  page,
}) => {
  const f = await fixture(page);
  f.respond(() => ({
    item_drafts: [
      {
        product_id: "mocha",
        quantity: 1,
        options: { ...options, whippedCream: "normal" },
        next_option: "whippedCream",
      },
    ],
    guidance: guide("option", {
      product_id: "mocha",
      option: "whippedCream",
      value: "none",
    }),
  }));
  await f.say("휘핑 빼는 건 어디야?");
  const cream = page.locator(
    '[data-guide-option="whippedCream"][data-guide-value="none"]',
  );
  await expect(cream).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".agent-guide-ring")).toBeVisible();
  await cream.click();
  await page
    .locator('[data-guide-option="ice"][data-guide-value="more"]')
    .click();
  f.respond((body) => ({
    ui_context: body.cart.ui_context,
    guidance: guide("option", {
      product_id: "mocha",
      option: "ice",
      value: "more",
    }),
  }));
  await f.say("얼음 많이면 어떻게 돼?");
  expect(f.requests.at(-1).cart.ui_context.editor.options).toMatchObject({
    decaf: true,
    ice: "more",
    whippedCream: "none",
  });
  await expect(page.locator(".agent-guide-ring")).toBeVisible();
  await expect(
    page.locator('[data-guide-option="ice"][data-guide-value="more"]'),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('[data-guide="editor.add"]')).toContainText(
    "4,700원",
  );
});

test("Delegated 100-cup orders reach the screen and stay in the following turn", async ({
  page,
}) => {
  const f = await fixture(page);
  const lines = [
    { id: "bulk-31", product_id: "latte", quantity: 31, options },
    {
      id: "bulk-19",
      product_id: "latte",
      quantity: 19,
      options: { ...options, temperature: "hot" },
    },
    {
      id: "bulk-50",
      product_id: "mocha",
      quantity: 50,
      options: { ...options, temperature: "hot", whippedCream: "none" },
    },
  ];
  f.respond(() => ({ lines, total: 470000 }));
  await f.say("100명 걸로 알아서 담아줘");
  await expect(page.locator(".cart-tally")).toContainText("100개");
  await expect(page.getByRole("alert")).toHaveCount(0);
  f.respond(() => ({ place: "store" }));
  await f.say("매장에서 먹을게");
  expect(
    f.requests.at(-1).cart.lines.map((line: any) => line.quantity),
  ).toEqual([31, 19, 50]);
  await expect(page.locator(".place-switch")).toHaveText("매장");
});

test("Long dialogue and growing usage never resize the kiosk at desktop and narrow widths", async ({
  page,
}) => {
  const f = await fixture(page);
  for (const width of [1360, 430]) {
    await page.setViewportSize({ width, height: 1040 });
    await page.waitForTimeout(900);
    const before = await page.locator(".kiosk-space").boundingBox();
    for (let turn = 0; turn < 8; turn++) {
      f.reportUsage({
        turn: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
        session: {
          input_tokens: 999999,
          output_tokens: 888888,
          total_tokens: 1888887,
          unreported_requests: turn % 2,
        },
        tts_session: {
          input_tokens: 999999,
          output_tokens: 999999,
          total_tokens: 1999998,
        },
      });
      await f.say(`긴 대화 ${width} ${turn}`);
    }
    await page.waitForTimeout(900);
    const after = await page.locator(".kiosk-space").boundingBox();
    expect(Math.abs(after!.width - before!.width)).toBeLessThan(1);
    expect(Math.abs(after!.height - before!.height)).toBeLessThan(1);
    await expect(page.locator(".companion-caption")).toBeInViewport();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
});

test("Even the last menu is centered within its viewport without shifting the kiosk", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const f = await fixture(page);
  const before = await page.locator(".kiosk-space").boundingBox();
  f.respond(() => ({
    guidance: guide("product", { product_id: "brown-coldbrew" }),
  }));
  await f.say("흑당 콜드브루 보여줘");
  await expect(page.locator(".agent-guide-ring")).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator('[data-guide="product"][data-guide-product="brown-coldbrew"]')
        .evaluate((node) => {
          const frame = node
              .closest(".catalog-scroll")!
              .getBoundingClientRect(),
            box = node.getBoundingClientRect();
          return Math.abs(box.y + box.height / 2 - frame.y - frame.height / 2);
        }),
    )
    .toBeLessThan(6);
  const after = await page.locator(".kiosk-space").boundingBox();
  expect(after!.width).toBeCloseTo(before!.width, 0);
  expect(after!.height).toBeCloseTo(before!.height, 0);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});
