const words = {
  en: {
    open: "Open PassWards",
    refresh: "Refresh",
    pair: "Connect browser",
    pairHint:
      "In PassWards: Settings → Browsers → Pair browser. Enter the six-digit code here.",
    code: "Pairing code",
    browser: "Browser",
    connect: "Connect",
    fill: "Fill",
    noAccounts:
      "No saved account for this site. Enter your login and submit the form to get a save suggestion.",
    noForm: "No supported login form on this page.",
    unsupported: "Open a website with a login form.",
    captureCurrent: "Save entered login",
    captureHint: "Confirm in the PassWards app to save this login.",
    saveLogin: "Save this login?",
    updateLogin: "Update the saved password?",
    reviewSave: "Save",
    reviewUpdate: "Update",
    notNow: "Not now",
    saved: "Login saved in your vault.",
    updated: "Password updated in your vault.",
    unchanged: "This login is already saved.",
    declined: "Not saved.",
    invalidEntry: "Enter a username and password first.",
    browserLoginChanged:
      "The saved login changed. Submit the login again to review a fresh update.",
    waiting: "Approve this request in PassWards.",
    filled: "Filled. You can sign in.",
    offline:
      "Open PassWards, then enable the browser connection in Settings → Browsers.",
    locked: "Unlock PassWards, then refresh.",
    browserUnpaired: "Connect this browser again.",
    browserPairCode: "The pairing code is incorrect.",
    browserPairExpired: "Generate a new pairing code in PassWards.",
    browserDenied: "Request declined. Try again when ready.",
    browserCaptureDenied:
      "The desktop app did not accept the save request. Reopen the latest PassWards app, then try again.",
    reloadTitle: "Finish updating PassWards",
    reloadHint:
      "The popup and background service are running different versions. Reload the extension to finish the update, then open it again.",
    reloadAction: "Reload extension",
    pageReloadRequired:
      "Refresh this website once after updating PassWards, then enter your login and click Save entered login.",
    settingFailed: "Could not save this setting. Try again.",
    browserExpired: "Request expired. Try Fill again.",
    browserOrigin: "This account does not match the site.",
    pageChanged: "The page changed. Refresh and try again.",
    browserBusy: "Finish the current request in PassWards first.",
    browserUnavailable: "The browser connection is unavailable.",
    pending: "Checking your vault…",
    noFormHint:
      "PassWards supports visible sign-in fields, including username-first pages. Cross-site frames and sign-up forms are excluded.",
  },
  fa: {
    open: "بازکردن PassWards",
    refresh: "تازه‌سازی",
    pair: "اتصال مرورگر",
    pairHint:
      "در اپ: تنظیمات ← مرورگرها ← جفت‌سازی. کد شش‌رقمی را اینجا وارد کنید.",
    code: "کد جفت‌سازی",
    browser: "مرورگر",
    connect: "اتصال",
    fill: "پرکردن",
    noAccounts: "حسابی برای این سایت ذخیره نشده است.",
    noForm: "فرم ورود پشتیبانی‌شده‌ای پیدا نشد.",
    unsupported: "صفحهٔ یک سایت با فرم ورود را باز کنید.",
    detect: "تشخیص همیشگی ورود در این سایت",
    disconnect: "قطع اتصال این مرورگر",
    waiting: "درخواست را داخل PassWards تأیید کنید.",
    filled: "فرم پر شد؛ می‌توانید وارد شوید.",
    offline:
      "PassWards را باز کنید و اتصال مرورگر را از تنظیمات ← مرورگرها فعال کنید.",
    locked: "PassWards را باز کنید، سپس تازه‌سازی کنید.",
    browserUnpaired: "مرورگر را دوباره متصل کنید.",
    browserPairCode: "کد جفت‌سازی نادرست است.",
    browserPairExpired: "در اپ کد تازه بسازید.",
    browserDenied: "درخواست رد شد. دوباره تلاش کنید.",
    browserExpired: "درخواست منقضی شد. دوباره پرکردن را بزنید.",
    browserOrigin: "این حساب با سایت مطابقت ندارد.",
    pageChanged: "صفحه تغییر کرد. دوباره تازه‌سازی کنید.",
    browserBusy: "ابتدا درخواست فعلی اپ را تمام کنید.",
    browserUnavailable: "اتصال مرورگر در دسترس نیست.",
    pending: "در حال بررسی خزانه…",
    noFormHint:
      "فیلدهای قابل‌مشاهدهٔ ورود، از جمله ورود چندمرحله‌ای، پشتیبانی می‌شوند. فرم ثبت‌نام و فریم سایت دیگر کنار گذاشته می‌شوند.",
  },
};
const PERSIAN_ENABLED = false;
let { language = "en", theme } = await chrome.storage.local.get([
  "language",
  "theme",
]);
if (!PERSIAN_ENABLED) language = "en";
theme ||= matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
let state;
const content = document.querySelector("#content"),
  status = document.querySelector("#status"),
  error = document.querySelector("#error");
const t = (key) =>
  words[language][key] || words.en[key] || words[language].browserUnavailable;
function element(tag, text, className) {
  const e = document.createElement(tag);
  if (text) e.textContent = text;
  if (className) e.className = className;
  return e;
}
function showError(code) {
  error.hidden = false;
  error.textContent = t(code === "browserOffline" ? "offline" : code);
}
async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw Error(response?.error || "browserUnavailable");
  return response.data;
}
function apply() {
  document.querySelector("#language").hidden = !PERSIAN_ENABLED;
  document.documentElement.lang = language;
  document.documentElement.dir = language === "fa" ? "rtl" : "ltr";
  document.documentElement.dataset.theme = theme;
  document.querySelector("#open").textContent = t("open");
  document.querySelector("#refresh").textContent = t("refresh");
  document.querySelector("#language").textContent =
    language === "en" ? "فا" : "EN";
}
function capturePanel(capture) {
  const section = element("section", null, "capture-offer");
  section.append(
    element("h1", t(capture.kind === "update" ? "updateLogin" : "saveLogin")),
    element("p", capture.username || state.site),
  );
  const feedback = element(
    "p",
    capture.status === "waiting" ? t("waiting") : t("captureHint"),
  );
  feedback.setAttribute("role", "status");
  const save = element(
    "button",
    t(capture.kind === "update" ? "reviewUpdate" : "reviewSave"),
    "primary",
  );
  save.type = "button";
  save.disabled = ["checking", "waiting"].includes(capture.status);
  save.addEventListener("click", async () => {
    save.disabled = true;
    error.hidden = true;
    feedback.textContent = t("waiting");
    try {
      const result = await send({ type: "saveLogin", id: capture.id });
      await load();
      status.textContent = t(result.outcome);
    } catch (error) {
      showError(error.message);
      save.disabled = false;
    }
  });
  const dismiss = element("button", t("notNow"), "text");
  dismiss.type = "button";
  dismiss.addEventListener("click", async () => {
    await send({ type: "dismissLogin", id: capture.id }).catch(() => {});
    await load();
  });
  section.append(feedback, save, dismiss);
  content.append(section);
}
function pairing() {
  content.append(element("h1", t("pair")), element("p", t("pairHint")));
  const form = element("form");
  const label = element("label", t("code"));
  label.htmlFor = "code";
  const code = element("input");
  Object.assign(code, {
    id: "code",
    name: "code",
    required: true,
    inputMode: "numeric",
    maxLength: 6,
    pattern: "[0-9]{6}",
    autocomplete: "off",
    dir: "ltr",
  });
  code.addEventListener("input", () => {
    code.value = code.value
      .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 1776))
      .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 1632))
      .replace(/\D/g, "")
      .slice(0, 6);
  });
  const browserLabel = element("label", t("browser"));
  browserLabel.htmlFor = "browser";
  const browser = element("select");
  browser.id = "browser";
  for (const name of ["Chrome", "Edge"]) {
    const option = element("option", name);
    option.value = name;
    browser.append(option);
  }
  browser.value = navigator.userAgent.includes("Edg/") ? "Edge" : "Chrome";
  const submit = element("button", t("connect"), "primary");
  submit.type = "submit";
  form.append(label, code, browserLabel, browser, submit);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    error.hidden = true;
    try {
      await send({ type: "pair", code: code.value, browser: browser.value });
      code.value = "";
      await load();
    } catch (e) {
      showError(e.message);
    } finally {
      submit.disabled = false;
    }
  });
  content.append(form);
}
async function load() {
  apply();
  error.hidden = true;
  content.replaceChildren();
  status.textContent = t("pending");
  try {
    state = await send({ type: "state" });
    if (state.bridgeApi !== 7) {
      status.textContent = "";
      content.append(
        element("h1", t("reloadTitle")),
        element("p", t("reloadHint")),
      );
      const reload = element("button", t("reloadAction"), "primary");
      reload.type = "button";
      reload.addEventListener("click", () => chrome.runtime.reload());
      content.append(reload);
      return;
    }
    if (!state.paired) {
      status.textContent = "";
      pairing();
      return;
    }
    status.textContent = state.site || t("unsupported");
    if (state.saveState)
      content.append(element("p", t(state.saveState.outcome), "waiting"));
    if (state.capture) capturePanel(state.capture);
    if (state.fillState?.state === "waiting")
      content.append(element("p", t("waiting"), "waiting"));
    if (state.fillState?.state === "filled")
      content.append(element("p", t("filled"), "waiting"));
    if (!state.site) {
      content.append(element("p", t("unsupported")));
      return;
    }
    try {
      const { accounts } = await send({ type: "matches" });
      if (!accounts.length) content.append(element("p", t("noAccounts")));
      const accountSearch = element("input");
      accountSearch.type = "search";
      accountSearch.placeholder = "Search logins for this site";
      accountSearch.setAttribute("aria-label", "Search logins for this site");
      if (accounts.length) content.append(accountSearch);
      accountSearch.addEventListener("input", () => {
        for (const row of content.querySelectorAll(".account"))
          row.hidden = !row.textContent
            .toLocaleLowerCase()
            .includes(accountSearch.value.toLocaleLowerCase());
      });
      for (const account of accounts) {
        const row = element("div", null, "account"),
          details = element("div");
        details.append(
          element("strong", account.title),
          element("small", account.username),
        );
        const fill = element("button", t("fill"));
        fill.type = "button";
        fill.addEventListener("click", async () => {
          error.hidden = true;
          for (const b of content.querySelectorAll("button")) b.disabled = true;
          status.textContent = t("waiting");
          try {
            await send({ type: "fill", id: account.id });
            status.textContent = t("filled");
          } catch (e) {
            showError(e.message);
          } finally {
            for (const b of content.querySelectorAll("button"))
              b.disabled = false;
          }
        });
        row.append(details, fill);
        content.append(row);
      }
    } catch (e) {
      if (e.message === "browserUnpaired") {
        await load();
        return;
      }
      if (!(state.capture && e.message === "noForm")) showError(e.message);
      if (e.message === "noForm" && !state.capture)
        content.append(element("p", t("noFormHint")));
    }
    if (!state.capture) {
      const capture = element("button", t("captureCurrent"), "secondary");
      capture.type = "button";
      capture.addEventListener("click", async () => {
        capture.disabled = true;
        error.hidden = true;
        try {
          const result = await send({ type: "captureCurrent" });
          if (!result.capture) {
            status.textContent = t("unchanged");
            return;
          }
          status.textContent = t("waiting");
          await send({ type: "saveLogin", id: result.capture.id });
          await load();
        } catch (error) {
          showError(error.message);
        } finally {
          capture.disabled = false;
        }
      });
      content.append(capture);
    }
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
        error.hidden = true;
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
  } catch (e) {
    status.textContent = "";
    showError(e.message);
  }
}
document.querySelector("#language").addEventListener("click", async () => {
  if (!PERSIAN_ENABLED) return;
  language = language === "en" ? "fa" : "en";
  await chrome.storage.local.set({ language });
  await load();
});
document.querySelector("#theme").addEventListener("click", async () => {
  theme = theme === "dark" ? "light" : "dark";
  await chrome.storage.local.set({ theme });
  apply();
});
document.querySelector("#refresh").addEventListener("click", () => void load());
document.querySelector("#open").addEventListener("click", async () => {
  try {
    await send({ type: "focus" });
  } catch (e) {
    showError(e.message);
  }
});
void load();
