import { chromium } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdtemp, readFile, writeFile, cp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { createServer } from "node:http";
import assert from "node:assert/strict";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureIcon = await readFile(
  path.join(root, "browser-extension/icons/32.png"),
);
const temp = await mkdtemp(path.join(tmpdir(), "passward-extension-test-"));
const key =
  "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.passward.fixture";
const edgeKey =
  "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.passward.fixture";
const pendingLines = [],
  waiters = [];
let fixture, context;
let checks = 0;
const customForms = {
  modal: `<form><input type="email" name="background-email" value="wrong-background@example.test"><input type="password" autocomplete="new-password"><input type="password" autocomplete="new-password"></form><section role="dialog" aria-modal="true" aria-label="Log in"><h1>Log in</h1><form method="post"><label>Email<input type="email" name="pinterest-email" autocomplete="username"></label><label>Password<input type="password" name="pinterest-password" autocomplete="current-password"></label><button type="submit">Log in</button></form></section>`,
  revealed: `<form method="post"><label>Email<input type="email" name="email" autocomplete="username"></label><label>Password<input type="text" name="password" autocomplete="current-password"></label><button type="submit">Log in</button></form>`,
  formless: `<section role="dialog" aria-modal="true" aria-label="Log in"><label>Email<input type="email" name="email" autocomplete="username"></label><label>Password<input type="password" name="password" autocomplete="current-password"></label><button type="button">Log in</button></section>`,
  pin: `<form><label>Email<input type="email" name="email"></label><label>Code<input type="password" name="login-pin" autocomplete="one-time-code"></label><button>Log in</button></form>`,
};
const html = (kind) =>
  `<!doctype html><html lang="en"><head><title>Fictional test login</title><link rel="icon" href="/favicon.png"><style>body{font:14px/1.5 system-ui;background:#f5f6f7;color:#242426;padding:40px}form{display:grid;gap:18px;max-width:350px}label{display:grid;gap:5px}input{padding:10px;border:1px solid #b7bbc2;border-radius:6px;font:inherit}button{padding:10px;border:1px solid #a0a6ad;border-radius:6px;font:inherit;background:white}</style></head><body><h1>Sign in</h1>${kind === "success" ? "<p>Signed in (fictional test only)</p>" : kind === "iframe" ? '<iframe src="/login"></iframe>' : kind === "search" ? '<input type="search" name="search">' : `<form method="post" action="${kind === "navigate" ? "/success" : kind === "cross" ? "http://localhost:65500/login" : "/login"}"><label>Email<input type="email" name="email" autocomplete="username"></label>${kind === "username" ? "" : `<label>Password<input type="password" name="password" autocomplete="${kind === "signup" ? "new-password" : "current-password"}"></label>`}${kind === "signup" ? '<label>Confirm password<input type="password" autocomplete="new-password"></label>' : ""}<input type="password" name="hidden-password" style="display:none"><button type="submit">${kind === "username" ? "Continue" : "Sign in"}</button></form>`}<script>window.submitted=false;document.querySelector('form')?.addEventListener('submit',e=>{if(${JSON.stringify(kind)} !== "navigate")e.preventDefault();window.submitted=true;});document.addEventListener('input',()=>window.inputs=(window.inputs||0)+1);</script></body></html>`;
const server = createServer((req, res) => {
  if (req.url === "/favicon.png") {
    res.writeHead(200, { "content-type": "image/png" });
    res.end(fixtureIcon);
    return;
  }
  res.writeHead(200, { "content-type": "text/html" });
  const kind = (req.url || "").split("?")[0].slice(1);
  res.end(
    customForms[kind]
      ? `<!doctype html><html lang="en"><head><title>Fictional login regression</title><style>body{font:16px system-ui;padding:32px}form,section{display:grid;gap:14px;max-width:360px}input,button{padding:12px}section{position:fixed;inset:40px auto auto 40px;background:white;padding:32px;border:1px solid #ddd}label{display:grid}</style></head><body>${customForms[kind]}<script>document.querySelectorAll('form').forEach(form=>form.addEventListener('submit',e=>e.preventDefault()))</script></body></html>`
      : html(kind),
  );
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const site = `http://127.0.0.1:${server.address().port}`;
const other = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(html("login"));
});
await new Promise((r) => other.listen(0, "127.0.0.1", r));
const otherSite = `http://127.0.0.1:${other.address().port}`;
const nextLine = () =>
  pendingLines.length
    ? Promise.resolve(pendingLines.shift())
    : new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(Error("Fixture output timeout")),
          30000,
        );
        waiters.push((value) => {
          clearTimeout(timer);
          resolve(value);
        });
      });
const control = async (op) => {
  fixture.stdin.write(JSON.stringify({ op }) + "\n");
  return JSON.parse(await nextLine());
};
async function waitPending(op = "pending") {
  for (let n = 0; n < 80; n++) {
    const result = await control(op);
    if (result.pending) return result.pending;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error("No approval request");
}
function check(label) {
  checks++;
  console.log(`PASS ${checks}: ${label}`);
}
try {
  const extension = path.join(temp, "extension");
  await cp(path.join(root, "browser-extension"), extension, {
    recursive: true,
  });
  let background = await readFile(
    path.join(extension, "background.js"),
    "utf8",
  );
  background = background.replace(
    "com.passward.bridge",
    "com.passward.fixture",
  );
  await writeFile(path.join(extension, "background.js"), background);
  const manifest = JSON.parse(
    await readFile(path.join(extension, "manifest.json"), "utf8"),
  );
  assert.deepEqual(manifest.host_permissions, ["https://*/*", "http://*/*"]);
  assert.equal(manifest.optional_host_permissions, undefined);
  assert.deepEqual(manifest.content_scripts, [
    {
      matches: ["https://*/*", "http://*/*"],
      js: ["content.js"],
      run_at: "document_idle",
      all_frames: false,
    },
  ]);
  check(
    "Production manifest automatically detects top-frame HTTP/HTTPS forms with one browser permission",
  );
  manifest.host_permissions = ["http://127.0.0.1/*"];
  manifest.content_scripts = [
    {
      matches: ["http://127.0.0.1/*"],
      js: ["content.js"],
      all_frames: false,
      run_at: "document_idle",
    },
  ];
  await writeFile(
    path.join(extension, "manifest.json"),
    JSON.stringify(manifest),
  );
  const executable =
    process.env.PASSWARD_FIXTURE_EXE ||
    path.join(root, "src-tauri/target/debug/examples/browser_fixture.exe");
  const env = {
    ...process.env,
    PASSWARD_FIXTURE_PIPE: process.env.PASSWARD_NATIVE_EXE
      ? execFileSync(executable, ["--endpoint"], {
          encoding: "utf8",
          windowsHide: true,
        }).trim()
      : `\\\\.\\pipe\\Passward-fixture-${crypto.randomUUID()}`,
  };
  fixture = spawn(executable, [path.join(temp, "vault"), site], {
    env,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  createInterface({ input: fixture.stdout }).on("line", (line) => {
    const waiter = waiters.shift();
    if (waiter) waiter(line);
    else pendingLines.push(line);
  });
  fixture.stderr.on("data", (b) => process.stderr.write(b));
  const ready = JSON.parse(await nextLine());
  const nativeManifest = path.join(temp, "native.json");
  await writeFile(
    nativeManifest,
    JSON.stringify({
      name: "com.passward.fixture",
      description: "Temporary fictional test host",
      path: process.env.PASSWARD_NATIVE_EXE || executable,
      type: "stdio",
      allowed_origins: [
        `chrome-extension://${JSON.parse(await readFile(path.join(extension, "identity.json"), "utf8")).id}/`,
      ],
    }),
  );
  for (const registryKey of [key, edgeKey])
    execFileSync(
      "reg.exe",
      ["ADD", registryKey, "/ve", "/t", "REG_SZ", "/d", nativeManifest, "/f"],
      { windowsHide: true, stdio: "pipe" },
    );
  const channel = process.env.PASSWARD_TEST_CHANNEL || "msedge";
  const browserOptions = {
    channel,
    headless: true,
    reducedMotion: "reduce",
    env,
    ignoreDefaultArgs: channel === "chrome" ? ["--disable-extensions"] : [],
    args:
      channel === "chrome"
        ? ["--enable-unsafe-extension-debugging"]
        : [
            `--disable-extensions-except=${extension}`,
            `--load-extension=${extension}`,
          ],
  };
  async function launchBrowser() {
    context = await chromium.launchPersistentContext(
      path.join(temp, "profile"),
      browserOptions,
    );
    if (channel === "chrome") {
      const session = await context.browser().newBrowserCDPSession();
      await session.send("Extensions.loadUnpacked", { path: extension });
    }
    const worker =
      context.serviceWorkers()[0] ||
      (await context.waitForEvent("serviceworker", { timeout: 20000 }));
    await worker.evaluate(() => {
      globalThis.__autoPopupCalls = 0;
      chrome.action.openPopup = async () => {
        globalThis.__autoPopupCalls++;
        throw Error(
          "Fictional browser popup restriction: exercise inline fallback",
        );
      };
    });
    return worker;
  }
  let worker = await launchBrowser();
  const id = new URL(worker.url()).host;
  let popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  let page = await context.newPage();
  await page.goto(site + "/login");
  await page.bringToFront();
  const message = (body) =>
    popup.evaluate((body) => chrome.runtime.sendMessage(body), body);
  assert.equal(
    (await message({ type: "pair", code: ready.code, browser: "Edge" })).ok,
    true,
  );
  check(
    "Real runtime → native messaging → named pipe → temporary vault pairing",
  );
  const originalToken = await worker.evaluate(
    async () => (await chrome.storage.local.get("token")).token,
  );
  assert.equal(
    (
      await message({
        type: "pair",
        code: "unused-duplicate-code",
        browser: "Edge",
      })
    ).ok,
    true,
  );
  assert.equal((await message({ type: "disconnect" })).error, "browserDenied");
  assert.equal(
    await worker.evaluate(
      async () => (await chrome.storage.local.get("token")).token,
    ),
    originalToken,
  );
  check(
    "Pairing is idempotent and extension messages cannot disconnect a paired browser",
  );
  await page.waitForSelector("#passward-assistant", { state: "attached" });
  const initialOpenCalls = await worker.evaluate(
    () => globalThis.__autoPopupCalls,
  );
  assert.equal(initialOpenCalls, 1);
  assert.equal((await control("pending")).pending, null);
  assert.equal(await page.locator("input[name=password]").inputValue(), "");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(2300);
  assert.equal(
    await worker.evaluate(() => globalThis.__autoPopupCalls),
    initialOpenCalls,
  );
  check(
    "Login form opens automatically without a click; blocked toolbar popup falls back inline without filling or repeated opening",
  );
  const matches = await message({ type: "matches" });
  assert.equal(matches.ok, true, JSON.stringify(matches));
  assert.equal(matches.data.accounts.length, 1);
  assert.equal("password" in matches.data.accounts[0], false);
  check("Exact-origin metadata only");
  await popup.evaluate(() => document.querySelector("#refresh").click());
  await popup.getByRole("button", { name: "Fill", exact: true }).waitFor();
  await mkdir(path.join(root, "artifacts"), { recursive: true });
  for (const theme of ["light", "dark"]) {
    await popup.evaluate(
      (theme) => (document.documentElement.dataset.theme = theme),
      theme,
    );
    assert.deepEqual(
      (
        await new AxeBuilder({ page: popup })
          .withTags(["wcag2a", "wcag2aa"])
          .analyze()
      ).violations,
      [],
    );
    await popup.screenshot({
      path: path.join(root, `artifacts/extension-popup-${theme}.png`),
      clip: { x: 0, y: 0, width: 352, height: 460 },
    });
  }
  await popup.evaluate(() => document.querySelector("#language").click());
  assert.equal(await popup.locator("html").getAttribute("lang"), "en");
  assert.equal(await popup.locator("#language").isVisible(), false);
  assert.deepEqual(
    (
      await new AxeBuilder({ page: popup })
        .withTags(["wcag2a", "wcag2aa"])
        .analyze()
    ).violations,
    [],
  );
  check("Popup: light/dark accessibility; Persian toggle disabled");
  assert.equal(await page.locator("input[name=password]").inputValue(), "");
  let fill = message({ type: "fill", id: ready.entry });
  await waitPending();
  assert.equal(await page.locator("input[name=password]").inputValue(), "");
  await control("approve");
  assert.equal((await fill).ok, true);
  assert.equal(
    await page.locator("input[name=email]").inputValue(),
    "fixture@example.test",
  );
  assert.equal(
    await page.locator("input[name=password]").inputValue(),
    "Fictional-Autofill-Secret-7294!",
  );
  assert.equal(
    await page.locator("input[name=hidden-password]").inputValue(),
    "",
  );
  assert.equal(await page.evaluate(() => window.submitted), false);
  assert.equal(await page.evaluate(() => window.inputs), 2);
  check("Approved fill, input events, hidden field untouched, no submit");
  await page.goto(site + "/username");
  fill = message({ type: "fill", id: ready.entry });
  await waitPending();
  await control("approve");
  assert.equal((await fill).ok, true);
  assert.equal(
    await page.locator("input[name=email]").inputValue(),
    "fixture@example.test",
  );
  check("Username-first login");
  await page.goto(site + "/login");
  fill = message({ type: "fill", id: ready.entry });
  await waitPending();
  await control("deny");
  assert.equal((await fill).ok, false);
  assert.equal(await page.locator("input[name=password]").inputValue(), "");
  check("Declined request never fills");
  await page.goto(otherSite + "/login");
  assert.deepEqual((await message({ type: "matches" })).data.accounts, []);
  check("Different port / origin cannot match");
  for (const kind of ["signup", "search", "iframe", "cross"]) {
    await page.goto(site + "/" + kind);
    assert.equal((await message({ type: "matches" })).error, "noForm", kind);
  }
  check(
    "Signup, search, iframe-only and cross-origin form destinations rejected",
  );
  await page.goto(site + "/login");
  fill = message({ type: "fill", id: ready.entry });
  await waitPending();
  await page.goto(site + "/login?new-document");
  const changed = await fill;
  assert.equal(changed.ok, false);
  assert.equal(await page.locator("input[name=password]").inputValue(), "");
  check("Navigation invalidates the pending document grant");
  await page.goto(site + "/login");
  await page
    .getByLabel("Email", { exact: true })
    .fill("new-fictional@example.test");
  await page
    .getByLabel("Password", { exact: true })
    .fill("Fresh-fictional-save-782!");
  const beforeSavePopup = await worker.evaluate(
    () => globalThis.__autoPopupCalls,
  );
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  let captured;
  for (let n = 0; n < 50; n++) {
    captured = (await message({ type: "state" })).data.capture;
    if (captured?.status === "ready") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(captured?.kind, "save");
  assert.equal(captured.automatic, true);
  await page.locator("#passward-assistant").waitFor({ state: "hidden" });
  for (let n = 0; n < 30; n++) {
    if (
      (await worker.evaluate(() => globalThis.__autoPopupCalls)) >
      beforeSavePopup
    )
      break;
    await page.waitForTimeout(100);
  }
  const afterSavePopup = await worker.evaluate(
    () => globalThis.__autoPopupCalls,
  );
  assert.equal(afterSavePopup, beforeSavePopup + 1);
  await page.waitForTimeout(2300);
  assert.equal(
    await worker.evaluate(() => globalThis.__autoPopupCalls),
    afterSavePopup,
  );
  await popup.evaluate(() => document.querySelector("#refresh").click());
  await popup
    .getByRole("heading", { name: "Save this login?", exact: true })
    .waitFor();
  assert.equal(
    await popup.getByRole("button", { name: "Save", exact: true }).count(),
    1,
  );
  assert.equal(
    await popup
      .getByRole("button", { name: "Save entered login", exact: true })
      .count(),
    0,
  );
  assert.equal(await popup.getByRole("button", { name: /Review/i }).count(), 0);
  check(
    "One save surface: no in-page card, one popup Save button, no duplicate manual/Review control or repeated automatic opening",
  );
  await popup.screenshot({
    path: path.join(root, "artifacts/extension-save-offer.png"),
    clip: { x: 0, y: 0, width: 352, height: 560 },
  });
  assert.equal("password" in captured, false);
  await page.waitForFunction(
    () => !!document.querySelector('link[rel="icon"]'),
  );
  await page.waitForTimeout(300);
  let saving;
  await popup.getByRole("button", { name: "Save", exact: true }).click();
  let saveRequest = await waitPending("pendingSave");
  assert.equal(saveRequest.kind, "save");
  assert.equal((await control("savedAccounts")).items.length, 1);
  assert.equal(
    await popup.getByRole("button", { name: "Save", exact: true }).isEnabled(),
    false,
  );
  assert.equal(
    await popup
      .getByRole("button", { name: "Save entered login", exact: true })
      .count(),
    0,
  );
  await control("approveSave");
  await popup
    .getByText("Login saved in your vault.", { exact: true })
    .first()
    .waitFor();
  let stored = (await control("savedAccounts")).items;
  assert.equal(
    stored.find((a) => a.username === "new-fictional@example.test").password,
    "Fresh-fictional-save-782!",
  );
  const savedIcon = stored.find(
    (a) => a.username === "new-fictional@example.test",
  ).favicon;
  assert.match(savedIcon, /^data:image\/png;base64,/);
  const savedIconBytes = Buffer.from(savedIcon.split(",")[1], "base64");
  assert.equal(savedIconBytes.readUInt32BE(16), 32);
  assert.equal(savedIconBytes.readUInt32BE(20), 32);
  check(
    "Browser favicon cache is copied into the approved encrypted login as a 32px PNG",
  );
  check(
    "Trusted form submission offers a new login; desktop approval is required before saving",
  );

  await page.goto(site + "/login");
  await page
    .getByLabel("Email", { exact: true })
    .fill("new-fictional@example.test");
  await page
    .getByLabel("Password", { exact: true })
    .fill("Changed-fictional-save-273!");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  for (let n = 0; n < 50; n++) {
    captured = (await message({ type: "state" })).data.capture;
    if (captured?.status === "ready") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(captured.kind, "update");
  await popup.evaluate(() => document.querySelector("#refresh").click());
  await popup.getByRole("button", { name: "Update", exact: true }).waitFor();
  assert.equal(
    await popup.getByRole("button", { name: "Update", exact: true }).count(),
    1,
  );
  assert.equal(
    await popup
      .getByRole("button", { name: "Save entered login", exact: true })
      .count(),
    0,
  );
  assert.equal(
    await popup.getByRole("button", { name: "Save", exact: true }).count(),
    0,
  );
  await page.locator("#passward-assistant").waitFor({ state: "hidden" });
  check("Password updates also expose exactly one action in the popup");
  saving = message({ type: "saveLogin", id: captured.id });
  await waitPending("pendingSave");
  await control("approveSave");
  assert.equal((await saving).data.outcome, "updated");
  stored = (await control("savedAccounts")).items;
  assert.equal(stored.length, 2);
  const updated = stored.find(
    (a) => a.username === "new-fictional@example.test",
  );
  assert.equal(updated.password, "Changed-fictional-save-273!");
  assert.deepEqual(updated.history, ["Fresh-fictional-save-782!"]);
  assert.match(updated.favicon, /^data:image\/png;base64,/);
  check(
    "Changed password updates the exact account, preserves history and creates no duplicate",
  );

  await page.goto(site + "/login");
  await page
    .getByLabel("Email", { exact: true })
    .fill("new-fictional@example.test");
  await page
    .getByLabel("Password", { exact: true })
    .fill("Changed-fictional-save-273!");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await new Promise((r) => setTimeout(r, 700));
  assert.equal((await message({ type: "state" })).data.capture, null);
  check("An unchanged saved login does not prompt again");

  await page.goto(site + "/login");
  await page.evaluate(() => {
    document.querySelector("[name=email]").value = "scripted@example.test";
    document.querySelector("[name=password]").value =
      "Scripted-not-user-input!";
    document
      .querySelector("[name=password]")
      .dispatchEvent(new Event("input", { bubbles: true }));
    document
      .querySelector("form")
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await new Promise((r) => setTimeout(r, 700));
  assert.equal((await message({ type: "state" })).data.capture, null);
  check("Synthetic input and submit events cannot create a save suggestion");

  await page
    .getByLabel("Email", { exact: true })
    .fill("decline-fictional@example.test");
  await page
    .getByLabel("Password", { exact: true })
    .fill("Declined-fictional-save!");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  for (let n = 0; n < 50; n++) {
    captured = (await message({ type: "state" })).data.capture;
    if (captured?.status === "ready") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  saving = message({ type: "saveLogin", id: captured.id });
  await waitPending("pendingSave");
  await control("denySave");
  assert.equal((await saving).data.outcome, "declined");
  assert.equal((await control("savedAccounts")).items.length, 2);
  const diskStorage = await worker.evaluate(async () => ({
    local: await chrome.storage.local.get(null),
    session: await chrome.storage.session.get(null),
  }));
  const serialized = JSON.stringify(diskStorage);
  for (const secret of [
    "Fresh-fictional-save-782!",
    "Changed-fictional-save-273!",
    "Declined-fictional-save!",
  ])
    assert.equal(serialized.includes(secret), false);
  check(
    "Declined saves do not write; captured passwords never enter extension storage",
  );
  await page.goto(site + "/navigate");
  await page
    .getByLabel("Email", { exact: true })
    .fill("navigate-fictional@example.test");
  await page
    .getByLabel("Password", { exact: true })
    .fill("Navigation-fictional-save!");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(site + "/success");
  for (let n = 0; n < 50; n++) {
    captured = (await message({ type: "state" })).data.capture;
    if (captured?.status === "ready") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(captured?.username, "navigate-fictional@example.test");
  assert.equal(captured?.kind, "save");
  saving = message({ type: "saveLogin", id: captured.id });
  await waitPending("pendingSave");
  await control("denySave");
  await saving;
  check(
    "Save suggestion survives real same-origin form navigation and works on the landing page",
  );

  await page.goto(site + "/username");
  await page
    .getByLabel("Email", { exact: true })
    .fill("multi-step-fictional@example.test");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await new Promise((r) => setTimeout(r, 200));
  await page.goto(site + "/login");
  await page
    .getByLabel("Password", { exact: true })
    .fill("Multi-step-fictional-save!");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  for (let n = 0; n < 50; n++) {
    captured = (await message({ type: "state" })).data.capture;
    if (captured?.status === "ready") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(captured?.username, "multi-step-fictional@example.test");
  await message({ type: "dismissLogin", id: captured.id });
  assert.equal((await message({ type: "state" })).data.capture, null);
  check(
    "Username-first submission carries the username across same-origin steps; Not now clears it",
  );
  await page.goto(site + "/login");
  await page
    .getByLabel("Email", { exact: true })
    .fill("manual-fictional@example.test");
  await page
    .getByLabel("Password", { exact: true })
    .fill("Manual-fictional-save!");
  async function saveFromPopup(username, password) {
    await popup.evaluate(() => document.querySelector("#refresh").click());
    const button = popup.getByRole("button", {
      name: "Save entered login",
      exact: true,
    });
    await button.waitFor();
    await button.click();
    const request = await waitPending("pendingSave");
    assert.equal(request.username, username);
    await popup
      .locator("#status")
      .filter({ hasText: "Approve this request in PassWards." })
      .waitFor();
    assert.equal(
      (await control("savedAccounts")).items.some(
        (item) => item.username === username,
      ),
      false,
    );
    await control("approveSave");
    await popup.waitForFunction(
      (site) => document.querySelector("#status").textContent === site,
      site,
    );
    await popup
      .getByText("Login saved in your vault.", { exact: true })
      .waitFor();
    const record = (await control("savedAccounts")).items.find(
      (item) => item.username === username,
    );
    assert.equal(record.password, password);
  }
  await saveFromPopup(
    "manual-fictional@example.test",
    "Manual-fictional-save!",
  );
  assert.equal(await page.evaluate(() => window.submitted), false);
  check(
    "One click on Save entered login requests desktop approval and actually saves without submitting the website form",
  );

  await page.goto(site + "/modal");
  const modal = page.getByRole("dialog", { name: "Log in", exact: true });
  await modal
    .getByLabel("Email", { exact: true })
    .fill("modal-regression@example.test");
  await modal
    .getByLabel("Password", { exact: true })
    .fill("Fictional-modal-password-715!");
  await saveFromPopup(
    "modal-regression@example.test",
    "Fictional-modal-password-715!",
  );
  assert.equal(
    (await control("savedAccounts")).items.some(
      (item) => item.username === "wrong-background@example.test",
    ),
    false,
  );
  check(
    "Active modal login saves the correct account despite a signup form behind it and Pinterest-prefixed input names",
  );

  await page.goto(site + "/revealed");
  await page
    .getByLabel("Email", { exact: true })
    .fill("revealed-regression@example.test");
  await page
    .getByLabel("Password", { exact: true })
    .fill("Fictional-revealed-password-923!");
  await page.evaluate(() =>
    document
      .querySelectorAll("input")
      .forEach((input) => (input.readOnly = true)),
  );
  await saveFromPopup(
    "revealed-regression@example.test",
    "Fictional-revealed-password-923!",
  );
  check(
    "Manual Save recognizes a revealed password and can read a temporarily read-only login without trying to autofill it",
  );

  await page.goto(site + "/formless");
  await page
    .getByLabel("Email", { exact: true })
    .fill("formless-regression@example.test");
  await page
    .getByLabel("Password", { exact: true })
    .fill("Fictional-formless-password-467!");
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  for (let n = 0; n < 50; n++) {
    captured = (await message({ type: "state" })).data.capture;
    if (captured?.status === "ready") break;
    await page.waitForTimeout(100);
  }
  assert.equal(captured?.username, "formless-regression@example.test");
  saving = message({ type: "saveLogin", id: captured.id });
  await waitPending("pendingSave");
  await control("approveSave");
  assert.equal((await saving).data.outcome, "saved");
  check(
    "A trusted Log in click on a form-less dialog produces a working save suggestion",
  );

  await page.goto(site + "/pin");
  await page
    .getByLabel("Email", { exact: true })
    .fill("pin-never-saved@example.test");
  await page.getByLabel("Code", { exact: true }).fill("125937");
  assert.equal((await message({ type: "captureCurrent" })).error, "noForm");
  await page.goto(site + "/cross");
  await page
    .getByLabel("Email", { exact: true })
    .fill("cross-never-saved@example.test");
  await page
    .getByLabel("Password", { exact: true })
    .fill("Fictional-cross-not-captured!");
  assert.equal((await message({ type: "captureCurrent" })).error, "noForm");
  assert.equal((await message({ type: "state" })).data.capture, null);
  check(
    "PIN/OTP fields and cross-origin form destinations remain excluded from manual capture",
  );
  await page.goto(site + "/login");

  await worker.evaluate(async (tabUrl) => {
    const [tab] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    if (tab.url !== tabUrl) throw Error("Unexpected test tab");
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [0] },
      func: () => {
        const api = globalThis.__passward;
        globalThis.__passward = Object.freeze({ ...api, version: undefined });
      },
    });
  }, site + "/login");
  assert.equal(
    (await message({ type: "captureCurrent" })).error,
    "pageReloadRequired",
  );
  assert.equal((await control("pendingSave")).pending, null);
  check(
    "A stale page script reports an explicit refresh instruction and never starts an invalid save",
  );
  await page.reload();

  await popup.evaluate(() => document.querySelector("#refresh").click());
  await popup
    .getByRole("button", { name: "Fill", exact: true })
    .first()
    .waitFor();
  assert.equal(
    await popup.getByRole("checkbox", { name: /Detect logins/ }).count(),
    0,
  );
  assert.equal(
    await popup.getByRole("button", { name: /Disconnect/i }).count(),
    0,
  );
  assert.equal(
    await popup
      .getByText("Paired with PassWards. Manage this connection in the app.", {
        exact: true,
      })
      .isVisible(),
    true,
  );
  check("Popup has no per-site detection toggle or disconnect control");

  await page.goto(site + "/search");
  assert.equal(await page.locator("#passward-assistant").count(), 0);
  const beforeDynamic = await worker.evaluate(
    () => globalThis.__autoPopupCalls,
  );
  await page.evaluate(() => {
    document.querySelector("input").remove();
    document.body.insertAdjacentHTML(
      "beforeend",
      '<form method="post"><label>Email<input type="email" autocomplete="username" name="email"></label><label>Password<input type="password" name="password" autocomplete="current-password"></label><button type="submit">Sign in</button></form>',
    );
  });
  await page.waitForSelector("#passward-assistant", { state: "attached" });
  assert.equal(
    await worker.evaluate(() => globalThis.__autoPopupCalls),
    beforeDynamic + 1,
  );
  check(
    "Dynamically inserted login forms are detected automatically; search pages stay quiet",
  );

  await worker.evaluate(() => {
    chrome.action.openPopup = async (options) => {
      if (!Number.isInteger(options.windowId))
        throw Error("Missing popup window");
      globalThis.__autoPopupCalls++;
    };
  });
  await page.goto(site + "/login?toolbar-popup");
  await page.waitForTimeout(2500);
  assert.equal(
    await worker.evaluate(() => globalThis.__autoPopupCalls),
    beforeDynamic + 2,
  );
  assert.equal(await page.locator("#passward-assistant").count(), 0);
  const inactivePage = await context.newPage();
  await page.bringToFront();
  await inactivePage.goto(site + "/login?background-tab");
  await page.waitForTimeout(2300);
  assert.equal(
    await worker.evaluate(() => globalThis.__autoPopupCalls),
    beforeDynamic + 2,
  );
  await inactivePage.close();
  await worker.evaluate(() => {
    chrome.action.openPopup = async () => {
      globalThis.__autoPopupCalls++;
      throw Error("Fictional popup restriction");
    };
  });
  check(
    "Successful toolbar opening does not duplicate the inline picker; background tabs never open it",
  );

  await page.goto(site + "/login");
  await page.bringToFront();
  // The closed-shadow assistant is mounted only after pairing is verified.
  // Wait for its host before exercising keyboard selection in the login field.
  await page.waitForSelector("#passward-assistant", { state: "attached" });
  await page.getByLabel("Email", { exact: true }).focus();
  await page.keyboard.press("ArrowDown");
  await page.waitForFunction(
    () => document.activeElement?.id === "passward-assistant",
  );
  await page.screenshot({
    path: path.join(root, "artifacts/extension-inline-logins.png"),
    animations: "disabled",
  });
  await page.keyboard.press("Enter");
  const inlinePending = await waitPending();
  assert.equal(
    await page.getByLabel("Password", { exact: true }).inputValue(),
    "",
  );
  await control("approve");
  await page.waitForFunction(() =>
    Boolean(document.querySelector("input[name=password]").value),
  );
  assert.equal(
    await page.getByLabel("Email", { exact: true }).inputValue(),
    inlinePending.username,
  );
  assert.equal(await page.evaluate(() => window.submitted), false);
  check(
    "Inline keyboard suggestions fill the chosen login only after desktop approval",
  );

  await popup.evaluate(() => chrome.storage.local.set({ autoSubmit: true }));
  await page.goto(site + "/login");
  fill = message({ type: "fill", id: ready.entry });
  await waitPending();
  await control("approve");
  assert.equal((await fill).ok, true);
  assert.equal(await page.evaluate(() => window.submitted), true);
  for (const unsafeSubmit of ["get", "external", "target"]) {
    await page.goto(site + "/login");
    await page.evaluate((kind) => {
      const form = document.querySelector("form"),
        button = form.querySelector("button");
      if (kind === "get") form.method = "get";
      if (kind === "external")
        button.formAction = "https://example.invalid/login";
      if (kind === "target") button.formTarget = "_blank";
    }, unsafeSubmit);
    const guardedFill = message({ type: "fill", id: ready.entry });
    await waitPending();
    await control("approve");
    assert.equal((await guardedFill).ok, true);
    assert.equal(await page.evaluate(() => window.submitted), false);
  }
  await popup.evaluate(() => chrome.storage.local.set({ autoSubmit: false }));
  check(
    "Automatic sign-in is opt-in; the enabled option submits POST only and rejects unsafe submission overrides",
  );

  await popup.evaluate(() => document.querySelector("#refresh").click());
  const search = popup.getByRole("searchbox", {
    name: "Search logins for this site",
    exact: true,
  });
  await search.fill("does-not-exist-fixture");
  assert.equal(await popup.locator(".account:visible").count(), 0);
  await search.fill("fixture@example.test");
  assert.equal(await popup.locator(".account:visible").count(), 1);
  await search.fill("");
  await popup.getByText("Autofill settings", { exact: true }).click();
  assert.equal(
    await popup
      .getByLabel("Sign in automatically after filling", { exact: true })
      .isChecked(),
    false,
  );
  assert.deepEqual(
    (
      await new AxeBuilder({ page: popup })
        .withTags(["wcag2a", "wcag2aa"])
        .analyze()
    ).violations,
    [],
  );
  await popup.screenshot({
    path: path.join(root, "artifacts/extension-settings.png"),
    clip: { x: 0, y: 0, width: 352, height: 560 },
    animations: "disabled",
  });
  check(
    "Site account search and expanded autofill settings work and pass accessibility checks",
  );

  await page.goto(site + "/login");
  await page
    .getByLabel("Email", { exact: true })
    .fill("no-icon-fictional@example.test");
  await page
    .getByLabel("Password", { exact: true })
    .fill("Fictional-favicon-fallback!");
  await worker.evaluate(() => {
    globalThis.__originalFaviconFetch = fetch;
    globalThis.fetch = (...args) =>
      String(args[0]).includes("/_favicon/")
        ? Promise.reject(Error("Fictional cache unavailable"))
        : globalThis.__originalFaviconFetch(...args);
  });
  try {
    const fallbackCapture = await message({ type: "captureCurrent" });
    const fallbackSave = message({
      type: "saveLogin",
      id: fallbackCapture.data.capture.id,
    });
    await waitPending("pendingSave");
    await control("approveSave");
    assert.equal((await fallbackSave).data.outcome, "saved");
    const fallbackRecord = (await control("savedAccounts")).items.find(
      (item) => item.username === "no-icon-fictional@example.test",
    );
    assert.equal(fallbackRecord.favicon, "");
    assert.equal(fallbackRecord.password, "Fictional-favicon-fallback!");
  } finally {
    await worker.evaluate(() => {
      globalThis.fetch = globalThis.__originalFaviconFetch;
      delete globalThis.__originalFaviconFetch;
    });
  }
  check("Missing favicon cache never blocks saving a login");

  const legacyPopup = await context.newPage();
  await legacyPopup.addInitScript(() => {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (message) =>
      message.type === "state"
        ? Promise.resolve({
            ok: true,
            data: { paired: true, site: "https://example.test" },
          })
        : original(message);
  });
  await legacyPopup.goto(`chrome-extension://${id}/popup.html`);
  await legacyPopup
    .getByRole("heading", { name: "Finish updating PassWards", exact: true })
    .waitFor();
  assert.equal(
    await legacyPopup
      .getByRole("button", { name: "Reload extension", exact: true })
      .isVisible(),
    true,
  );
  assert.equal(
    await legacyPopup
      .getByRole("button", { name: "Save entered login", exact: true })
      .count(),
    0,
  );
  await legacyPopup.screenshot({
    path: path.join(root, "artifacts/extension-version-recovery.png"),
    clip: { x: 0, y: 0, width: 352, height: 320 },
  });
  await legacyPopup.close();
  await page.bringToFront();
  check(
    "Old background/new popup mismatch shows explicit reload recovery instead of Request declined",
  );

  await page.goto(site + "/login");
  await page
    .getByLabel("Email", { exact: true })
    .fill("lock-fictional@example.test");
  await page
    .getByLabel("Password", { exact: true })
    .fill("Locked-save-never-written!");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  for (let n = 0; n < 50; n++) {
    captured = (await message({ type: "state" })).data.capture;
    if (captured?.status === "ready") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  saving = message({ type: "saveLogin", id: captured.id });
  await waitPending("pendingSave");
  await control("lock");
  assert.equal((await saving).error, "locked");
  assert.equal((await control("pendingSave")).pending, null);
  check("Locking the vault cancels a pending save before it can write");
  assert.equal((await message({ type: "matches" })).error, "locked");
  await control("unlock");
  check("Native vault lock blocks extension");
  assert.equal(
    await worker.evaluate(
      async () => (await chrome.storage.local.get("token")).token,
    ),
    originalToken,
  );
  await context.close();
  context = undefined;
  worker = await launchBrowser();
  popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  page = await context.newPage();
  await page.goto(site + "/login");
  await page.bringToFront();
  assert.equal((await message({ type: "state" })).data.paired, true);
  assert.equal(
    await worker.evaluate(
      async () => (await chrome.storage.local.get("token")).token,
    ),
    originalToken,
  );
  assert.equal((await message({ type: "matches" })).ok, true);
  await page.waitForSelector("#passward-assistant", { state: "attached" });
  check(
    "Browser restart preserves pairing and automatic detection; locking the app never clears the token",
  );
  await control("revoke");
  assert.equal((await message({ type: "matches" })).error, "browserUnpaired");
  assert.equal(
    await worker.evaluate(
      async () => (await chrome.storage.local.get("token")).token,
    ),
    undefined,
  );
  assert.equal((await message({ type: "state" })).data.paired, false);
  check(
    "Desktop revocation blocks and clears the browser token; only a new pairing can reconnect",
  );
  await mkdir(path.join(root, "artifacts"), { recursive: true });
  await page.screenshot({
    path: path.join(root, "artifacts/extension-fixture-page.png"),
  });
  console.log(`${checks} browser extension integration checks passed.`);
} finally {
  if (context) await context.close();
  if (fixture) {
    fixture.stdin.end();
    fixture.kill();
  }
  for (const registryKey of [key, edgeKey])
    try {
      execFileSync("reg.exe", ["DELETE", registryKey, "/f"], {
        windowsHide: true,
        stdio: "pipe",
      });
    } catch {}
  await new Promise((r) => server.close(r));
  await new Promise((r) => other.close(r));
  await rm(temp, { recursive: true, force: true });
}
