import { test, expect } from "@playwright/test";
import { mockBackend } from "./backend-fixture";
import translations from "../src/ui-translations.json" with { type: "json" };
const words = translations as Record<string, Record<string, string>>;
test("The basic order flow switches languages without changing prices or a saved order", async ({
  page,
}) => {
  await mockBackend(page);
  await page.route("**/agent-api/**", (route) =>
    route.fulfill({ json: { ready: false, token: "test", message: "test" } }),
  );
  await page.goto("/?kiosk=1");
  const language = page.getByRole("combobox", {
    name: "Language / 언어",
    exact: true,
  });
  await language.selectOption("en");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    words["안녕하세요. 무엇을 드릴까요?"].en,
  );
  await page
    .getByRole("button", { name: new RegExp(words["포장할게요"].en) })
    .click();
  await expect(language).toHaveCSS("height", "38px");
  await expect(page.locator(".kiosk-header .language-globe")).toBeVisible();
  await page
    .getByRole("button", { name: /Vanilla Latte.*4,500/, exact: false })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: words["차갑게"].en, exact: false })
    .click();
  const add = page.locator('[data-guide="editor.add"]');
  if (await add.count()) await add.click();
  else await page.getByRole("button", { name: /4,500.*Add/ }).click();
  for (const locale of ["zh", "ja", "en"]) {
    await language.selectOption(locale);
    const line = page.locator(".dock-line");
    await expect(line).toContainText(words["바닐라라떼"][locale]);
    await expect(line).toContainText("4,500");
    await expect(
      page.getByRole("button", {
        name: words["결제하기"][locale],
        exact: true,
      }),
    ).toBeVisible();
  }
  await page.reload();
  await expect(language).toHaveValue("en");
  await expect(page.locator(".dock-line")).toContainText("Vanilla Latte");
  await page.getByRole("button", { name: "Pay", exact: true }).click();
  await page
    .getByRole("button", { name: "Confirm and pay", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: /Credit or debit card/ }),
  ).toBeVisible();
});

test("The agent receives a selected language and a spoken preference changes the UI", async ({
  page,
}) => {
  await mockBackend(page);
  const requests: any[] = [],
    events = new Map<string, any>();
  let hold = false;
  let release: (() => void) | undefined;
  await page.route("**/agent-api/**", async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname;
    if (path.endsWith("/status"))
      return route.fulfill({ json: { ready: true, token: "test" } });
    if (path.endsWith("/sessions"))
      return route.fulfill({ json: { session_id: "language-session" } });
    if (path.endsWith("/turns")) {
      const body = req.postDataJSON();
      requests.push(body);
      events.set(body.request_id, {
        type: "final",
        sequence: 1,
        text: "日本語でご案内します。",
        state: {
          language: "ja",
          phase: "ordering",
          view: "menu",
          place: null,
          lines: [],
          total: 0,
        },
      });
    }
    if (path.endsWith("/events")) {
      if (hold)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return route.fulfill({
        contentType: "application/x-ndjson",
        body: JSON.stringify(events.get(path.split("/").at(-2)!)) + "\n",
      });
    }
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "음성 끄기", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Language / 언어", exact: true })
    .selectOption("en");
  await page
    .getByRole("textbox", { name: "주문 메시지" })
    .fill("日本語でお願いします");
  await page
    .getByRole("button", { name: "메시지 보내기", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", { name: "Language / 언어", exact: true }),
  ).toHaveValue("ja");
  expect(requests[0].cart.ui_context.language).toBe("en");
  await expect(page.locator(".companion-caption")).toContainText("日本語");
  hold = true;
  await page.getByRole("textbox", { name: "주문 메시지" }).fill("ありがとう");
  await page
    .getByRole("button", { name: "메시지 보내기", exact: true })
    .click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1].cart.ui_context.language).toBe("ja");
  await page
    .getByRole("combobox", { name: "Language / 언어", exact: true })
    .selectOption("en");
  await expect.poll(() => !!release).toBe(true);
  release!();
  await expect(page.locator(".kiosk-companion .agent-avatar")).toHaveAttribute(
    "data-state",
    "ready",
  );
  await expect(
    page.getByRole("combobox", { name: "Language / 언어", exact: true }),
  ).toHaveValue("en");
});

test("Welcome branding and the language selector stay separate", async ({
  page,
}) => {
  await mockBackend(page);
  await page.route("**/agent-api/**", (route) =>
    route.fulfill({ json: { ready: false, token: "test" } }),
  );
  await page.setViewportSize({ width: 430, height: 960 });
  await page.goto("/?kiosk=1");
  const header = page.locator(".welcome-header");
  for (const language of ["ko", "en", "zh", "ja"]) {
    await page
      .getByRole("combobox", { name: "Language / 언어", exact: true })
      .selectOption(language);
    await expect(
      header.getByText(words["SWitch 커피"][language] ?? "SWitch 커피", {
        exact: true,
      }),
    ).toHaveCount(0);
    const geometry = await header.evaluate((node) => {
      const logo = node.querySelector(".brand")!.getBoundingClientRect();
      const selector = node
        .querySelector(".language-selector")!
        .getBoundingClientRect();
      const kiosk = node.closest<HTMLElement>(".kiosk")!;
      const scale = kiosk.getBoundingClientRect().width / kiosk.offsetWidth;
      return {
        gap: (selector.left - logo.right) / scale,
        fits: selector.right <= node.getBoundingClientRect().right,
      };
    });
    expect(geometry.gap).toBeGreaterThanOrEqual(23);
    expect(geometry.fits).toBe(true);
  }
});
