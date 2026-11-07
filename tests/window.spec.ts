import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";

type ProbeWindow = typeof globalThis & {
  accountProbe: string[];
  updateProbe: string[];
  windowCloseProbe: { calls: string[]; denied: string[]; destroyed: boolean };
};
const permissions = JSON.parse(
  readFileSync(
    new URL("../src-tauri/capabilities/default.json", import.meta.url),
    "utf8",
  ),
).permissions;
async function boot(page: Page, unlocked: boolean, updateMode?: "installed" | "portable", backups?: "empty" | "saved") {
  // Native IPC is mocked before importing the real app. No database or OS window is opened.
  await page.route(/\/src\/main\.tsx(?:\?t=\d+)?$/, (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `
    import {mockIPC,mockWindows} from '/node_modules/@tauri-apps/api/mocks.js';
    import {emit} from '/node_modules/@tauri-apps/api/event.js';
    const permissions=${JSON.stringify(permissions)};
    globalThis.windowCloseProbe={calls:[],denied:[],destroyed:false};
    globalThis.accountProbe=[];
    globalThis.updateProbe=[];
    let finishTransfer;
    let transfers=0;
    let vaultExists=${!backups};
    let vaultUnlocked=${unlocked};
    let cloud={email:'first@example.test',enabled:true,lastBackup:null,issue:null};
    globalThis.isTauri=true;
    mockIPC(async (command,args)=>{
      const probe=globalThis.windowCloseProbe;
      if(command==='plugin:window|close') {probe.calls.push('close');await emit('tauri://close-requested');return;}
      if(command==='plugin:window|destroy') {if(!permissions.includes('core:window:allow-destroy')){probe.denied.push('destroy');return;}probe.calls.push('destroy');probe.destroyed=true;return;}
      if(command==='plugin:window|is_maximized')return false;
      if(command==='vault_status')return {exists:vaultExists,unlocked:vaultUnlocked,idleSeconds:300,legacyPinRetired:false};
      if(command==='list_entries')return {items:[],total:0,allCount:0,favoriteCount:0,trashCount:0,folders:[]};
      if(command==='pending_browser_fill'||command==='pending_browser_save')return null;
      if(command==='touch_session')return;
      if(command==='browser_connections')return {available:false,connections:[]};
      if(command==='automatic_backup_info')return {enabled:false,lastCreated:0,retained:0};
      if(command==='cloud_info')return cloud;
      if(command==='update_check')return {version:${updateMode ? "'0.4.0'" : "null"},mode:${JSON.stringify(updateMode ?? "manual")}};
      if(command==='update_download') {
        globalThis.updateProbe.push(command);
        args.progress.onmessage({received:500,total:1000,verifying:false});
        if (++transfers === 1) return new Promise(resolve => { finishTransfer=resolve; });
        return true;
      }
      if(command==='update_cancel') { finishTransfer?.(false); return; }
      if(command==='update_install'||command==='update_open_downloads') { globalThis.updateProbe.push(command); return; }
      if(command==='cloud_connect') {
        if(args?.email) throw new Error('Account form data must stay in the browser');
        globalThis.accountProbe.push(command);
        cloud={...cloud,email:'second@example.test',enabled:false};
        return cloud;
      }
      if(command==='reset_local') {
        if(args.confirmation!=='موافقم') throw 'resetConfirmationInvalid';
        globalThis.accountProbe.push(command);
        if(args.master!=='A fictional test passphrase') throw 'invalidPassword';
        cloud={...cloud,email:'',enabled:false};
        vaultExists=false;
        vaultUnlocked=false;
        return;
      }
      if(command==='cloud_list') {
        if(!cloud.email) throw 'cloudSignInRequired';
        return ${backups === "saved" ? "[{id:'test-backup',createdAt:'2026-01-01T00:00:00Z'}]" : "[]"};
      }
      if(command==='cloud_restore') {
        if(args.id!=='test-backup'||args.password!=='Fictional backup password') throw 'invalidPassword';
        globalThis.accountProbe.push(command);
        vaultExists=true;
        return;
      }
      if(command==='create_vault') {
        globalThis.accountProbe.push(command);
        vaultExists=true;
        vaultUnlocked=true;
        return;
      }
      if(command==='cloud_enable') {globalThis.accountProbe.push(command);return cloud;}
      if(command==='lock_vault') {
        globalThis.accountProbe.push(command);
        await emit('vault-locked');
        return;
      }
      throw Error('Unexpected test IPC '+command);
    },{shouldMockEvents:true});
    mockWindows('main');
    await import('/src/main.tsx?native-window-probe=1');
  `,
    }),
  );
  await page.goto("/");
  await expect(page.locator(".devtune-splash")).toHaveCount(0);
  await expect(
    page.getByRole("button", {
      name: unlocked ? "New item" : backups ? "Create a local vault" : "Unlock vault",
      exact: true,
    }),
  ).toBeVisible();
}

test("the updater can collapse, pause and resume, and protects an unsaved edit before installing", async ({ page }) => {
  await boot(page, true, "installed");
  await expect(page.getByText("New update available")).toBeVisible();
  await page.getByRole("button", { name: "Collapse update" }).click();
  await page.getByRole("button", { name: "Expand update" }).click();
  await page.getByRole("button", { name: "Download", exact: true }).click();
  await expect(page.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "50");
  await page.getByRole("button", { name: "Pause download" }).click();
  await expect(page.getByText("Update paused", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Resume download" }).click();
  await expect(page.getByText("Ready to install")).toBeVisible();
  await page.getByRole("button", { name: "New item", exact: true }).click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Unsaved update test");
  await page.getByRole("button", { name: "Install & restart" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(await page.evaluate(() => (globalThis as ProbeWindow).updateProbe)).toEqual(["update_download", "update_download"]);
  await page.getByRole("button", { name: "Discard changes", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (globalThis as ProbeWindow).updateProbe))
    .toEqual(["update_download", "update_download", "update_install"]);
});

test("portable updates open the DevTune download page without installing", async ({ page }) => {
  await boot(page, true, "portable");
  await page.getByRole("button", { name: "Open downloads" }).click();
  await expect.poll(() => page.evaluate(() => (globalThis as ProbeWindow).updateProbe)).toEqual(["update_open_downloads"]);
});
test("the empty vault fills the window at wide and narrow sizes", async ({ page }) => {
  await page.setViewportSize({ width: 1010, height: 770 });
  await boot(page, true);
  await expect(page.locator(".devtune-splash")).toHaveCount(0);
  await expect(page.locator(".list-empty")).toBeVisible();

  for (const viewport of [{ width: 1010, height: 770 }, { width: 400, height: 540 }]) {
    await page.setViewportSize(viewport);
    await expect.poll(async () => {
      const footer = await page.locator(".list-footer").boundingBox();
      return footer ? Math.round(footer.y + footer.height) : null;
    }).toBe(viewport.height);
  }
});

test("sign out requires written consent and the master password before returning to setup", async ({ page }) => {
  await boot(page, true);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("main", { name: "Settings", exact: true });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(settings.getByText("Connected as first@example.test")).toBeVisible();
  await settings.getByRole("button", { name: "Connect another account", exact: true }).click();
  await expect(settings.getByText("Connected as second@example.test")).toBeVisible();
  const signOut = settings.getByRole("button", { name: "Sign out", exact: true });
  await signOut.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(/permanently deletes your vault/)).toBeVisible();
  await expect(dialog.getByText(/export an encrypted backup/)).toBeVisible();
  await dialog.getByRole("button", { name: "Back to settings" }).click();
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => (globalThis as ProbeWindow).accountProbe)).toEqual(["cloud_connect"]);
  await signOut.click();
  const phrase = dialog.getByLabel("Type «موافقم» to continue");
  const next = dialog.getByRole("button", { name: "Continue", exact: true });
  await phrase.fill("I agree");
  await expect(next).toBeDisabled();
  await expect(dialog.getByLabel("Master password", { exact: true })).toHaveCount(0);
  await phrase.fill("موافقم");
  await next.click();
  const master = dialog.getByLabel("Master password", { exact: true });
  const erase = dialog.getByRole("button", { name: "Erase data and sign out", exact: true });
  await master.fill("incorrect");
  await erase.click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await master.fill("A fictional test passphrase");
  await erase.click();
  await expect(page.getByRole("button", { name: "Create a local vault", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in or sign up with DevTune", exact: true })).toBeVisible();
  await expect(settings).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (globalThis as ProbeWindow).accountProbe))
    .toEqual(["cloud_connect", "reset_local", "reset_local"]);
});

test("one DevTune button opens browser authentication and restores a backup", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 580 });
  await boot(page, false, undefined, "saved");
  const main = page.getByRole("main");
  const account = main.getByRole("button", { name: "Sign in or sign up with DevTune", exact: true });
  await expect(account).toHaveCount(1);
  await expect(main.locator("input")).toHaveCount(0);
  await expect(main.getByRole("heading", { name: "Set up PassWards" })).toBeFocused();
  await page.screenshot({ path: "artifacts/auth-welcome-360-dark.png", animations: "disabled" });
  await account.click();
  await expect(main.getByRole("heading", { name: "Restore from cloud" })).toBeFocused();
  await expect(main.locator("input")).toHaveCount(1);
  expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
  await page.screenshot({ path: "artifacts/auth-restore-360-dark.png" });
  await main.getByLabel("Backup master password", { exact: true }).fill("Fictional backup password");
  await main.getByRole("button", { name: "Restore from cloud", exact: true }).click();
  await expect(main.getByRole("heading", { name: "Unlock PassWards" })).toBeVisible();
  expect(await page.evaluate(() => (globalThis as ProbeWindow).accountProbe)).toEqual(["cloud_connect", "cloud_restore"]);
});

test("a DevTune account without backups can create a vault with cloud backup enabled", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await boot(page, false, undefined, "empty");
  await page.getByRole("button", { name: "Sign in or sign up with DevTune" }).click();
  await expect(page.getByRole("heading", { name: "Your account is connected" })).toBeVisible();
  const setPassword = page.getByRole("button", { name: "Set a master password" });
  await setPassword.click();
  await page.getByRole("button", { name: "Back to DevTune" }).click();
  await setPassword.click();
  await page.screenshot({ path: "artifacts/auth-master-900-light.png" });
  await page.getByLabel("Master password", { exact: true }).fill("A new fictional vault password");
  await page.getByLabel("Confirm master password", { exact: true }).fill("A new fictional vault password");
  await page.getByRole("button", { name: "Create vault", exact: true }).click();
  await expect(page.getByRole("button", { name: "New item", exact: true })).toBeVisible();
  expect(await page.evaluate(() => (globalThis as ProbeWindow).accountProbe)).toEqual(["cloud_connect", "create_vault", "cloud_enable"]);
});

test("sign out is at the bottom of settings and accessible in a narrow window", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 540 });
  await boot(page, true);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("main", { name: "Settings", exact: true });
  await expect(settings.getByRole("button", { name: "Quit PassWards", exact: true })).toHaveCount(0);
  const signOut = settings.getByRole("button", { name: "Sign out", exact: true });
  await expect(signOut).not.toBeInViewport();
  await signOut.scrollIntoViewIfNeeded();
  await expect(signOut).toBeInViewport();
  await page.screenshot({ path: "artifacts/settings-signout-360.png" });
  expect(await settings.evaluate((el) => el.scrollWidth)).toBe(
    await settings.evaluate((el) => el.clientWidth),
  );
  const shortcuts = settings.getByText("Keyboard shortcuts", { exact: true });
  await shortcuts.scrollIntoViewIfNeeded();
  await expect(shortcuts).toBeInViewport();
  await signOut.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  expect((await new AxeBuilder({ page }).include("dialog").withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
  await dialog.getByRole("button", { name: "Back to settings" }).click();
  await expect(dialog).toHaveCount(0);
  await settings.getByRole("button", { name: "Back to vault", exact: true }).click();
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeFocused();
  expect(await page.evaluate(() => (globalThis as ProbeWindow).accountProbe)).toEqual([]);
});

for (const unlocked of [false, true]) {
  test(`native close lifecycle completes when vault is ${unlocked ? "open" : "locked"}`, async ({
    page,
  }) => {
    await boot(page, unlocked);
    await page
      .getByRole("button", { name: "Close window", exact: true })
      .click();
    await expect
      .poll(() => page.evaluate(() => (globalThis as ProbeWindow).windowCloseProbe))
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
    await page.evaluate(() => (globalThis as ProbeWindow).windowCloseProbe.calls),
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
    .poll(() => page.evaluate(() => (globalThis as ProbeWindow).windowCloseProbe))
    .toEqual({ calls: ["close", "destroy"], denied: [], destroyed: true });
});
