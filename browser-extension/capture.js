// Transient credentials only. Never persist captured passwords in extension storage.
export function createLoginCapture({ native, source, origin }) {
  const captures = new Map();
  const usernames = new Map();
  const lifetime = 120_000;
  async function siteIcon(context) {
    try {
      const tab = await chrome.tabs.get(context.tab.id);
      if (!tab.favIconUrl || tab.pendingUrl || origin(tab.url) !== context.site)
        return "";
      // Read the browser's local favicon cache. Never contact a favicon provider.
      const address = new URL(chrome.runtime.getURL("/_favicon/"));
      address.searchParams.set("pageUrl", tab.url);
      address.searchParams.set("size", "32");
      const response = await fetch(address, {
        signal: AbortSignal.timeout(1200),
      });
      if (!response.ok) return "";
      const blob = await response.blob();
      if (blob.size < 24 || blob.size > 65_536) return "";
      // Chromium's local favicon response may omit Content-Type. Check bytes.
      const sourceBytes = new Uint8Array(await blob.arrayBuffer());
      const signature = [137, 80, 78, 71, 13, 10, 26, 10];
      if (!signature.every((value, index) => sourceBytes[index] === value))
        return "";
      const header = new DataView(sourceBytes.buffer);
      if (
        !header.getUint32(16) ||
        !header.getUint32(20) ||
        header.getUint32(16) > 128 ||
        header.getUint32(20) > 128
      )
        return "";
      const bitmap = await createImageBitmap(blob);
      try {
        const canvas = new OffscreenCanvas(32, 32);
        canvas.getContext("2d").drawImage(bitmap, 0, 0, 32, 32);
        const normalized = await canvas.convertToBlob({ type: "image/png" });
        const bytes = new Uint8Array(await normalized.arrayBuffer());
        if (bytes.length > 8192) return "";
        const current = await chrome.tabs.get(tab.id);
        if (current.pendingUrl || origin(current.url) !== context.site)
          return "";
        return "data:image/png;base64," + btoa(String.fromCharCode(...bytes));
      } finally {
        bitmap.close();
      }
    } catch {
      return "";
    }
  }
  function forget(tabId) {
    const item = captures.get(tabId);
    if (item) {
      item.password = "";
      captures.delete(tabId);
    }
  }
  function clean() {
    const now = Date.now();
    for (const [tabId, item] of captures)
      if (item.expiresAt <= now) forget(tabId);
    for (const [tabId, item] of usernames)
      if (item.expiresAt <= now) usernames.delete(tabId);
  }
  function state(tabId, site) {
    clean();
    const item = captures.get(tabId);
    if (!item || item.origin !== site) return null;
    const { password: _password, ...metadata } = item;
    return metadata;
  }
  async function badge(tabId, text) {
    await chrome.action.setBadgeText({ tabId, text }).catch(() => {});
    await chrome.action
      .setBadgeBackgroundColor({ tabId, color: "#45464a" })
      .catch(() => {});
  }
  async function classify(tabId, item) {
    try {
      const result = await native("checkLogin", {
        origin: item.origin,
        username: item.username,
        password: item.password,
      });
      if (captures.get(tabId) !== item) return;
      if (result.kind === "unchanged") {
        forget(tabId);
        await badge(tabId, "");
        return;
      }
      item.kind = result.kind;
      item.accounts = result.accounts;
      item.status = "ready";
      item.error = null;
      await badge(tabId, result.kind === "update" ? "Edit" : "Save");
    } catch (error) {
      if (captures.get(tabId) !== item) return;
      item.status = "error";
      item.error =
        error.message === "browserDenied"
          ? "browserCaptureDenied"
          : error.message;
      await badge(tabId, "!");
    }
  }
  async function store(context, candidate, automatic = false) {
    clean();
    if (candidate.origin !== context.site) throw Error("pageChanged");
    let username =
      typeof candidate.username === "string" ? candidate.username : "";
    const password = candidate.password;
    if (
      typeof password !== "string" ||
      !password ||
      new TextEncoder().encode(password).length > 4096 ||
      new TextEncoder().encode(username).length > 2048
    )
      throw Error("invalidEntry");
    const previous = usernames.get(context.tab.id);
    if (!username && previous?.origin === context.site)
      username = previous.username;
    if (captures.size >= 20 && !captures.has(context.tab.id))
      forget(captures.keys().next().value);
    forget(context.tab.id);
    const item = {
      id: crypto.randomUUID(),
      origin: context.site,
      username,
      password,
      kind: "save",
      automatic,
      accounts: [],
      status: "checking",
      error: null,
      expiresAt: Date.now() + lifetime,
    };
    captures.set(context.tab.id, item);
    usernames.delete(context.tab.id);
    await classify(context.tab.id, item);
    return state(context.tab.id, context.site);
  }
  async function handle(message, sender, popup) {
    const context = await source(
      sender,
      true,
      false,
      ["captureLogin", "captureUsername"].includes(message.type),
    );
    const tabId = context.tab.id;
    if (message.type === "captureUsername") {
      if (
        popup ||
        typeof message.username !== "string" ||
        message.username.length > 2048
      )
        throw Error("browserDenied");
      usernames.set(tabId, {
        origin: context.site,
        username: message.username,
        expiresAt: Date.now() + lifetime,
      });
      return {};
    }
    if (message.type === "captureCurrent") {
      if (!popup) throw Error("browserDenied");
      const result = await chrome.scripting.executeScript({
        target: { tabId, documentIds: [context.documentId] },
        func: () =>
          globalThis.__passward?.version === 3 &&
          typeof globalThis.__passward.captureManual === "function"
            ? globalThis.__passward.captureManual()
            : { pageReloadRequired: true },
      });
      const candidate = result[0]?.result;
      if (candidate?.pageReloadRequired) throw Error("pageReloadRequired");
      if (!candidate || result[0]?.documentId !== context.documentId)
        throw Error("noForm");
      const current = await chrome.tabs.get(tabId);
      if (current.pendingUrl || origin(current.url) !== context.site)
        throw Error("pageChanged");
      return { capture: await store(context, candidate) };
    }
    if (message.type === "captureLogin") {
      if (popup) throw Error("browserDenied");
      return { capture: await store(context, message, true) };
    }
    if (message.type === "captureState")
      return { capture: state(tabId, context.site) };
    return saveOrDismiss(context, message);
  }
  async function saveOrDismiss(context, message) {
    const tabId = context.tab.id;
    const metadata = state(tabId, context.site);
    const item = captures.get(tabId);
    if (!metadata || message.id !== item.id) throw Error("browserExpired");
    if (message.type === "dismissLogin") {
      forget(tabId);
      await badge(tabId, "");
      return {};
    }
    if (message.type !== "saveLogin") throw Error("browserDenied");
    if (item.status === "waiting") throw Error("browserBusy");
    // Re-check after unlocking and immediately before the approval request.
    await classify(tabId, item);
    if (captures.get(tabId) !== item) return { outcome: "unchanged" };
    if (item.status !== "ready")
      throw Error(item.error || "browserUnavailable");
    const pending = await native("requestSave", {
      origin: item.origin,
      username: item.username,
      password: item.password,
      favicon: await siteIcon(context),
    });
    if (pending.kind === "unchanged") {
      forget(tabId);
      return { outcome: "unchanged" };
    }
    item.status = "waiting";
    item.password = "";
    try {
      const until = Date.now() + lifetime;
      while (Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        if (captures.get(tabId) !== item) throw Error("browserDenied");
        const result = await native("takeSave", { id: pending.id });
        if (result.pending) continue;
        item.status = result.outcome;
        await chrome.storage.session.set({
          saveState: {
            tabId,
            origin: item.origin,
            outcome: result.outcome,
            expiresAt: Date.now() + 90000,
          },
        });
        await badge(tabId, "");
        return result;
      }
      throw Error("browserExpired");
    } finally {
      forget(tabId);
      await native("cancelSave", { id: pending.id }).catch(() => {});
    }
  }
  chrome.tabs.onRemoved.addListener((tabId) => {
    forget(tabId);
    usernames.delete(tabId);
  });
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (!change.url) return;
    let site;
    try {
      site = origin(change.url);
    } catch {}
    if (captures.get(tabId)?.origin !== site) forget(tabId);
    if (usernames.get(tabId)?.origin !== site) usernames.delete(tabId);
  });
  chrome.permissions.onRemoved.addListener(() => {
    for (const id of captures.keys()) forget(id);
    usernames.clear();
  });
  setInterval(clean, 5000);
  return {
    handle,
    state,
    clear() {
      for (const id of captures.keys()) forget(id);
      usernames.clear();
    },
  };
}
