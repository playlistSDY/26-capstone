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
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "How would you like",
  );
  await page
    .getByRole("button", { name: new RegExp(words["포장할게요"].en) })
    .click();
  await page
    .getByRole("button", { name: /Vanilla Latte.*4,500/, exact: false })
    .click();
  await page.getByRole("dialog").getByRole("button", { name: words["차갑게"].en, exact: false })
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
