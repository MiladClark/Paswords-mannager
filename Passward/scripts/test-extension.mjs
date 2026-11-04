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
const temp = await mkdtemp(path.join(tmpdir(), "passward-extension-test-"));
const key =
  "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.passward.fixture";
const edgeKey =
  "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.passward.fixture";
const pendingLines = [],
  waiters = [];
let fixture, context;
let checks = 0;
const html = (kind) =>
  `<!doctype html><html lang="en"><head><title>Fictional test login</title></head><body><h1>Sign in</h1>${kind === "iframe" ? '<iframe src="/login"></iframe>' : kind === "search" ? '<input type="search" name="search">' : `<form action="${kind === "cross" ? "http://localhost:65500/login" : "/login"}"><label>Email<input type="email" name="email" autocomplete="username"></label>${kind === "username" ? "" : `<label>Password<input type="password" name="password" autocomplete="${kind === "signup" ? "new-password" : "current-password"}"></label>`}${kind === "signup" ? '<input type="password" autocomplete="new-password">' : ""}<input type="password" name="hidden-password" style="display:none"><button type="submit">${kind === "username" ? "Continue" : "Sign in"}</button></form>`}<script>window.submitted=false;document.querySelector('form')?.addEventListener('submit',e=>{e.preventDefault();window.submitted=true;});document.addEventListener('input',()=>window.inputs=(window.inputs||0)+1);</script></body></html>`;
const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(html((req.url || "").split("?")[0].slice(1)));
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
async function waitPending() {
  for (let n = 0; n < 80; n++) {
    const result = await control("pending");
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
  const executable = path.join(
    root,
    "src-tauri/target/debug/examples/browser_fixture.exe",
  );
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
  context = await chromium.launchPersistentContext(path.join(temp, "profile"), {
    channel,
    headless: true,
    env,
    ignoreDefaultArgs: channel === "chrome" ? ["--disable-extensions"] : [],
    args:
      channel === "chrome"
        ? ["--enable-unsafe-extension-debugging"]
        : [
            `--disable-extensions-except=${extension}`,
            `--load-extension=${extension}`,
          ],
  });
  if (channel === "chrome") {
    const session = await context.browser().newBrowserCDPSession();
    await session.send("Extensions.loadUnpacked", { path: extension });
  }
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker", { timeout: 20000 }));
  const id = new URL(worker.url()).host;
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  const page = await context.newPage();
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
  await popup.getByRole("button", { name: "پرکردن", exact: true }).waitFor();
  assert.deepEqual(
    (
      await new AxeBuilder({ page: popup })
        .withTags(["wcag2a", "wcag2aa"])
        .analyze()
    ).violations,
    [],
  );
  check("Popup: light/dark accessibility and Persian RTL");
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
  await control("lock");
  assert.equal((await message({ type: "matches" })).error, "locked");
  await control("unlock");
  check("Native vault lock blocks extension");
  await control("revoke");
  assert.equal((await message({ type: "matches" })).error, "browserUnpaired");
  check("Desktop revocation blocks the stored browser token");
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
