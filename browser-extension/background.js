import { createLoginCapture } from "./capture.js";
const HOST = "com.passward.bridge";
let port;
let queue = Promise.resolve();
let filling = false;
const manualDocuments = new Map();
const captureDocuments = new Map();
const autoOpenedDocuments = new Map();
const autoOpenedCaptures = new Map();
const ready = Promise.all([
  chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
  chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
]);
function origin(url) {
  const u = new URL(url);
  if (!["https:", "http:"].includes(u.protocol) || u.username || u.password)
    throw Error("unsupported");
  return u.origin;
}
function pattern(url) {
  const u = new URL(url);
  return `${u.protocol}//${u.hostname}/*`;
}
async function native(op, extra = {}) {
  await ready;
  const execute = async () => {
    const { token } = await chrome.storage.local.get("token");
    if (!port) {
      port = chrome.runtime.connectNative(HOST);
      port.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        port = undefined;
      });
    }
    const current = port;
    return new Promise((resolve, reject) => {
      const clear = () => {
        clearTimeout(timer);
        current.onMessage.removeListener(reply);
        current.onDisconnect.removeListener(disconnected);
      };
      const reply = (result) => {
        clear();
        if (result?.ok && ["pair", "autoConnect"].includes(op)) {
          void chrome.storage.local
            .set({ token: result.data.token })
            .then(() => resolve(result.data), reject);
        } else if (result?.ok) resolve(result.data);
        else if (result?.error === "browserUnpaired") {
          void chrome.storage.local
            .remove("token")
            .catch(() => {})
            .then(() => reject(Error("browserUnpaired")));
        } else reject(Error(result?.error || "browserUnavailable"));
      };
      const disconnected = () => {
        void chrome.runtime.lastError;
        clear();
        reject(Error("browserOffline"));
      };
      const timer = setTimeout(() => {
        clear();
        current.disconnect();
        port = undefined;
        reject(Error("browserOffline"));
      }, 12000);
      current.onMessage.addListener(reply);
      current.onDisconnect.addListener(disconnected);
      try {
        current.postMessage({
          v: 1,
          requestId: crypto.randomUUID(),
          op,
          token,
          ...extra,
        });
      } catch {
        disconnected();
      }
    });
  };
  const result = queue.then(execute, execute);
  queue = result.catch(() => {});
  return result;
}
async function inject(tab, expectedDocument) {
  origin(tab.url);
  if (tab.pendingUrl) throw Error("pageChanged");
  const result = await chrome.scripting.executeScript({
    target: { tabId: tab.id, frameIds: [0] },
    files: ["content.js"],
  });
  const documentId = result[0]?.documentId;
  if (!documentId || (expectedDocument && expectedDocument !== documentId))
    throw Error("pageChanged");
  return documentId;
}
async function inspect(tab, documentId) {
  const result = await chrome.scripting.executeScript({
    target: { tabId: tab.id, documentIds: [documentId] },
    func: () => globalThis.__passward?.detect() || null,
  });
  if (result[0]?.documentId !== documentId || !result[0]?.result)
    throw Error("noForm");
  return result[0].result;
}
async function validate(tabId, documentId, site) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.pendingUrl || origin(tab.url) !== site) throw Error("pageChanged");
  await inspect(tab, documentId);
  return tab;
}
async function source(
  sender,
  contentAllowed = false,
  requireForm = true,
  submitting = false,
) {
  if (sender.id !== chrome.runtime.id) throw Error("browserDenied");
  if (sender.url === chrome.runtime.getURL("popup.html")) {
    const [tab] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    if (!tab?.id) throw Error("unsupported");
    const documentId = await inject(tab);
    const current = await chrome.tabs.get(tab.id);
    if (current.pendingUrl || origin(current.url) !== origin(tab.url))
      throw Error("pageChanged");
    manualDocuments.set(tab.id, documentId);
    captureDocuments.set(tab.id, {
      documentId,
      site: origin(tab.url),
      expiresAt: Date.now() + 120000,
    });
    return { tab, documentId, site: origin(tab.url) };
  }
  if (
    !contentAllowed ||
    !sender.tab?.id ||
    sender.frameId !== 0 ||
    !sender.documentId
  )
    throw Error("browserDenied");
  const tab = await chrome.tabs.get(sender.tab.id);
  const site = origin(tab.url);
  if (
    origin(sender.url) !== site ||
    (tab.pendingUrl && !(submitting && origin(tab.pendingUrl) === site))
  )
    throw Error("pageChanged");
  const permitted = await chrome.permissions.contains({
    origins: [pattern(tab.url)],
  });
  const prior = captureDocuments.get(tab.id);
  const recentSubmission =
    submitting &&
    prior?.documentId === sender.documentId &&
    prior.site === site &&
    prior.expiresAt > Date.now();
  if (
    !permitted &&
    manualDocuments.get(tab.id) !== sender.documentId &&
    !recentSubmission
  )
    throw Error("browserDenied");
  if (requireForm) await inspect(tab, sender.documentId);
  return { tab, site, documentId: sender.documentId };
}
async function matches(context) {
  await inspect(context.tab, context.documentId);
  const result = await native("matches", { origin: context.site });
  await validate(context.tab.id, context.documentId, context.site);
  return result.accounts;
}
async function fill(context, id) {
  if (filling) throw Error("browserBusy");
  filling = true;
  let pending;
  try {
    const accounts = await matches(context);
    if (!accounts.some((a) => a.id === id)) throw Error("browserOrigin");
    pending = await native("requestFill", { id, origin: context.site });
    await chrome.storage.session.set({
      fillState: { tabId: context.tab.id, state: "waiting" },
    });
    const until = Date.now() + 90000;
    while (Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      await validate(context.tab.id, context.documentId, context.site);
      const credentials = await native("takeFill", { id: pending.id });
      if (credentials.pending) continue;
      try {
        if (credentials.origin !== context.site) throw Error("browserOrigin");
        const tab = await validate(
          context.tab.id,
          context.documentId,
          context.site,
        );
        const { autoSubmit = false } =
          await chrome.storage.local.get("autoSubmit");
        const result = await chrome.scripting.executeScript({
          target: { tabId: tab.id, documentIds: [context.documentId] },
          func: (site, username, password, autoSubmit) =>
            globalThis.__passward?.fill(site, username, password, autoSubmit) ||
            false,
          args: [
            context.site,
            credentials.username,
            credentials.password,
            autoSubmit === true,
          ],
        });
        if (
          result[0]?.result !== true ||
          result[0]?.documentId !== context.documentId
        )
          throw Error("noForm");
        await chrome.storage.session.set({
          fillState: { tabId: tab.id, state: "filled" },
        });
        await chrome.tabs.update(tab.id, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
        return { filled: true };
      } finally {
        credentials.username = "";
        credentials.password = "";
      }
    }
    throw Error("browserExpired");
  } finally {
    filling = false;
    if (pending) await native("cancelFill", { id: pending.id }).catch(() => {});
  }
}
const captures = createLoginCapture({ native, source, origin });
function getBrowserName() {
  if (navigator.userAgent.includes("Edg/")) return "Edge";
  if (navigator.brave && typeof navigator.brave.isBrave === "function")
    return "Brave";
  return "Chrome";
}
async function handle(message, sender) {
  await ready;
  const popup =
    sender.id === chrome.runtime.id &&
    sender.url === chrome.runtime.getURL("popup.html");
  if (message?.type === "autoConnect" && popup) {
    const browser = message.browser || getBrowserName();
    const result = await native("autoConnect", { browser });
    return { paired: true, token: result.token };
  }
  if (message?.type === "pair" && popup) {
    const { token } = await chrome.storage.local.get("token");
    if (token) return { paired: true };
    const code = String(message.code || "");
    if (!/^\d{6}$/.test(code)) throw Error("browserPairCode");
    await native("pair", {
      code,
      browser: message.browser || getBrowserName(),
    });
    return { paired: true };
  }
  if (
    message?.type === "focus" &&
    (popup || (sender.id === chrome.runtime.id && sender.frameId === 0))
  ) {
    await source(sender, true).catch(() => {});
    return native("focus");
  }
  if (message?.type === "state" && popup) {
    const { token } = await chrome.storage.local.get("token");
    const [tab] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    let site;
    try {
      site = origin(tab?.url);
    } catch {}
    const { fillState, saveState } = await chrome.storage.session.get([
      "fillState",
      "saveState",
    ]);
    return {
      bridgeApi: 7,
      paired: !!token,
      capture: captures.state(tab?.id, site),
      saveState:
        saveState?.tabId === tab?.id &&
        saveState.origin === site &&
        saveState.expiresAt > Date.now()
          ? saveState
          : null,
      site,
      tabId: tab?.id,
      fillState: fillState?.tabId === tab?.id ? fillState : null,
    };
  }
  if (message?.type === "pageSettings") {
    await source(sender, true, false);
    const { token } = await chrome.storage.local.get("token");
    return { hidden: false, paired: !!token };
  }
  if (["openLoginPopup", "openSavePopup"].includes(message?.type) && !popup) {
    const saving = message.type === "openSavePopup";
    const context = await source(sender, true, !saving);
    const capture = saving
      ? captures.state(context.tab.id, context.site)
      : null;
    if (
      saving &&
      (!capture?.automatic ||
        capture.id !== message.id ||
        ["checking", "waiting"].includes(capture.status))
    )
      throw Error("browserExpired");
    const { token } = await chrome.storage.local.get("token");
    const key = saving
      ? capture.id
      : context.documentId + ":" + context.tab.url;
    const opened = saving ? autoOpenedCaptures : autoOpenedDocuments;
    if (!token || !context.tab.active || opened.get(context.tab.id) === key)
      return { opened: false, attempted: opened.get(context.tab.id) === key };
    const window = await chrome.windows.get(context.tab.windowId);
    if (!window.focused) return { opened: false, attempted: false };
    opened.set(context.tab.id, key);
    try {
      await chrome.action.openPopup({ windowId: context.tab.windowId });
      return { opened: true, attempted: true };
    } catch {
      return { opened: false, attempted: true };
    }
  }
  if (
    [
      "captureLogin",
      "captureUsername",
      "captureCurrent",
      "captureState",
      "saveLogin",
      "dismissLogin",
    ].includes(message?.type)
  )
    return captures.handle(message, sender, popup);
  if (!["matches", "detect", "fill"].includes(message?.type))
    throw Error("browserDenied");
  const context = await source(sender, true);
  if (message.type === "fill") return fill(context, String(message.id));
  const accounts = await matches(context);
  if (message.type === "detect") {
    await chrome.action.setBadgeText({
      tabId: context.tab.id,
      text: captures.state(context.tab.id, context.site)
        ? "Save"
        : accounts.length
          ? String(accounts.length)
          : "",
    });
    await chrome.action.setBadgeBackgroundColor({
      tabId: context.tab.id,
      color: "#45464a",
    });
  }
  return { accounts, site: context.site };
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  handle(message, sender)
    .then((data) => respond({ ok: true, data }))
    .catch(async (error) => {
      if (message?.type === "fill")
        await chrome.storage.session
          .set({
            fillState: {
              tabId: sender.tab?.id,
              state: "error",
              error: error.message,
            },
          })
          .catch(() => {});
      respond({ ok: false, error: error.message || "browserUnavailable" });
    });
  return true;
});
// Remove the optional-site registration used by older releases. Static scripts now run automatically.
async function removeLegacyScripts() {
  await chrome.scripting
    .unregisterContentScripts({ ids: ["passward-login"] })
    .catch(() => {});
}
chrome.runtime.onInstalled.addListener(() => void removeLegacyScripts());
chrome.runtime.onStartup.addListener(() => void removeLegacyScripts());
chrome.tabs.onRemoved.addListener((id) => {
  autoOpenedDocuments.delete(id);
  autoOpenedCaptures.delete(id);
  manualDocuments.delete(id);
  captureDocuments.delete(id);
});
chrome.tabs.onUpdated.addListener((id, change) => {
  if (change.status === "loading") {
    autoOpenedDocuments.delete(id);
    manualDocuments.delete(id);
    void chrome.action.setBadgeText({ tabId: id, text: "" });
  }
});
