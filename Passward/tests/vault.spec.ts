import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// Only fictional, ephemeral preview data is used. Real desktop vaults are not opened.
async function enter(page: Page, suffix = "") {
  await page.goto("/?preview=1" + suffix);
  await page
    .getByLabel("Master password", { exact: true })
    .fill("A fictional test passphrase");
  await page
    .getByLabel("Confirm master password", { exact: true })
    .fill("A fictional test passphrase");
  await page.getByRole("button", { name: "Create vault", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Personal email", exact: true }),
  ).toBeVisible();
}

test("create form catches mismatch; locking removes visible vault state", async ({
  page,
}) => {
  await page.goto("/?preview=1");
  await page
    .getByLabel("Master password", { exact: true })
    .fill("A fictional test passphrase");
  await page
    .getByLabel("Confirm master password", { exact: true })
    .fill("Different test passphrase");
  await page.getByRole("button", { name: "Create vault", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "The passwords don’t match.",
  );
  await page
    .getByLabel("Confirm master password", { exact: true })
    .fill("A fictional test passphrase");
  await page.getByRole("button", { name: "Create vault", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Personal email", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Show password", exact: true })
    .click();
  await expect(page.locator(".password-value").first()).toContainText(
    "Preview-password-only-123!",
  );
  await page.getByRole("button", { name: "Lock vault", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Unlock vault", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Preview-password-only-123!", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("Personal email", { exact: true })).toHaveCount(
    0,
  );
});

test("browser pairing code and desktop approval are accessible", async ({
  page,
}) => {
  await enter(page, "&browser-request=1");
  const dialog = page.getByRole("dialog", {
    name: "Fill a login",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText("https://mail.example.test", { exact: true }),
  ).toBeVisible();
  expect(
    (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze())
      .violations,
  ).toEqual([]);
  await dialog
    .getByLabel("Master password", { exact: true })
    .fill("Wrong fictional passphrase");
  await dialog
    .getByRole("button", { name: "Approve fill", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await dialog
    .getByLabel("Master password", { exact: true })
    .fill("A fictional test passphrase");
  await dialog
    .getByRole("button", { name: "Approve fill", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Pair browser", exact: true }).click();
  await expect(page.getByText("482916", { exact: true })).toBeVisible();
  expect(
    (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze())
      .violations,
  ).toEqual([]);
  await page.screenshot({ path: "artifacts/desktop-browser-pairing.png" });
});

test("add, generate, edit, search, favorite, trash, restore and delete", async ({
  page,
}) => {
  await enter(page);
  await page.getByRole("button", { name: "New item", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("My test login");
  await page
    .getByLabel("Username or email", { exact: true })
    .fill("fixture@example.test");
  await page
    .getByRole("button", { name: "Generate password", exact: true })
    .click();
  await expect(page.locator(".generated-password code")).toHaveText(/.{24}/);
  await page
    .getByRole("button", { name: "Use this password", exact: true })
    .click();
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue(
    /.{24}/,
  );
  await page
    .getByLabel("Website", { exact: true })
    .fill("https://example.test");
  await page.getByLabel("Folder", { exact: true }).last().fill("Testing");
  await page.getByLabel("Notes", { exact: true }).fill("Fictional notes only");
  await page
    .getByRole("button", { name: "Add a custom field", exact: true })
    .click();
  await page.getByLabel("Field name", { exact: true }).fill("Recovery hint");
  await page.getByLabel("Value", { exact: true }).fill("Fixture value");
  await page.getByRole("button", { name: "Save item", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "My test login", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Fictional notes only", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Add to favorites", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Remove from favorites", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page
    .getByLabel("Password", { exact: true })
    .fill("A-changed-fictional-password!");
  await page.getByRole("button", { name: "Save item", exact: true }).click();
  await expect(page.locator(".history summary")).toContainText(
    "Previous passwords",
  );
  await page
    .getByRole("textbox", { name: "Search your vault…", exact: true })
    .fill("no-such-fixture");
  await expect(
    page.getByRole("heading", {
      name: "Nothing matches that search.",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "Search your vault…", exact: true })
    .fill("");
  await expect(page.locator(".entry-row")).toHaveCount(4);
  await page
    .getByRole("button", { name: "Move to trash", exact: true })
    .click();
  await expect(page.locator(".entry-row")).toHaveCount(3);
  await page.getByRole("button", { name: /^Trash/ }).click();
  await expect(
    page.getByRole("heading", { name: "My test login", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Restore item", exact: true }).click();
  await page.getByRole("button", { name: /^All items/ }).click();
  await page.getByRole("button", { name: /My test login fixture/ }).click();
  await page
    .getByRole("button", { name: "Move to trash", exact: true })
    .click();
  await page.getByRole("button", { name: /^Trash/ }).click();
  await expect(
    page.getByRole("heading", { name: "My test login", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Delete permanently", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete permanently", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Nothing in the trash.", exact: true }),
  ).toBeVisible();
});

test("unsaved edits need an explicit discard; keyboard save works", async ({
  page,
}) => {
  await enter(page);
  await page.keyboard.press("Control+n");
  await page.getByLabel("Name", { exact: true }).fill("Unsaved fixture");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
    "Unsaved fixture",
  );
  await page.keyboard.press("Control+s");
  await expect(
    page.getByRole("heading", { name: "Unsaved fixture", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Settings", exact: true }),
  ).toBeFocused();
});

for (const colorScheme of ["dark", "light"] as const) {
  test(`bilingual layout and accessibility at desktop and narrow widths: ${colorScheme}`, async ({
    page,
  }, testInfo) => {
    await page.emulateMedia({ colorScheme });
    const errors: string[] = [];
    const requests: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (
        !request.url().startsWith("http://127.0.0.1:1420") &&
        !request.url().startsWith("ws://127.0.0.1:1420")
      )
        requests.push(request.url());
    });
    await enter(page);
    for (const language of ["en", "fa"] as const) {
      if (language === "fa")
        await page
          .getByRole("button", { name: "Language", exact: true })
          .click();
      await expect(page.locator("html")).toHaveAttribute(
        "dir",
        language === "fa" ? "rtl" : "ltr",
      );
      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa"])
        .analyze();
      await testInfo.attach(`axe-${language}-${colorScheme}`, {
        body: JSON.stringify(results.violations, null, 2),
        contentType: "application/json",
      });
      expect(results.violations).toEqual([]);
      await page.screenshot({
        path: `artifacts/nook-${language}-${colorScheme}-900.png`,
      });
      for (const width of [680, 360]) {
        await page.setViewportSize({
          width,
          height: width === 360 ? 740 : 640,
        });
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        ).toBe(true);
        const overflow = await page
          .locator(".app")
          .evaluate((el) => el.scrollWidth > el.clientWidth);
        expect(overflow).toBe(false);
        await page.screenshot({
          path: `artifacts/nook-${language}-${colorScheme}-${width}.png`,
        });
      }
      await page.setViewportSize({ width: 900, height: 640 });
    }
    expect(errors).toEqual([]);
    expect(requests).toEqual([]);
    const stored = await page.evaluate(() =>
      Object.fromEntries(Object.entries(localStorage)),
    );
    expect(stored).toEqual({ "nook.language": "fa" });
  });
}

test.describe("touch layout", () => {
  test.use({
    viewport: { width: 360, height: 800 },
    hasTouch: true,
    isMobile: true,
    colorScheme: "dark",
    reducedMotion: "reduce",
  });
  test("controls have real non-overlapping hit targets", async ({ page }) => {
    await enter(page);
    const boxes = await page
      .locator(".icon-button:visible")
      .evaluateAll((buttons) =>
        buttons.map((button) => {
          const r = button.getBoundingClientRect();
          return {
            label: button.getAttribute("aria-label"),
            width: r.width,
            height: r.height,
            left: r.left,
            right: r.right,
            top: r.top,
            bottom: r.bottom,
          };
        }),
      );
    for (const box of boxes) {
      expect(box.width).toBeGreaterThanOrEqual(48);
      expect(box.height).toBeGreaterThanOrEqual(48);
    }
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i],
          b = boxes[j];
        expect(
          a.left < b.right &&
            b.left < a.right &&
            a.top < b.bottom &&
            b.top < a.bottom,
        ).toBe(false);
      }
    expect(
      await page
        .locator(".app")
        .evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    await page.screenshot({ path: "artifacts/nook-touch-360.png" });
  });
});

async function enablePin(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Set up PIN", exact: true }).click();
  await page
    .getByLabel("Current master password", { exact: true })
    .fill("A fictional test passphrase");
  await page.getByLabel("PIN", { exact: true }).fill("۷۲۹۴");
  await page.getByLabel("Confirm PIN", { exact: true }).fill("7294");
  await page.getByRole("button", { name: "Save PIN", exact: true }).click();
  await expect(
    page
      .getByRole("dialog")
      .getByRole("button", { name: "Change PIN", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close / بستن", exact: true }).click();
  await expect(page.locator(".item-lock-notice")).toBeVisible();
}
test("four-digit PIN gates item details, app unlock, copy, and removal", async ({
  page,
}) => {
  await enter(page);
  await enablePin(page);
  await expect(
    page.getByText("Preview-password-only-123!", { exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Show password", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByLabel("PIN", { exact: true })
    .fill("0000");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Unlock item", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("Incorrect PIN");
  await page
    .getByRole("dialog")
    .getByLabel("PIN", { exact: true })
    .fill("7294");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Unlock item", exact: true })
    .click();
  await expect(page.locator(".password-value").first()).toContainText(
    "Preview-password-only-123!",
  );
  await page.getByRole("button", { name: "Lock item", exact: true }).click();
  await expect(page.locator(".item-lock-notice")).toBeVisible();
  await page.getByRole("button", { name: "Lock vault", exact: true }).click();
  await page.getByLabel("PIN", { exact: true }).fill("7294");
  await page.getByRole("button", { name: "Unlock vault", exact: true }).click();
  await expect(page.locator(".item-lock-notice")).toBeVisible();
  await page
    .getByRole("button", { name: "Copy password", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Master password", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByLabel("Master password", { exact: true })
    .fill("A fictional test passphrase");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Unlock item", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("Copied");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Remove PIN", exact: true }).click();
  await page
    .getByLabel("Current master password", { exact: true })
    .fill("A fictional test passphrase");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Remove PIN", exact: true })
    .click();
  await expect(
    page
      .getByRole("dialog")
      .getByRole("button", { name: "Set up PIN", exact: true }),
  ).toBeVisible();
});
test("expired item access reauthenticates without losing edits; theme persists", async ({
  page,
}) => {
  await enter(page);
  await enablePin(page);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByLabel("PIN", { exact: true })
    .fill("7294");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Unlock item", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Notes", exact: true })
    .fill("Keep this draft after reauthentication.");
  await page.clock.install();
  await page.clock.fastForward(61_000);
  await page.getByRole("button", { name: "Save item", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page
    .getByRole("dialog")
    .getByLabel("PIN", { exact: true })
    .fill("7294");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Unlock item", exact: true })
    .click();
  await expect(
    page.getByText("Keep this draft after reauthentication.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Light theme", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(
    await page.evaluate(() => localStorage.getItem("passward.theme")),
  ).toBe("light");
});
