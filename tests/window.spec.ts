import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
const permissions = JSON.parse(
  readFileSync(
    new URL("../src-tauri/capabilities/default.json", import.meta.url),
    "utf8",
  ),
).permissions;
async function boot(page: Page, unlocked: boolean) {
  // Native IPC is mocked before importing the real app. No database or OS window is opened.
  await page.route(/\/src\/main\.tsx(?:\?t=\d+)?$/, (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `
    import {mockIPC,mockWindows} from '/node_modules/@tauri-apps/api/mocks.js';
    import {emit} from '/node_modules/@tauri-apps/api/event.js';
    const permissions=${JSON.stringify(permissions)};
    globalThis.windowCloseProbe={calls:[],denied:[],destroyed:false};
    globalThis.isTauri=true;
    mockIPC(async command=>{
      const probe=globalThis.windowCloseProbe;
      if(command==='plugin:window|close') {probe.calls.push('close');await emit('tauri://close-requested');return;}
      if(command==='plugin:window|destroy') {if(!permissions.includes('core:window:allow-destroy')){probe.denied.push('destroy');return;}probe.calls.push('destroy');probe.destroyed=true;return;}
      if(command==='plugin:window|is_maximized')return false;
      if(command==='vault_status')return {exists:true,unlocked:${unlocked},idleSeconds:300,legacyPinRetired:false};
      if(command==='list_entries')return {items:[],total:0,allCount:0,favoriteCount:0,trashCount:0,folders:[]};
      if(command==='pending_browser_fill'||command==='pending_browser_save')return null;
      if(command==='touch_session')return;
      throw Error('Unexpected test IPC '+command);
    },{shouldMockEvents:true});
    mockWindows('main');
    await import('/src/main.tsx?native-window-probe=1');
  `,
    }),
  );
  await page.goto("/");
  await expect(
    page.getByRole("button", {
      name: unlocked ? "New item" : "Unlock vault",
      exact: true,
    }),
  ).toBeVisible();
}
for (const unlocked of [false, true]) {
  test(`native close lifecycle completes when vault is ${unlocked ? "open" : "locked"}`, async ({
    page,
  }) => {
    await boot(page, unlocked);
    await page
      .getByRole("button", { name: "Close window", exact: true })
      .click();
    await expect
      .poll(() => page.evaluate(() => (globalThis as any).windowCloseProbe))
      .toEqual({ calls: ["close", "destroy"], denied: [], destroyed: true });
  });
}
test("close respects cancel and discard for unsaved edits", async ({
  page,
}) => {
  await boot(page, true);
  await page.getByRole("button", { name: "New item", exact: true }).click();
  await page
    .getByLabel("Name", { exact: true })
    .fill("Unsaved window-close fixture");
  await page.getByRole("button", { name: "Close window", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
    "Unsaved window-close fixture",
  );
  expect(
    await page.evaluate(() => (globalThis as any).windowCloseProbe.calls),
  ).toEqual([]);
  const emitted = await page.evaluate(async () => {
    const { emit } = await import("/node_modules/@tauri-apps/api/event.js");
    await emit("tauri://close-requested");
    return true;
  });
  expect(emitted).toBe(true);
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => (globalThis as any).windowCloseProbe))
    .toEqual({ calls: ["close", "destroy"], denied: [], destroyed: true });
});
