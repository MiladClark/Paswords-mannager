import { test, expect } from "@playwright/test";

test("the popup distinguishes an unavailable bridge from a closed desktop app", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "chrome", {
      value: {
        storage: { local: { get: async () => ({ theme: "dark" }) } },
        runtime: {
          sendMessage: async ({ type }: { type: string }) => type === "state"
            ? { ok: true, data: { bridgeApi: 7, paired: false } }
            : { ok: false, error: location.search ? "browserOffline" : "browserUnavailable" },
        },
      },
    });
  });

  await page.goto("/browser-extension/popup.html");
  await expect(page.getByRole("heading", { name: "Desktop connection unavailable" })).toBeVisible();
  await expect(page.getByText(/Repair connection/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Launch PassWards" })).toHaveCount(0);
  await expect(page.locator("body")).toHaveCSS("border-top-left-radius", "14px");
  await expect(page.locator("#error")).toBeHidden();

  await page.goto("/browser-extension/popup.html?closed");
  await expect(page.getByRole("heading", { name: "PassWards is closed" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Launch PassWards" })).toBeVisible();
  await expect(page.locator("#error")).toBeHidden();
});
