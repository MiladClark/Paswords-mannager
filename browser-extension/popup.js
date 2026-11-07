const words = {
  en: {
    open: "Open PassWards",
    refresh: "Refresh",
    synced: "Synced",
    connected: "Connected",
    locked: "Locked",
    offline: "Closed",
    checking: "Checking…",
    vaultLocked: "PassWards is locked",
    vaultLockedDesc:
      "Unlock your vault in PassWards to view and autofill logins.",
    unlockAction: "Unlock in PassWards",
    appClosed: "PassWards is closed",
    appClosedDesc:
      "Open the desktop app to automatically connect and sync your vault.",
    launchAction: "Launch PassWards",
    fill: "Fill",
    filling: "Filling…",
    filled: "Filled. You can sign in.",
    noAccounts: "No saved accounts for this site.",
    captureCurrent: "Save entered login",
    noForm: "No supported login form detected.",
    unsupported: "Open a website with a login form.",
    saveLogin: "Save this login?",
    updateLogin: "Update the saved password?",
    reviewSave: "Save",
    reviewUpdate: "Update",
    notNow: "Not now",
    saved: "Login saved in your vault.",
    updated: "Password updated in your vault.",
    unchanged: "This login is already saved.",
    waiting: "Approve this request in PassWards.",
    browserUnavailable:
      "Connection unavailable. Make sure PassWards is installed.",
    browserOrigin: "This account does not match the active site.",
    pageChanged: "The page changed. Please refresh and try again.",
    browserBusy: "Finish the pending request in PassWards first.",
    searchPlaceholder: "Search logins for this site",
    reloadTitle: "Finish updating PassWards",
    reloadHint:
      "The popup and background service are running different versions. Reload the extension to finish the update, then open it again.",
    reloadAction: "Reload extension",
    noFormHint:
      "PassWards supports visible sign-in fields, including username-first pages. Cross-site frames and sign-up forms are excluded.",
    settingFailed: "Could not save this setting. Try again.",
  },
  fa: {
    open: "باز کردن PassWards",
    refresh: "تازه‌سازی",
    synced: "سینک",
    connected: "متصل",
    locked: "قفل",
    offline: "بسته",
    checking: "بررسی…",
    vaultLocked: "خزانه قفل است",
    vaultLockedDesc:
      "برای پرکردن خودکار رمزها، قفل خزانه را در اپ دسکتاپ باز کنید.",
    unlockAction: "باز کردن قفل در اپ",
    appClosed: "PassWards بسته است",
    appClosedDesc:
      "برای اتصال خودکار و دسترسی به رمزها، برنامهٔ پس‌وارد را باز کنید.",
    launchAction: "اجرای PassWards",
    fill: "پرکردن",
    filling: "در حال پرکردن…",
    filled: "فرم پر شد؛ می‌توانید وارد شوید.",
    noAccounts: "حسابی برای این سایت ذخیره نشده است.",
    captureCurrent: "ذخیرهٔ ورود فعلی",
    noForm: "فرم ورود مناسبی در این صفحه پیدا نشد.",
    unsupported: "یک سایت با فرم ورود را باز کنید.",
    saveLogin: "این ورود ذخیره شود؟",
    updateLogin: "رمز عبور به‌روزرسانی شود؟",
    reviewSave: "ذخیره",
    reviewUpdate: "به‌روزرسانی",
    notNow: "فعلاً نه",
    saved: "ورود در خزانه ذخیره شد.",
    updated: "رمز عبور در خزانه به‌روز شد.",
    unchanged: "این ورود قبلاً ذخیره شده است.",
    waiting: "درخواست را در اپ تأیید کنید.",
    browserUnavailable: "ارتباط با اپ برقرار نشد.",
    browserOrigin: "این حساب با سایت فعلی تطابق ندارد.",
    pageChanged: "صفحه تغییر کرد. لطفاً تازه‌سازی کنید.",
    browserBusy: "درخواست قبلی را در اپ نهایی کنید.",
    searchPlaceholder: "جستجوی حساب‌های این سایت",
    reloadTitle: "به‌روزرسانی افزونه",
    reloadHint:
      "نسخهٔ جدید اپ نصب شده است. برای اتمام، افزونه را مجدداً لود کنید.",
    reloadAction: "لود مجدد افزونه",
    noFormHint:
      "فیلدهای قابل‌مشاهدهٔ ورود، از جمله ورود چندمرحله‌ای، پشتیبانی می‌شوند. فرم ثبت‌نام و فریم سایت دیگر کنار گذاشته می‌شوند.",
    settingFailed: "ذخیرهٔ تنظیم انجام نشد. دوباره امتحان کنید.",
  },
};

const PERSIAN_ENABLED = false;
let { language = "en", theme } = await chrome.storage.local.get([
  "language",
  "theme",
]);
if (!PERSIAN_ENABLED) language = "en";
theme ||= matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";

const content = document.querySelector("#content");
const statusEl = document.querySelector("#status");
const errorBanner = document.querySelector("#error");
const connectionBadge = document.querySelector("#connection-badge");
const badgeLabel = connectionBadge.querySelector(".status-label");
const siteBar = document.querySelector("#site-bar");
const siteDomain = document.querySelector("#site-domain");
const siteFavicon = document.querySelector("#site-favicon");
const siteMonogram = document.querySelector("#site-monogram");
const siteAccountCount = document.querySelector("#site-account-count");
const openBtn = document.querySelector("#open");
const refreshBtn = document.querySelector("#refresh");
const themeBtn = document.querySelector("#theme");
const langBtn = document.querySelector("#language");

const t = (key) => words[language]?.[key] || words.en[key] || key;

function getBrowserName() {
  if (navigator.userAgent.includes("Edg/")) return "Edge";
  if (navigator.brave && typeof navigator.brave.isBrave === "function")
    return "Brave";
  return "Chrome";
}

function element(tag, text, className) {
  const el = document.createElement(tag);
  if (text) el.textContent = text;
  if (className) el.className = className;
  return el;
}

function showError(msg) {
  errorBanner.hidden = false;
  errorBanner.textContent = t(msg === "browserOffline" ? "appClosed" : msg);
}

function clearError() {
  errorBanner.hidden = true;
  errorBanner.textContent = "";
}

async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw Error(response?.error || "browserUnavailable");
  return response.data;
}

function applyThemeAndLang() {
  document.documentElement.lang = language;
  document.documentElement.dir = language === "fa" ? "rtl" : "ltr";
  document.documentElement.dataset.theme = theme;
  langBtn.hidden = !PERSIAN_ENABLED;
  langBtn.textContent = language === "en" ? "فا" : "EN";
  openBtn.querySelector("span").textContent = t("open");
}

function updateConnectionPill(statusType, labelText) {
  connectionBadge.className = "connection-pill " + statusType;
  badgeLabel.textContent = labelText;
}

function renderOfferCard(capture) {
  const card = element("section", null, "offer-card");
  const header = element("div", null, "offer-header");
  header.append(
    element(
      "h1",
      t(capture.kind === "update" ? "updateLogin" : "saveLogin"),
      "offer-title",
    ),
    element("p", capture.username || siteDomain.textContent, "offer-sub"),
  );

  const actions = element("div", null, "offer-actions");
  const saveBtn = element(
    "button",
    t(capture.kind === "update" ? "reviewUpdate" : "reviewSave"),
    "btn-primary",
  );
  saveBtn.type = "button";
  saveBtn.disabled = ["checking", "waiting"].includes(capture.status);

  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    clearError();
    statusEl.textContent = t("waiting");
    try {
      await send({ type: "saveLogin", id: capture.id });
      await load();
    } catch (err) {
      showError(err.message);
      saveBtn.disabled = false;
    }
  });

  const dismissBtn = element("button", t("notNow"), "btn-secondary");
  dismissBtn.type = "button";
  dismissBtn.addEventListener("click", async () => {
    await send({ type: "dismissLogin", id: capture.id }).catch(() => {});
    await load();
  });

  actions.append(saveBtn, dismissBtn);
  card.append(header, actions);
  content.append(card);
}

async function load() {
  applyThemeAndLang();
  clearError();
  content.replaceChildren();
  siteBar.hidden = true;
  statusEl.textContent = t("checking");

  updateConnectionPill("checking", t("checking"));

  let state;
  try {
    state = await send({ type: "state" });
  } catch (err) {
    statusEl.textContent = "";
    updateConnectionPill("offline", t("offline"));
    showError(err.message);
    return;
  }

  if (state.bridgeApi !== 7) {
    statusEl.textContent = "";
    updateConnectionPill("offline", t("offline"));
    const card = element("div", null, "state-card");
    card.append(element("h2", t("reloadTitle")), element("p", t("reloadHint")));
    const reloadBtn = element("button", t("reloadAction"), "btn-primary");
    reloadBtn.addEventListener("click", () => chrome.runtime.reload());
    card.append(reloadBtn);
    content.append(card);
    return;
  }

  // Automatic connection if not yet paired
  if (!state.paired) {
    statusEl.textContent = "";
    updateConnectionPill("checking", t("checking"));
    try {
      const connectResult = await send({
        type: "autoConnect",
        browser: getBrowserName(),
      });
      if (connectResult?.paired) {
        state = await send({ type: "state" });
      }
    } catch (err) {
      statusEl.textContent = "";
      updateConnectionPill("offline", t("offline"));
      const card = element("div", null, "state-card");
      const icon = element("div", null, "state-icon");
      icon.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`;
      card.append(
        icon,
        element("h2", t("appClosed")),
        element("p", t("appClosedDesc")),
      );
      const launchBtn = element("button", t("launchAction"), "btn-primary");
      launchBtn.addEventListener("click", async () => {
        launchBtn.disabled = true;
        try {
          await send({ type: "focus" });
        } catch (e) {
          showError(e.message);
        } finally {
          launchBtn.disabled = false;
        }
      });
      card.append(launchBtn);
      content.append(card);
      return;
    }
  }

  // Set site status & connection indicator
  statusEl.textContent = state.site || t("unsupported");
  updateConnectionPill("online", t("synced"));

  // Domain Bar configuration
  if (state.site) {
    siteBar.hidden = false;
    let hostname = state.site;
    try {
      hostname = new URL(state.site).hostname;
    } catch {}
    siteDomain.textContent = hostname;
    siteMonogram.textContent = hostname.charAt(0).toUpperCase();

    try {
      const favUrl = `chrome-extension://${chrome.runtime.id}/_favicon/?pageUrl=${encodeURIComponent(state.site)}&size=32`;
      siteFavicon.src = favUrl;
      siteFavicon.onload = () => {
        siteFavicon.hidden = false;
        siteMonogram.hidden = true;
      };
      siteFavicon.onerror = () => {
        siteFavicon.hidden = true;
        siteMonogram.hidden = false;
      };
    } catch {
      siteFavicon.hidden = true;
      siteMonogram.hidden = false;
    }
  } else {
    siteBar.hidden = true;
    content.append(element("p", t("unsupported"), "notice-pill"));
    return;
  }

  // Persisted outcome message if just saved/updated
  if (state.saveState) {
    content.append(element("p", t(state.saveState.outcome), "notice-pill"));
  }

  // Save / Update capture offer
  if (state.capture) {
    renderOfferCard(state.capture);
  }

  // Fill status notifications
  if (state.fillState?.state === "waiting") {
    content.append(element("div", t("waiting"), "notice-pill"));
  } else if (state.fillState?.state === "filled") {
    content.append(element("div", t("filled"), "notice-pill"));
  }

  // Query accounts matching active site
  try {
    const { accounts } = await send({ type: "matches" });
    siteAccountCount.textContent = accounts.length
      ? String(accounts.length)
      : "";

    if (!accounts.length) {
      const emptyCard = element("div", null, "state-card");
      emptyCard.append(
        element("h2", t("noAccounts")),
        element(
          "p",
          "Enter your login and submit the form to get a save suggestion.",
        ),
      );
      content.append(emptyCard);
    }

    const accountSearch = element("input", null, "search-input");
    accountSearch.type = "search";
    accountSearch.placeholder = t("searchPlaceholder");
    accountSearch.setAttribute("aria-label", t("searchPlaceholder"));
    if (accounts.length) content.append(accountSearch);

    accountSearch.addEventListener("input", () => {
      const query = accountSearch.value.toLocaleLowerCase();
      for (const row of content.querySelectorAll(".account")) {
        row.hidden = !row.textContent.toLocaleLowerCase().includes(query);
      }
    });

    for (const account of accounts) {
      const card = element("div", null, "account account-card");
      const meta = element("div", null, "account-meta");
      const avatar = element(
        "div",
        (account.title || account.username || "P").charAt(0),
        "account-avatar",
      );
      const texts = element("div", null, "account-texts");
      texts.append(
        element("strong", account.title, "account-title"),
        element("small", account.username, "account-user"),
      );
      meta.append(avatar, texts);

      const fillBtn = element("button", t("fill"), "btn-fill");
      fillBtn.type = "button";
      fillBtn.addEventListener("click", async () => {
        clearError();
        for (const b of content.querySelectorAll("button")) b.disabled = true;
        statusEl.textContent = t("waiting");
        try {
          await send({ type: "fill", id: account.id });
          statusEl.textContent = t("filled");
        } catch (e) {
          showError(e.message);
        } finally {
          for (const b of content.querySelectorAll("button"))
            b.disabled = false;
        }
      });

      card.append(meta, fillBtn);
      content.append(card);
    }
  } catch (err) {
    if (err.message === "locked") {
      statusEl.textContent = "";
      updateConnectionPill("locked", t("locked"));
      const card = element("div", null, "state-card");
      const icon = element("div", null, "state-icon");
      icon.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;
      card.append(
        icon,
        element("h2", t("vaultLocked")),
        element("p", t("vaultLockedDesc")),
      );
      const unlockBtn = element("button", t("unlockAction"), "btn-primary");
      unlockBtn.addEventListener("click", async () => {
        await send({ type: "focus" }).catch(() => {});
      });
      card.append(unlockBtn);
      content.append(card);
      return;
    }
    if (err.message === "browserUnpaired") {
      await load();
      return;
    }
    if (!(state.capture && err.message === "noForm")) {
      if (err.message !== "noForm") {
        showError(err.message);
      }
    }
    if (err.message === "noForm" && !state.capture) {
      content.append(element("p", t("noFormHint"), "setting-hint"));
    }
  }

  // Manual save for entered logins (available even when fields are temporarily readonly)
  if (!state.capture) {
    const captureBtn = element("button", t("captureCurrent"), "btn-secondary");
    captureBtn.type = "button";
    captureBtn.addEventListener("click", async () => {
      captureBtn.disabled = true;
      clearError();
      try {
        const result = await send({ type: "captureCurrent" });
        if (!result?.capture) {
          statusEl.textContent = t("unchanged");
          content.prepend(element("p", t("unchanged"), "notice-pill"));
          return;
        }
        statusEl.textContent = t("waiting");
        await send({ type: "saveLogin", id: result.capture.id });
        await load();
      } catch (err) {
        showError(err.message);
      } finally {
        captureBtn.disabled = false;
      }
    });
    content.append(captureBtn);
  }

  // Autofill preferences & connection info
  const settings = element("details", null, "browser-preferences");
  settings.append(element("summary", "Autofill settings"));
  const preferences = await chrome.storage.local.get(["autoSubmit"]);
  function setting(label, checked, changed) {
    const row = element("label", null, "permission");
    const input = element("input");
    input.type = "checkbox";
    input.checked = checked;
    row.append(input, document.createTextNode(label));
    input.addEventListener("click", () => {
      clearError();
      void changed(input).catch(() => showError("settingFailed"));
    });
    settings.append(row);
  }
  setting(
    "Sign in automatically after filling",
    preferences.autoSubmit === true,
    async (input) => {
      await chrome.storage.local.set({ autoSubmit: input.checked });
    },
  );
  settings.append(
    element(
      "p",
      "Filling requires your approval in PassWards. Automatic sign-in starts off.",
      "setting-hint",
    ),
  );
  content.append(
    settings,
    element(
      "p",
      "Paired with PassWards. Manage this connection in the app.",
      "setting-hint",
    ),
  );
}

// Global Controls
openBtn.addEventListener("click", async () => {
  try {
    await send({ type: "focus" });
  } catch (e) {
    showError(e.message);
  }
});

refreshBtn.addEventListener("click", () => void load());

themeBtn.addEventListener("click", async () => {
  theme = theme === "dark" ? "light" : "dark";
  await chrome.storage.local.set({ theme });
  applyThemeAndLang();
});

langBtn.addEventListener("click", async () => {
  if (!PERSIAN_ENABLED) return;
  language = language === "en" ? "fa" : "en";
  await chrome.storage.local.set({ language });
  await load();
});

void load();
