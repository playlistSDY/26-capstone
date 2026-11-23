import { test, expect, type Page } from "@playwright/test";
import { mockBackend } from "./backend-fixture";

async function fixture(page: Page, standalone = true, startAtHome = false) {
  const backend = await mockBackend(page, { autoPrint: true });
  const turns = new Map<string, Record<string, unknown>>();
  const requests: any[] = [];
  let ended = 0;
  let reportedTurns = 0;
  const interrupts: any[] = [];
  await page.route("**/agent-api/**", async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    let result: unknown = { ok: true };
    if (path.endsWith("/status"))
      result = {
        ready: true,
        token: "agent-test",
        message: "가상 주문 테스트",
      };
    else if (path.endsWith("/sessions"))
      result = { session_id: "demo-session" };
    else if (path.endsWith("/end")) ended++;
    else if (path.endsWith("/interrupt")) interrupts.push(req.postDataJSON());
    else if (path.endsWith("/turns")) {
      const p = req.postDataJSON();
      requests.push(p);
      const c = p.cart;
      const state: any = {
        phase: "ordering",
        view: "review",
        confirmation_pending: true,
        place: c.place,
        lines: c.lines.map((l: any) => ({ ...l, product_id: l.productId })),
        total: c.lines.reduce((n: number, l: any) => n + 3200 * l.quantity, 0),
      };
      let text = "아메리카노 한 잔, 총 3,200원이에요. 이대로 결제할까요?";
      if (p.text === "메뉴판 보여줘") {
        state.view = "menu";
        state.confirmation_pending = false;
        text = "메뉴판을 열었어요.";
      } else if (p.payment_event) {
        state.phase = c.receipt ? "completed" : "checkout";
        text = c.receipt
          ? `결제가 완료됐어요. 주문번호는 ${c.receipt.number}번이에요.`
          : "결제가 승인되지 않았어요. 다시 시도할까요?";
      } else if (["네", "ㅇㅇ", "그래", "맞아"].includes(p.text)) {
        state.phase = "checkout";
        state.view = "payment";
        state.confirmation_pending = false;
        text = "어떤 결제수단으로 하시겠어요?";
      } else if (p.text === "아 매장에서 먹고갈래") {
        state.place = "store";
        state.confirmation_pending = false;
        text = "매장으로 바꿨어요.";
      } else if (
        ["카드로 할게", "다시 해줘", "결제 취소해줘"].includes(p.text)
      ) {
        state.phase = "checkout";
        state.view = "payment";
        state.confirmation_pending = false;
        const kind =
          p.text === "다시 해줘"
            ? "retry"
            : p.text === "결제 취소해줘"
              ? "cancel"
              : "select";
        state.payment_action = {
          id: p.request_id,
          kind,
          method: kind === "cancel" ? null : "card",
          expected_attempt: c.payment?.attempt ?? null,
          total: 3200,
        };
        text =
          kind === "cancel"
            ? "결제를 취소했어요."
            : "카드를 리더기에 넣어 주세요.";
      }
      if (!p.payment_event) reportedTurns++;
      const turnTokens = p.payment_event ? 0 : 120;
      turns.set(p.request_id, {
        type: "final",
        sequence: 1,
        ok: true,
        text,
        state,
        usage: {
          turn: {
            input_tokens: turnTokens ? 100 : 0,
            output_tokens: turnTokens ? 20 : 0,
            total_tokens: turnTokens,
            estimated_cost_usd: turnTokens ? 0.0004 : 0,
          },
          session: {
            input_tokens: reportedTurns * 100,
            output_tokens: reportedTurns * 20,
            total_tokens: reportedTurns * 120,
            estimated_cost_usd: reportedTurns * 0.0004,
          },
        },
        needs_delivery: false,
        session_complete: !!c.receipt,
      });
      result = { ok: true, request_id: p.request_id };
    } else if (path.endsWith("/events")) {
      const id = path.split("/").at(-2)!;
      await route.fulfill({
        contentType: "application/x-ndjson",
        body: JSON.stringify(turns.get(id)) + "\n",
      });
      return;
    }
    await route.fulfill({ json: result });
  });
  await page.clock.install();
  await page.goto(standalone ? "/?kiosk=1" : "/");
  if (!startAtHome) {
    await page.getByRole("button", { name: /포장할게요/ }).click();
    await page
      .getByRole("button", { name: "아메리카노 3,200원", exact: true })
      .click();
    await page.getByRole("button", { name: /차갑게/ }).click();
    await page
      .getByRole("button", { name: "3,200원 담기", exact: true })
      .click();
  }
  await page.getByRole("button", { name: "음성 끄기", exact: true }).click();
  async function say(text: string) {
    await page.getByRole("textbox", { name: "주문 메시지" }).fill(text);
    await page
      .getByRole("button", { name: "메시지 보내기", exact: true })
      .click();
    await expect(page.locator(".agent-chat-thinking")).toHaveCount(0);
    await expect(
      page.getByRole("textbox", { name: "주문 메시지" }),
    ).toBeEnabled();
  }
  return { backend, requests, turns, interrupts, say, ended: () => ended };
}

test("Conversation opens review then method, waits for reader and finishes one order", async ({
  page,
}) => {
  const f = await fixture(page);
  await f.say("주문 다 한 것 같아");
  await expect(
    page.getByRole("button", { name: "확인하고 결제하기", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".cart-screen")).toContainText("아메리카노");
  await expect(page.locator(".payment-method")).toHaveCount(0);
  await f.say("네");
  await expect(page.locator(".payment-method")).toHaveCount(5);
  await f.say("카드로 할게");
  await expect(
    page.getByRole("heading", {
      name: "카드를 리더기에 넣어 주세요",
      exact: true,
    }),
  ).toBeVisible();
  expect(
    await page.evaluate(() =>
      JSON.parse(localStorage.getItem("switch.kiosk.orders.v1") || "[]"),
    ),
  ).toHaveLength(0);
  await page.clock.runFor(3100);
  await expect(
    page.getByRole("heading", { name: "카드를 읽고 있어요", exact: true }),
  ).toBeVisible();
  await page.clock.runFor(1700);
  await page.clock.runFor(1900);
  await page.clock.runFor(1100);
  await expect
    .poll(() => f.requests.some((p) => p.payment_event && p.cart.receipt))
    .toBe(true);
  await expect.poll(() => f.ended()).toBeGreaterThan(0);
  await expect(
    page.getByRole("heading", { name: "주문이 완료됐어요", exact: true }),
  ).toBeVisible();
  const orders = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("switch.kiosk.orders.v1") || "[]"),
  );
  expect(orders).toHaveLength(1);
  expect(orders[0].method).toBe("card");
  await expect.poll(() => f.backend.jobs.length).toBe(1);
  await expect(page.locator(".kiosk-companion")).toBeVisible();
  await expect(page.locator(".agent-chat-log")).toContainText("안녕하세요");
});

test("Failure is announced and conversation can retry and cancel without losing cart", async ({
  page,
}) => {
  const f = await fixture(page, false);
  await f.say("결제할래");
  await f.say("네");
  await page.getByLabel("결제 테스트 결과").selectOption("failure");
  await f.say("카드로 할게");
  await page.clock.runFor(3100);
  await page.clock.runFor(1700);
  await page.clock.runFor(1900);
  await expect
    .poll(() =>
      f.requests.some(
        (p) => p.payment_event && p.cart.payment?.status === "failure",
      ),
    )
    .toBe(true);
  await expect(page.locator(".agent-chat-log")).toContainText(
    "승인되지 않았어요",
  );
  const first = f.requests.find((p) => p.payment_event).cart.payment.attempt;
  await page.getByLabel("결제 테스트 결과").selectOption("timeout");
  await f.say("다시 해줘");
  await expect(
    page.getByRole("heading", {
      name: "카드를 리더기에 넣어 주세요",
      exact: true,
    }),
  ).toBeVisible();
  await f.say("결제 취소해줘");
  expect(f.requests.at(-1).cart.payment.attempt).not.toBe(first);
  await expect(page.locator(".payment-modal")).toHaveCount(0);
  await expect(page.locator(".payment-method")).toHaveCount(5);
  expect(f.requests.at(-1).cart.lines[0].productId).toBe("americano");
  await expect(page.locator(".kiosk-companion")).toBeVisible();
  expect(
    await page.evaluate(() =>
      JSON.parse(localStorage.getItem("switch.kiosk.orders.v1") || "[]"),
    ),
  ).toHaveLength(0);
});

test("The attendant stays inside the kiosk and test input stays outside it at every width", async ({
  page,
}) => {
  await fixture(page, false);
  for (const width of [1360, 1024, 820, 430, 320]) {
    await page.setViewportSize({ width, height: 1040 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect
      .poll(async () => {
        const kiosk = await page.locator(".kiosk-space").boundingBox();
        const chat = await page.locator(".kiosk-companion").boundingBox();
        const nav = await page.locator(".studio-bar").boundingBox();
        return (
          !!kiosk &&
          !!chat &&
          !!nav &&
          chat.x >= kiosk.x &&
          chat.y >= kiosk.y &&
          chat.x + chat.width <= kiosk.x + kiosk.width + 1 &&
          chat.y + chat.height <= kiosk.y + kiosk.height + 1 &&
          nav.y + nav.height <= chat.y &&
          chat.x + chat.width <= width + 1 &&
          nav.width <= width + 1
        );
      })
      .toBe(true);
  }
  await page.setViewportSize({ width: 1360, height: 1040 });
  await expect(page.locator("dialog:modal")).toHaveCount(0);
  await page.getByRole("button", { name: "결제하기", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "확인하고 결제하기", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".kiosk-companion")).toBeVisible();
});

test("Acknowledging a visible summary can interrupt its speech without losing consent", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.route("**/agent-api/sessions/*/speech", async (route) => {
    const pcm = Buffer.alloc(24000 * 2 * 8).toString("base64");
    await route.fulfill({
      contentType: "application/x-ndjson",
      body:
        JSON.stringify({ type: "audio.delta", pcm, sample_rate: 24000 }) +
        "\n" +
        JSON.stringify({ type: "audio.done" }) +
        "\n",
    });
  });
  await page.getByRole("button", { name: "음성 켜기", exact: true }).click();
  await f.say("결제할래");
  await expect(page.locator(".agent-chat-controls")).toContainText(
    "읽어드리는 중",
  );
  await page.getByRole("textbox", { name: "주문 메시지" }).fill("ㅇㅇ");
  await page
    .getByRole("button", { name: "끼어들어 메시지 보내기", exact: true })
    .click();
  await expect(page.locator(".payment-method")).toHaveCount(5);
  expect(f.interrupts.at(-1).reply_text).toBe("ㅇㅇ");
  expect(f.interrupts.at(-1).confirmation_visible).toBe(false);
  expect(f.interrupts.at(-1).request_id).toBe(f.requests[0].request_id);
});

test("A late interrupted response cannot overwrite a newer reply", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.addInitScript(() => {});
  await page.evaluate(() => {
    const original = window.fetch;
    let first = true;
    (window as any).fetch = async (...args: Parameters<typeof fetch>) => {
      const url = String(args[0]);
      if (url.includes("/events") && first) {
        first = false;
        return new Response(
          new ReadableStream({
            start(controller) {
              (window as any).oldAgentStream = controller;
              controller.enqueue(
                new TextEncoder().encode(
                  JSON.stringify({
                    type: "text.delta",
                    sequence: 1,
                    text: "이전 답변을 말하고 있어요. ",
                  }) + "\n",
                ),
              );
            },
          }),
          { headers: { "Content-Type": "application/x-ndjson" } },
        );
      }
      return original(...args);
    };
  });
  const input = page.getByRole("textbox", { name: "주문 메시지" });
  await input.fill("첫 요청");
  await page
    .getByRole("button", { name: "메시지 보내기", exact: true })
    .click();
  await expect(page.locator(".agent-chat-log")).toContainText(
    "이전 답변을 말하고",
  );
  await input.fill("네");
  await page
    .getByRole("button", { name: "끼어들어 메시지 보내기", exact: true })
    .click();
  await expect(page.locator(".payment-method")).toHaveCount(5);
  const old = f.turns.get(f.requests[0].request_id);
  await page.evaluate((event) => {
    const controller = (window as any).oldAgentStream;
    controller.enqueue(new TextEncoder().encode(JSON.stringify(event) + "\n"));
    controller.close();
  }, old);
  await expect(page.locator(".payment-method")).toHaveCount(5);
  await expect(
    page.locator(".agent-chat-message.assistant").last(),
  ).toContainText("결제수단");
  await expect(page.locator(".agent-chat-error")).toHaveCount(0);
});

test("Direct touch changes during an answer survive and are sent in the next turn", async ({
  page,
}) => {
  const f = await fixture(page);
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => (release = resolve));
  let slow = true;
  await page.route("**/agent-api/sessions/*/turns/*/events*", async (route) => {
    if (slow) {
      slow = false;
      await waiting;
    }
    const id = new URL(route.request().url()).pathname.split("/").at(-2)!;
    await route.fulfill({
      contentType: "application/x-ndjson",
      body: JSON.stringify(f.turns.get(id)) + "\n",
    });
  });
  const input = page.getByRole("textbox", { name: "주문 메시지" });
  await input.fill("현재 주문 알려줘");
  await page
    .getByRole("button", { name: "메시지 보내기", exact: true })
    .click();
  await expect(page.locator(".kiosk-companion .agent-avatar")).toHaveAttribute(
    "data-state",
    "thinking",
  );
  await page.getByRole("button", { name: "결제하기", exact: true }).click();
  await page
    .getByRole("button", { name: "아메리카노 수량 늘리기" })
    .first()
    .click();
  release();
  await expect(page.locator(".agent-chat-log")).toContainText(
    "화면에서 바꾸신 주문을 유지",
  );
  await f.say("지금 주문 알려줘");
  expect(f.requests.at(-1).cart.lines[0].quantity).toBe(2);
  expect(f.requests.at(-1).cart.screen).toBe("cart");
  expect(
    f.requests
      .at(-1)
      .cart.ui_context.events.some((e: any) => e.kind === "edit_item"),
  ).toBe(true);
});

test("Per-reply tokens and session totals are shown without counting UI events as model calls", async ({
  page,
}) => {
  const f = await fixture(page);
  await f.say("결제할래");
  await expect(page.locator(".agent-token-usage").last()).toContainText(
    "입력 100",
  );
  await expect(page.getByLabel("세션 토큰 사용량")).toContainText(
    "세션 대화 120",
  );
  await expect(page.locator(".agent-token-usage").last()).toContainText(
    "예상 $0.000400",
  );
  await expect(page.locator(".agent-token-usage").last()).toContainText(
    /응답 [\d,]+ ms/,
  );
  await f.say("네");
  await expect(page.getByLabel("세션 토큰 사용량")).toContainText(
    "세션 대화 240",
  );
});

test("A home recommendation immediately opens the menu before choosing dine-in or takeaway", async ({
  page,
}) => {
  const f = await fixture(page, true, true);
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => (release = resolve));
  let first = true;
  await page.route("**/agent-api/sessions/*/turns", async (route) => {
    const p = route.request().postDataJSON();
    f.requests.push(p);
    const place = p.text === "포장이요" ? "takeout" : p.cart.place;
    f.turns.set(p.request_id, {
      type: "final",
      sequence: 1,
      ok: true,
      text: place
        ? "포장으로 해 드릴게요."
        : "따뜻한 카라멜마끼아또를 추천해요.",
      state: {
        phase: "ordering",
        view: "menu",
        place,
        lines: p.cart.lines.map((l: any) => ({
          ...l,
          product_id: l.productId,
        })),
        total: 0,
      },
    });
    await route.fulfill({ json: { ok: true, request_id: p.request_id } });
  });
  await page.route("**/agent-api/sessions/*/turns/*/events*", async (route) => {
    if (first) {
      first = false;
      await waiting;
    }
    const id = new URL(route.request().url()).pathname.split("/").at(-2)!;
    await route.fulfill({
      contentType: "application/x-ndjson",
      body: JSON.stringify(f.turns.get(id)) + "\n",
    });
  });
  const input = page.getByRole("textbox", { name: "주문 메시지" });
  await input.fill("달달한 뜨거운 커피 추천해줘");
  await page
    .getByRole("button", { name: "메시지 보내기", exact: true })
    .click();
  await expect(page.locator(".product-card").first()).toBeVisible();
  await expect(page.locator(".home-screen")).toHaveCount(0);
  await expect(page.locator(".place-switch")).toHaveText("매장·포장 선택");
  await expect.poll(() => f.requests.length).toBe(1);
  expect(f.requests[0].cart.place).toBe(null);
  expect(f.requests[0].cart.screen).toBe("menu");
  release();
  await expect(page.locator(".agent-chat-thinking")).toHaveCount(0);
  await f.say("그걸로 줘");
  expect(f.requests[1].cart.place).toBe(null);
  await expect(page.locator(".product-card").first()).toBeVisible();
  await f.say("포장이요");
  await expect(page.locator(".place-switch")).toHaveText("포장");
  await expect(page.locator(".home-screen")).toHaveCount(0);
});

test("Manual checkout asks for an unchosen order type without losing items", async ({
  page,
}) => {
  const f = await fixture(page, true, true);
  await f.say("메뉴판 보여줘");
  await expect(page.locator(".product-card").first()).toBeVisible();
  await page
    .getByRole("button", { name: "아메리카노 3,200원", exact: true })
    .click();
  await page.getByRole("button", { name: /차갑게/ }).click();
  await page.getByRole("button", { name: "3,200원 담기", exact: true }).click();
  await page.getByRole("button", { name: "결제하기", exact: true }).click();
  await page
    .getByRole("button", { name: "확인하고 결제하기", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "어디서 즐기실 건가요?" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "포장", exact: true }).click();
  await expect(page.locator(".payment-method")).toHaveCount(5);
  await expect(page.locator(".payment-total")).toContainText("3,200원");
});

test("Order-type correction and agreement advance even if speech fails and no ACK arrives", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.route("**/agent-api/sessions/*/speech", (route) =>
    route.fulfill({ status: 503, json: { error: "Speech unavailable" } }),
  );
  await page.getByRole("button", { name: "음성 켜기", exact: true }).click();
  await f.say("이대로 결제해줘");
  await expect(
    page.getByRole("button", { name: "확인하고 결제하기", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".agent-chat-error")).toBeVisible();
  await f.say("아 매장에서 먹고갈래");
  await expect(page.locator(".place-switch")).toHaveText("매장");
  await f.say("그래");
  await expect(page.locator(".payment-method")).toHaveCount(5);
  await expect(page.locator(".agent-chat-log")).not.toContainText(
    "주문 내용을 다시 확인해",
  );
  expect(f.requests.at(-1).cart.place).toBe("store");
  await f.say("카드로 할게");
  await page.clock.runFor(3100);
  await page.clock.runFor(1700);
  await page.clock.runFor(1900);
  await page.clock.runFor(1100);
  await expect.poll(() => f.ended()).toBeGreaterThan(0);
  await expect(page.locator(".agent-chat-log")).toContainText("안녕하세요");
});
