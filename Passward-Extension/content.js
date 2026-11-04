(() => {
  if (window.top !== window || globalThis.__passward) return;
  let host,
    button,
    panel,
    timer,
    last = "";
  const visible = (input) => {
    const s = getComputedStyle(input),
      r = input.getBoundingClientRect();
    return (
      !input.disabled &&
      !input.readOnly &&
      input.type !== "hidden" &&
      !input.closest('[inert],[aria-hidden="true"]') &&
      s.display !== "none" &&
      s.visibility !== "hidden" &&
      Number(s.opacity) > 0 &&
      r.width > 8 &&
      r.height > 8 &&
      input.getClientRects().length > 0
    );
  };
  function fields() {
    // Descend through open shadow roots used by component-based login forms.
    const result = [];
    const visit = (root) => {
      result.push(...root.querySelectorAll("input"));
      for (const el of root.querySelectorAll("*"))
        if (el.shadowRoot) visit(el.shadowRoot);
    };
    visit(document);
    return result.filter(visible);
  }
  function group() {
    const all = fields();
    if (
      all.some(
        (e) => e.type === "password" && e.autocomplete === "new-password",
      ) &&
      !all.some(
        (e) => e.type === "password" && e.autocomplete === "current-password",
      )
    )
      return null;
    const passwords = all.filter(
      (e) =>
        e.type === "password" &&
        e.autocomplete !== "new-password" &&
        !/otp|one.?time|verification|pin/i.test(
          `${e.name} ${e.id} ${e.autocomplete}`,
        ),
    );
    const current = passwords.filter(
      (e) => e.autocomplete === "current-password",
    );
    if (passwords.length > 1 && !current.length) return null;
    const password =
      current.find((e) => e === document.activeElement) ||
      current[0] ||
      passwords.find((e) => e === document.activeElement) ||
      passwords[0];
    const users = all.filter(
      (e) =>
        ["text", "email", "tel"].includes(e.type) &&
        e.autocomplete !== "one-time-code" &&
        !/search|otp|verification|phone|mobile/i.test(`${e.name} ${e.id}`),
    );
    const score = (e) =>
      (e.autocomplete === "username" ? 100 : 0) +
      (e.type === "email" ? 50 : 0) +
      (/user|email|login|identifier|account/i.test(`${e.name} ${e.id}`)
        ? 30
        : 0);
    const eligible = users.filter(
      (e) =>
        !password ||
        (password.form
          ? e.form === password.form
          : e.getRootNode() === password.getRootNode()),
    );
    eligible.sort((a, b) => score(b) - score(a));
    let user = eligible[0];
    if (user && !password && score(user) < 30) user = null;
    if (
      !password &&
      (!user ||
        !/log.?in|sign.?in|continue|next|ورود|ادامه/i.test(
          user.form?.textContent || document.body.innerText.slice(0, 6000),
        ))
    )
      return null;
    const form = password?.form || user?.form;
    if (form) {
      try {
        if (
          new URL(form.action || location.href, location.href).origin !==
          location.origin
        )
          return null;
      } catch {
        return null;
      }
    }
    if (!password && !user) return null;
    return { password, user };
  }
  function detect() {
    const g = group();
    return g ? { password: !!g.password, username: !!g.user } : null;
  }
  function set(input, value) {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    if (!setter) return false;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    return true;
  }
  function fill(site, username, password) {
    if (location.origin !== site || window.top !== window) return false;
    const g = group();
    if (!g) return false;
    // Recheck visibility and form destination at the moment of insertion.
    if (g.user && !set(g.user, username)) return false;
    const next = group();
    if (
      g.password &&
      (!next?.password ||
        location.origin !== site ||
        !set(next.password, password))
    )
      return false;
    (next?.password || next?.user || g.user)?.focus();
    return true;
  }
  const send = async (message) => {
    const result = await chrome.runtime.sendMessage(message);
    if (!result?.ok) throw Error(result?.error || "browserUnavailable");
    return result.data;
  };
  function mount() {
    if (host?.isConnected) return;
    host = document.createElement("div");
    host.id = "passward-assistant";
    host.style.cssText =
      "position:fixed!important;bottom:18px!important;right:18px!important;z-index:2147483647!important;display:block!important;";
    const shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `:host{font-family:system-ui,sans-serif;color-scheme:light dark}button{font:12px system-ui;cursor:pointer;border:1px solid #696a6d;border-radius:9px;background:#27282b;color:#efefeb;padding:10px 13px;text-align:start;min-height:40px}button:focus-visible{outline:2px solid #bfc0c4;outline-offset:3px}.panel{background:#202123;color:#efefeb;border:1px solid #636468;border-radius:10px;padding:10px;margin-bottom:8px;max-width:280px;box-shadow:0 6px 28px #0003}.panel button{display:block;width:100%;margin-top:6px}.panel small{display:block;overflow-wrap:anywhere;color:#c5c6ca;margin-top:3px}.panel p{font-size:12px;margin:4px 0}`;
    panel = document.createElement("div");
    panel.className = "panel";
    panel.hidden = true;
    button = document.createElement("button");
    button.type = "button";
    button.textContent = "Passward";
    button.addEventListener("click", (event) => {
      if (event.isTrusted) void choose();
    });
    shadow.append(style, panel, button);
    document.documentElement.append(host);
  }
  async function choose() {
    mount();
    panel.replaceChildren();
    panel.hidden = false;
    const text = document.createElement("p");
    text.textContent = "Passward · " + location.hostname;
    panel.append(text);
    try {
      const { accounts } = await send({ type: "matches" });
      if (!accounts.length) {
        text.textContent = "No saved accounts · حسابی ذخیره نشده";
        return;
      }
      for (const account of accounts) {
        const row = document.createElement("button");
        row.type = "button";
        row.textContent = account.title;
        const username = document.createElement("small");
        username.textContent = account.username;
        row.append(username);
        row.addEventListener("click", async (event) => {
          if (!event.isTrusted) return;
          for (const b of panel.querySelectorAll("button")) b.disabled = true;
          text.textContent = "Approve in Passward · در اپ تأیید کنید";
          try {
            await send({ type: "fill", id: account.id });
            panel.hidden = true;
            button.textContent = "Passward · Filled ✓";
          } catch (error) {
            text.textContent =
              error.message === "browserExpired"
                ? "Request expired · درخواست منقضی شد"
                : "Open Passward and try again · دوباره تلاش کنید";
          }
        });
        panel.append(row);
      }
    } catch {
      text.textContent = "Open and unlock Passward · اپ را باز کنید";
      const open = document.createElement("button");
      open.textContent = "Open Passward · بازکردن اپ";
      open.addEventListener("click", (e) => {
        if (e.isTrusted) void send({ type: "focus" }).catch(() => {});
      });
      panel.append(open);
    }
    const close = document.createElement("button");
    close.textContent = "Close · بستن";
    close.addEventListener("click", () => (panel.hidden = true));
    panel.append(close);
  }
  async function scan() {
    if (!detect()) {
      if (host) host.hidden = true;
      last = "";
      return;
    }
    if (host) host.hidden = false;
    const key = location.href;
    if (last === key) return;
    last = key;
    try {
      const { accounts } = await send({ type: "detect" });
      if (accounts.length) {
        mount();
        button.textContent = `Passward · ${accounts.length} ${document.documentElement.lang.startsWith("fa") ? "حساب" : "accounts"}`;
      }
    } catch (error) {
      if (error.message === "locked") {
        mount();
        button.textContent = "Passward · Unlock / بازکردن";
      } else last = "";
    }
  }
  globalThis.__passward = Object.freeze({ detect, fill });
  new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(() => void scan(), 600);
  }).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["type", "style", "class", "hidden", "autocomplete"],
  });
  addEventListener("pageshow", () => {
    last = "";
    void scan();
  });
  document.addEventListener("focusin", () => {
    if (!last) void scan();
  });
  void scan();
})();
