const HOST = "com.passward.bridge";
let port;
let queue = Promise.resolve();
let filling = false;
const manualDocuments = new Map();
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
        result?.ok
          ? resolve(result.data)
          : reject(Error(result?.error || "browserUnavailable"));
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
async function source(sender, contentAllowed = false) {
  if (sender.id !== chrome.runtime.id) throw Error("browserDenied");
  if (sender.url === chrome.runtime.getURL("popup.html")) {
    const [tab] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    if (!tab?.id) throw Error("unsupported");
    const documentId = await inject(tab);
    manualDocuments.set(tab.id, documentId);
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
  if (origin(sender.url) !== site || tab.pendingUrl) throw Error("pageChanged");
  const permitted = await chrome.permissions.contains({
    origins: [pattern(tab.url)],
  });
  if (!permitted && manualDocuments.get(tab.id) !== sender.documentId)
    throw Error("browserDenied");
  await inspect(tab, sender.documentId);
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
        const result = await chrome.scripting.executeScript({
          target: { tabId: tab.id, documentIds: [context.documentId] },
          func: (site, username, password) =>
            globalThis.__passward?.fill(site, username, password) || false,
          args: [context.site, credentials.username, credentials.password],
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
async function handle(message, sender) {
  await ready;
  const popup =
    sender.id === chrome.runtime.id &&
    sender.url === chrome.runtime.getURL("popup.html");
  if (message?.type === "pair" && popup) {
    const code = String(message.code || "");
    if (!/^\d{6}$/.test(code)) throw Error("browserPairCode");
    const result = await native("pair", { code, browser: message.browser });
    await chrome.storage.local.set({ token: result.token });
    return { paired: true };
  }
  if (message?.type === "disconnect" && popup) {
    await chrome.storage.local.remove("token");
    return {};
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
    const { fillState } = await chrome.storage.session.get("fillState");
    return {
      paired: !!token,
      site,
      tabId: tab?.id,
      fillState: fillState?.tabId === tab?.id ? fillState : null,
    };
  }
  if (!["matches", "detect", "fill"].includes(message?.type))
    throw Error("browserDenied");
  const context = await source(sender, true);
  if (message.type === "fill") return fill(context, String(message.id));
  const accounts = await matches(context);
  if (message.type === "detect") {
    await chrome.action.setBadgeText({
      tabId: context.tab.id,
      text: accounts.length ? String(accounts.length) : "",
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
async function syncScripts() {
  const { origins = [] } = await chrome.permissions.getAll();
  const matches = origins.filter((p) => /^https?:\/\//.test(p));
  await chrome.scripting.unregisterContentScripts().catch(() => {});
  if (matches.length)
    await chrome.scripting.registerContentScripts([
      {
        id: "passward-login",
        matches,
        js: ["content.js"],
        runAt: "document_idle",
        allFrames: false,
        persistAcrossSessions: true,
      },
    ]);
}
chrome.runtime.onInstalled.addListener(() => void syncScripts());
chrome.permissions.onAdded.addListener(() => void syncScripts());
chrome.permissions.onRemoved.addListener(() => void syncScripts());
chrome.tabs.onRemoved.addListener((id) => manualDocuments.delete(id));
chrome.tabs.onUpdated.addListener((id, change) => {
  if (change.status === "loading") {
    manualDocuments.delete(id);
    void chrome.action.setBadgeText({ tabId: id, text: "" });
  }
});
