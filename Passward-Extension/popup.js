const words = {
  en: {
    open: "Open Passward",
    refresh: "Refresh",
    pair: "Connect browser",
    pairHint:
      "In Passward: Settings → Browsers → Pair browser. Enter the six-digit code here.",
    code: "Pairing code",
    browser: "Browser",
    connect: "Connect",
    fill: "Fill",
    noAccounts: "No saved account for this site.",
    noForm: "No supported login form on this page.",
    unsupported: "Open a website with a login form.",
    detect: "Always detect logins on this site",
    disconnect: "Disconnect this browser",
    waiting: "Approve this request in Passward.",
    filled: "Filled. You can sign in.",
    offline:
      "Open Passward, then enable the browser connection in Settings → Browsers.",
    locked: "Unlock Passward, then refresh.",
    browserUnpaired: "Connect this browser again.",
    browserPairCode: "The pairing code is incorrect.",
    browserPairExpired: "Generate a new pairing code in Passward.",
    browserDenied: "Request declined. Try again when ready.",
    browserExpired: "Request expired. Try Fill again.",
    browserOrigin: "This account does not match the site.",
    pageChanged: "The page changed. Refresh and try again.",
    browserBusy: "Finish the current request in Passward first.",
    browserUnavailable: "The browser connection is unavailable.",
    pending: "Checking your vault…",
    noFormHint:
      "Passward supports visible sign-in fields, including username-first pages. Cross-site frames and sign-up forms are excluded.",
  },
  fa: {
    open: "بازکردن Passward",
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
    waiting: "درخواست را داخل Passward تأیید کنید.",
    filled: "فرم پر شد؛ می‌توانید وارد شوید.",
    offline:
      "Passward را باز کنید و اتصال مرورگر را از تنظیمات ← مرورگرها فعال کنید.",
    locked: "Passward را باز کنید، سپس تازه‌سازی کنید.",
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
let { language = "en", theme } = await chrome.storage.local.get([
  "language",
  "theme",
]);
theme ||= matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
let state;
const content = document.querySelector("#content"),
  status = document.querySelector("#status"),
  error = document.querySelector("#error");
const t = (key) => words[language][key] || words[language].browserUnavailable;
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
function chromePattern(site) {
  const url = new URL(site);
  return `${url.protocol}//${url.hostname}/*`;
}
function apply() {
  document.documentElement.lang = language;
  document.documentElement.dir = language === "fa" ? "rtl" : "ltr";
  document.documentElement.dataset.theme = theme;
  document.querySelector("#open").textContent = t("open");
  document.querySelector("#refresh").textContent = t("refresh");
  document.querySelector("#language").textContent =
    language === "en" ? "فا" : "EN";
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
    if (!state.paired) {
      status.textContent = "";
      pairing();
      return;
    }
    status.textContent = state.site || t("unsupported");
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
      showError(e.message);
      if (e.message === "noForm") content.append(element("p", t("noFormHint")));
    }
    const label = element("label", null, "permission"),
      permission = element("input");
    permission.type = "checkbox";
    permission.checked = await chrome.permissions.contains({
      origins: [chromePattern(state.site)],
    });
    permission.addEventListener("change", async () => {
      try {
        if (permission.checked)
          permission.checked = await chrome.permissions.request({
            origins: [chromePattern(state.site)],
          });
        else
          await chrome.permissions.remove({
            origins: [chromePattern(state.site)],
          });
      } catch {
        permission.checked = false;
        showError("browserDenied");
      }
    });
    label.append(permission, document.createTextNode(t("detect")));
    content.append(label);
    const disconnect = element("button", t("disconnect"), "text");
    disconnect.addEventListener("click", async () => {
      await send({ type: "disconnect" });
      await load();
    });
    content.append(disconnect);
  } catch (e) {
    status.textContent = "";
    showError(e.message);
  }
}
document.querySelector("#language").addEventListener("click", async () => {
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
