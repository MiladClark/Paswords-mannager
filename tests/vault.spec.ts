import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

// Only fictional, ephemeral preview data is used. Real desktop vaults are not opened.
async function enter(page: Page, suffix = "") {
  await page.goto("/?preview=1" + suffix);
  await expect(page.locator(".devtune-splash")).toHaveCount(0);
  await page.getByRole("button", { name: "Create a local vault", exact: true }).click();
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

test("master password setup has borderless back navigation and preserves its draft", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/?preview=1");
  const create = page.getByRole("button", { name: "Create a local vault" });
  await expect(page.getByRole("heading", { name: "Set up PassWards" })).toBeFocused();
  await create.click();
  await expect(page.getByRole("heading", { name: "Set your master password" })).toBeFocused();
  await expect(page.locator(".auth-stage")).toHaveCSS("animation-name", "auth-step-enter");
  const master = page.getByLabel("Master password", { exact: true });
  await master.fill("A fictional test passphrase");
  await expect(page.locator('input[type="email"]')).toHaveCount(0);
  const back = page.getByRole("button", { name: "Back to setup" });
  await expect(back).toHaveCSS("border-bottom-width", "0px");
  await expect(back).toHaveCSS("border-top-width", "0px");
  await back.click();
  await expect(page.getByRole("heading", { name: "Set up PassWards" })).toBeFocused();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await create.click();
  await expect(page.locator(".auth-stage")).toHaveCSS("animation-name", "none");
  await expect(master).toHaveValue("A fictional test passphrase");
});

test("create form catches mismatch; locking removes visible vault state", async ({
  page,
}) => {
  await page.goto("/?preview=1");
  await expect(page.locator(".devtune-splash")).toHaveCount(0);
  await page.getByRole("button", { name: "Create a local vault", exact: true }).click();
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
  await page.getByRole("button", { name: "Browsers", exact: true }).click();
  await page.getByRole("button", { name: "Pair browser", exact: true }).click();
  await expect(page.getByText("482916", { exact: true })).toBeVisible();
  expect(
    (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze())
      .violations,
  ).toEqual([]);
  await page.screenshot({ path: "artifacts/desktop-browser-pairing.png" });
});

test("add, edit, search, favorite and permanently delete with a master password and a temporary skip option", async ({
  page,
}) => {
  await enter(page);
  await page.getByRole("button", { name: "New item", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("My test login");
  await page
    .getByLabel("Username or email", { exact: true })
    .fill("fixture@example.test");
  await page
    .getByLabel("Password", { exact: true })
    .fill("A-fictional-test-password!");
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
  await expect(page.getByRole("button", { name: /^Trash/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Delete item", exact: true }).click();
  const deletion = page.getByRole("dialog");
  const remove = deletion.getByRole("button", { name: "Delete item", exact: true });
  const master = deletion.getByLabel("Master password", { exact: true });
  await expect(master).toBeFocused();
  await expect(remove).toBeDisabled();
  await deletion.getByRole("switch", { name: "Don’t ask again" }).check();
  await master.fill("incorrect master");
  await remove.click();
  await expect(deletion.getByRole("alert")).toBeVisible();
  await expect(page.locator(".entry-row")).toHaveCount(4);
  await deletion.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Delete item", exact: true }).click();
  await expect(deletion.getByRole("switch", { name: "Don’t ask again" })).not.toBeChecked();
  await deletion.getByRole("switch", { name: "Don’t ask again" }).check();
  await master.fill("A fictional test passphrase");
  await remove.click();
  await expect(deletion).toHaveCount(0);
  await expect(page.locator(".entry-row")).toHaveCount(3);
  await expect(page.getByRole("status")).toContainText("Item permanently deleted");

  await page.locator(".entry-row").first().click();
  await page.getByRole("button", { name: "Delete item", exact: true }).click();
  await expect(page.locator(".entry-row")).toHaveCount(2);
  await expect(deletion).toHaveCount(0);
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
  await expect(page.getByRole("status")).toContainText("Item saved");
  await expect(
    page.getByRole("heading", { name: "Unsaved fixture", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Save item", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeFocused();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "New item", exact: true })).toHaveCount(0);
  await page.keyboard.press("Control+n");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "Unsaved fixture", exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Settings", exact: true }),
  ).toBeFocused();
});

for (const colorScheme of ["dark", "light"] as const) {
  test(`English layout and accessibility at desktop and narrow widths: ${colorScheme}`, async ({
    page,
    baseURL,
  }, testInfo) => {
    await page.emulateMedia({ colorScheme });
    const errors: string[] = [];
    const requests: string[] = [];
    const origin = new URL(baseURL!).origin;
    const ownOrigins = [origin, origin.replace(/^http/, "ws")];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (!ownOrigins.includes(new URL(request.url()).origin))
        requests.push(request.url());
    });
    await enter(page);
    for (const language of ["en"] as const) {
      await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
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
    expect(stored).toEqual({
      "nook.language": "en",
    });
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

test("Persian stays disabled even with a saved preference, and no PIN UI remains", async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem("nook.language", "fa"));
  await enter(page);
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(
    page.getByRole("button", { name: "Language", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Show password", exact: true })
    .click();
  await expect(page.locator(".password-value").first()).toContainText(
    "Preview-password-only-123!",
  );
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Set up PIN", exact: true }),
  ).toHaveCount(0);
  const backup = page.getByRole("switch", {
    name: "Keep automatic encrypted backups on this device",
    exact: true,
  });
  await expect(backup).not.toBeChecked();
  await backup.check();
  await expect(backup).toBeChecked();
  await backup.uncheck();
  await page.getByRole("button", { name: "Back to vault", exact: true }).click();
  await page.getByRole("button", { name: "Lock vault", exact: true }).click();
  await expect(page.getByLabel("PIN", { exact: true })).toHaveCount(0);
  await expect(
    page.getByLabel("Master password", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".password-value")).toHaveCount(0);
});

test("signing out returns to setup and a newly created vault contains no old items", async ({ page }) => {
  await enter(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Security", exact: true }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Master password", { exact: true })).toBeFocused();
  await dialog.getByLabel("Master password", { exact: true }).fill("A fictional test passphrase");
  await dialog.getByRole("button", { name: "Erase data and sign out" }).click();
  await expect(page.getByRole("heading", { name: "Set up PassWards" })).toBeVisible();
  await page.getByRole("button", { name: "Create a local vault", exact: true }).click();
  const fresh = "A different fictional passphrase";
  await page.getByLabel("Master password", { exact: true }).fill(fresh);
  await page.getByLabel("Confirm master password", { exact: true }).fill(fresh);
  await page.getByRole("button", { name: "Create vault", exact: true }).click();
  await expect(page.getByRole("button", { name: "New item", exact: true })).toBeVisible();
  await expect(page.getByText("Personal email", { exact: true })).toHaveCount(0);
  await expect(page.locator(".entry-row")).toHaveCount(0);
});

test("filter menus support keyboard selection, dismissal and narrow layouts", async ({
  page,
}) => {
  await enter(page);
  const sort = page.getByRole("combobox", { name: "Sort items", exact: true });
  await sort.press("Enter");
  await expect(
    page.getByRole("option", { name: "Recently updated", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  expect(
    (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze())
      .violations,
  ).toEqual([]);
  await sort.press("End");
  await sort.press("Enter");
  await expect(sort).toContainText("A to Z");
  await expect(page.locator(".entry-row").first()).toContainText(
    "Design workspace",
  );
  await expect(sort).toBeFocused();
  await sort.click();
  await sort.press("Escape");
  await expect(sort).toHaveAttribute("aria-expanded", "false");
  await sort.click();
  await page.getByRole("textbox", { name: "Search your vault…" }).click();
  await expect(sort).toHaveAttribute("aria-expanded", "false");
  const folder = page.getByRole("combobox", { name: "Folder", exact: true });
  await folder.press("w");
  await folder.press("Enter");
  await expect(folder).toContainText("Work");
  await expect(page.locator(".entry-row")).toHaveCount(1);
  await expect(page.locator(".entry-row")).toContainText("Design workspace");
  await page.setViewportSize({ width: 360, height: 740 });
  await page
    .getByRole("button", { name: "Back to items", exact: true })
    .click();
  await folder.click();
  const menu = page.getByRole("listbox", { name: "Folder", exact: true });
  const box = await menu.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(12);
  expect(box!.x + box!.width).toBeLessThanOrEqual(348);
  expect(box!.y + box!.height).toBeLessThanOrEqual(740);
  await page.getByRole("option", { name: "All folders", exact: true }).click();
  await expect(page.locator(".entry-row")).toHaveCount(3);
  await page.setViewportSize({ width: 900, height: 640 });
  const gap = await page
    .locator(".entry-row")
    .evaluateAll(
      (rows) =>
        rows[1].getBoundingClientRect().top -
        rows[0].getBoundingClientRect().bottom,
    );
  expect(gap).toBe(3);
});

test("motion animates dialog exits without delaying a security lock", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await enter(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const changeMaster = page.getByRole("button", { name: "Change master password", exact: true });
  await page.getByRole("button", { name: "Security", exact: true }).click();
  await changeMaster.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  expect(
    await dialog.evaluate(
      (element) => getComputedStyle(element).animationDuration,
    ),
  ).toBe("0.22s");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.locator("dialog[data-exiting]")).toHaveAttribute(
    "inert",
    "",
  );
  await expect(page.locator("dialog")).toHaveCount(0);
  await expect(changeMaster).toBeFocused();
  await changeMaster.click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Control+Shift+L");
  await expect(
    page.getByRole("button", { name: "Unlock vault", exact: true }),
  ).toBeVisible();
  await expect(page.locator("dialog")).toHaveCount(0);
  await expect(page.getByText("Personal email", { exact: true })).toHaveCount(
    0,
  );
});

test("reduced motion skips animations for menus and detail transitions", async ({
  page,
}) => {
  await enter(page);
  await page.getByRole("combobox", { name: "Sort items", exact: true }).click();
  expect(
    await page
      .getByRole("listbox")
      .evaluate((element) => getComputedStyle(element).animationName),
  ).toBe("none");
  await page
    .getByRole("combobox", { name: "Sort items", exact: true })
    .press("Escape");
  await page
    .getByRole("button", {
      name: "Design workspace alex@studio.example.test",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("heading", { name: "Design workspace", exact: true }),
  ).toBeVisible();
  expect(
    await page
      .locator(".entry-detail")
      .evaluate((element) => getComputedStyle(element).animationName),
  ).toBe("none");
});

for (const kind of ["new", "update"] as const) {
  test(`browser ${kind} approval ${kind === "new" ? "saves without master re-entry" : "requires the master password"}`, async ({
    page,
  }) => {
    await enter(page, `&browser-save=${kind}`);
    const dialog = page.getByRole("dialog", {
      name:
        kind === "new"
          ? "Save a login from your browser?"
          : "Update a saved password?",
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
    const master = dialog.getByLabel("Master password", { exact: true });
    if (kind === "new") {
      await expect(master).toHaveCount(0);
      await dialog
        .getByLabel("Name", { exact: true })
        .fill("Saved from browser");
    } else {
      await master.fill("Wrong fictional master");
      await dialog
        .getByRole("button", { name: "Update password", exact: true })
        .click();
      await expect(dialog.getByRole("alert")).toBeVisible();
      await expect(page.locator(".entry-row")).toHaveCount(3);
      await master.fill("A fictional test passphrase");
    }
    await dialog
      .getByRole("button", {
        name: kind === "new" ? "Save login" : "Update password",
        exact: true,
      })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(
      page.getByRole("heading", {
        name: kind === "new" ? "Saved from browser" : "Personal email",
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.locator(".entry-row")).toHaveCount(
      kind === "new" ? 4 : 3,
    );
    await page
      .getByRole("button", { name: "Show password", exact: true })
      .click();
    await expect(page.locator(".password-value").first()).toContainText(
      "Fictional-captured-password-901!",
    );
    if (kind === "update") {
      await expect(page.locator(".history summary")).toContainText(
        "Previous passwords",
      );
      await expect(
        page.getByText(
          "These are fictional design samples. Your desktop vault starts empty.",
          { exact: true },
        ),
      ).toBeVisible();
    }
  });
}

test("declining a browser save does not add an account", async ({ page }) => {
  await enter(page, "&browser-save=new");
  const dialog = page.getByRole("dialog", {
    name: "Save a login from your browser?",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".entry-row")).toHaveCount(3);
});

test("cloud connection returns to the vault; sync asks first and adds cloud items once", async ({ page }) => {
  await enter(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("main", { name: "Settings", exact: true })).toHaveCount(0);
  await expect(page.locator(".entry-row")).toHaveCount(3);
  await expect(page.getByRole("button", { name: "Sync with DevTune", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Sync", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Merge cloud backup?", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Back to vault", exact: true }).click();
  await expect(page.locator(".entry-row")).toHaveCount(3);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Sync", exact: true }).click();
  await dialog.getByRole("button", { name: "Merge and sync", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("main", { name: "Settings", exact: true })).toHaveCount(0);
  await expect(page.locator(".entry-row")).toHaveCount(4);
  await expect(page.locator(".entry-row").filter({ hasText: "Home computer login" })).toHaveCount(1);
  await page.getByRole("button", { name: "Sync with DevTune", exact: true }).click();
  await dialog.getByRole("button", { name: "Merge and sync", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".entry-row")).toHaveCount(4);
});

test("browser save arriving in settings opens the vault and selects the saved item", async ({ page }) => {
  await enter(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.evaluate(() => history.replaceState(null, "", "?preview=1&browser-save=new"));
  const dialog = page.getByRole("dialog", { name: "Save a login from your browser?", exact: true });
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("main", { name: "Settings", exact: true })).toHaveCount(0);
  await dialog.getByLabel("Name", { exact: true }).fill("Login received in settings");
  await dialog.getByRole("button", { name: "Save login", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Login received in settings", exact: true })).toBeVisible();
});

test("settings layout adapts and browsers only shows extension setup", async ({ page }) => {
  await enter(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  for (const width of [900, 680, 360]) {
    await page.setViewportSize({ width, height: 740 });
    const settings = page.getByRole("main", { name: "Settings", exact: true });
    expect(await settings.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: `artifacts/settings-sync-${width}.png` });
  }
  await page.setViewportSize({ width: 900, height: 740 });
  await page.getByRole("button", { name: "Browsers", exact: true }).click();
  await expect(page.getByRole("switch")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open connected browser", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Pair browser", exact: true })).toBeVisible();
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
  await page.screenshot({ path: "artifacts/settings-browsers-900.png" });
});

test("saved site icons render locally with fallbacks for missing or invalid images", async ({
  page,
  baseURL,
}) => {
  const remote: string[] = [];
  const origin = new URL(baseURL!).origin;
  const ownOrigins = [origin, origin.replace(/^http/, "ws")];
  page.on("request", (request) => {
    if (
      !ownOrigins.includes(new URL(request.url()).origin) &&
      !request.url().startsWith("data:")
    )
      remote.push(request.url());
  });
  await enter(page, "&favicon=1");
  const icon = page.locator(".entry-row .monogram img");
  await expect(icon).toHaveCount(1);
  await expect
    .poll(() => icon.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBe(32);
  await expect(page.locator(".entry-detail .monogram img")).toHaveCount(1);
  await expect(
    page
      .locator(".entry-row")
      .filter({ hasText: "Design workspace" })
      .locator(".monogram"),
  ).toHaveText("D");
  await expect(
    page
      .locator(".entry-row")
      .filter({ hasText: "Reading list" })
      .locator(".monogram"),
  ).toHaveText("R");
  expect(remote).toEqual([]);
  await page.screenshot({ path: "artifacts/site-favicons.png" });
});
