(() => {
  if (window.top !== window || globalThis.__passward) return;
  let host,
    button,
    panel,
    timer,
    last = "";
  let capture = null,
    offered = "";
  const edited = new WeakSet();
  let focusedField = null,
    pagePreferences = { hidden: false },
    suppressFocusUntil = 0,
    sequence = 0;
  let autoForms = new WeakSet(),
    scannedUrl = location.href;
  const dialogSelector = 'dialog[open],[role="dialog"],[aria-modal="true"]';
  const visible = (input, writable = true) => {
    const s = getComputedStyle(input),
      r = input.getBoundingClientRect();
    return (
      (!writable || (!input.disabled && !input.readOnly)) &&
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
  function fields(capturing = false) {
    // Descend through open shadow roots used by component-based login forms.
    const result = [];
    const visit = (root) => {
      result.push(...root.querySelectorAll("input"));
      for (const el of root.querySelectorAll("*"))
        if (el.shadowRoot) visit(el.shadowRoot);
    };
    visit(document);
    return result.filter((input) => visible(input, !capturing));
  }
  const autocomplete = (input, token) =>
    input.autocomplete.split(/\s+/).includes(token);
  function codeField(input) {
    const hint = (
      input.name +
      " " +
      input.id +
      " " +
      input.autocomplete
    ).replace(/([a-z\d])([A-Z])/g, "$1 $2");
    return /(?:^|[^a-z])(?:otp|pin|verification)(?:[^a-z]|$)|one.?time|pin.?code|verification.?code/i.test(
      hint,
    );
  }
  function passwordField(input) {
    return (
      !codeField(input) &&
      (input.type === "password" ||
        (["text", ""].includes(input.type) &&
          (autocomplete(input, "current-password") ||
            autocomplete(input, "new-password") ||
            /(?:^|[^a-z])(?:password|passwd|pwd)(?:[^a-z]|$)/i.test(
              input.name + " " + input.id,
            ))))
    );
  }
  function scopedFields(container, capturing = false) {
    let all = fields(capturing);
    if (container)
      return all.filter((input) =>
        container instanceof HTMLFormElement
          ? input.form === container
          : container.contains(input),
      );
    const dialogs = [...document.querySelectorAll(dialogSelector)].filter(
      (dialog) =>
        visible(dialog, false) && all.some((input) => dialog.contains(input)),
    );
    if (dialogs.length) {
      const dialog =
        dialogs.find((dialog) => dialog.contains(document.activeElement)) ||
        dialogs.at(-1);
      all = all.filter((input) => dialog.contains(input));
    }
    const focused = [document.activeElement, focusedField].find((input) =>
      all.includes(input),
    );
    if (focused?.form)
      return all.filter((input) => input.form === focused.form);
    if (capturing) {
      const filled = all.filter((input) => passwordField(input) && input.value);
      const owners = new Set(filled.map((input) => input.form));
      if (owners.size === 1 && filled[0]?.form)
        return all.filter((input) => input.form === filled[0].form);
    }
    return all;
  }
  function group() {
    const all = scopedFields();
    if (
      all.some((e) => passwordField(e) && autocomplete(e, "new-password")) &&
      !all.some((e) => passwordField(e) && autocomplete(e, "current-password"))
    )
      return null;
    const passwords = all.filter(
      (e) => passwordField(e) && !autocomplete(e, "new-password"),
    );
    const current = passwords.filter((e) =>
      autocomplete(e, "current-password"),
    );
    if (passwords.length > 1 && !current.length) return null;
    const password =
      current.find((e) => e === document.activeElement) ||
      current.find((e) => e === focusedField) ||
      current[0] ||
      passwords.find((e) => e === document.activeElement) ||
      passwords[0];
    const users = all.filter(
      (e) =>
        ["text", "email", "tel"].includes(e.type) &&
        !passwordField(e) &&
        !codeField(e) &&
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
  function captureManual(form) {
    const all = scopedFields(form, true);
    const passwords = all.filter(passwordField);
    const next = passwords.filter((input) =>
      autocomplete(input, "new-password"),
    );
    const password =
      next[0] ||
      passwords.find((input) => autocomplete(input, "current-password")) ||
      (passwords.length === 1 ? passwords[0] : null);
    if (
      !password ||
      !password.value ||
      (next.length > 1 && next.some((input) => input.value !== password.value))
    )
      return null;
    const owningForm = password.form;
    if (
      owningForm &&
      new URL(owningForm.action || location.href, location.href).origin !==
        location.origin
    )
      return null;
    const users = all.filter(
      (input) =>
        ["email", "text", "tel"].includes(input.type) &&
        !passwordField(input) &&
        !codeField(input) &&
        (!owningForm || input.form === owningForm) &&
        !/search|otp|verification|phone|mobile/i.test(
          input.name + " " + input.id,
        ),
    );
    users.sort(
      (a, b) =>
        (b.autocomplete === "username" ? 100 : 0) +
        (b.type === "email" ? 50 : 0) +
        (/user|email|login|identifier|account/i.test(b.name + " " + b.id)
          ? 30
          : 0) -
        ((a.autocomplete === "username" ? 100 : 0) +
          (a.type === "email" ? 50 : 0) +
          (/user|email|login|identifier|account/i.test(a.name + " " + a.id)
            ? 30
            : 0)),
    );
    return {
      origin: location.origin,
      username: users[0]?.value || "",
      password: password.value,
    };
  }
  document.addEventListener(
    "input",
    (event) => {
      const input = event.composedPath()[0];
      if (event.isTrusted && input instanceof HTMLInputElement) {
        edited.add(input);
        if (input.value) closePanel();
      }
    },
    true,
  );
  function submitted(form) {
    if (
      pagePreferences.hidden ||
      !(form instanceof Element) ||
      (form instanceof HTMLFormElement && !form.checkValidity())
    )
      return;
    const inputs = scopedFields(form, true);
    if (!inputs.some((input) => edited.has(input))) return;
    const candidate = captureManual(form);
    for (const input of inputs) edited.delete(input);
    if (candidate) {
      void send({ type: "captureLogin", ...candidate })
        .then(() => {
          last = "";
          void scan();
        })
        .catch(() => {});
    } else {
      const g = group();
      if (g?.user?.form === form && !g.password && g.user.value)
        void send({ type: "captureUsername", username: g.user.value }).catch(
          () => {},
        );
    }
  }
  document.addEventListener(
    "submit",
    (event) => {
      if (event.isTrusted) submitted(event.target);
    },
    true,
  );
  document.addEventListener(
    "click",
    (event) => {
      const target = event
        .composedPath()
        .find(
          (node) =>
            node instanceof HTMLButtonElement ||
            (node instanceof HTMLInputElement &&
              ["submit", "button"].includes(node.type)),
        );
      if (
        event.isTrusted &&
        target &&
        (target.type === "button" || !target.form) &&
        /log.?in|sign.?in|continue|save.?password|change.?password|reset.?password/i.test(
          target.textContent || target.value || "",
        )
      )
        submitted(
          target.form || target.closest(dialogSelector) || document.body,
        );
    },
    true,
  );
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
  function fill(site, username, password, autoSubmit = false) {
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
    closePanel();
    suppressFocusUntil = Date.now() + 400;
    (next?.password || next?.user || g.user)?.focus();
    if (autoSubmit) {
      const form = (next?.password || next?.user || g.user)?.form;
      const submitter =
        form &&
        Array.from(form.elements).find(
          (e) =>
            ["BUTTON", "INPUT"].includes(e.tagName) &&
            e.type === "submit" &&
            visible(e),
        );
      if (
        form &&
        submitter &&
        form.checkValidity() &&
        (submitter.getAttribute("formmethod") || form.method).toLowerCase() ===
          "post" &&
        (!form.target || form.target === "_self") &&
        (!submitter.formTarget || submitter.formTarget === "_self") &&
        new URL(
          submitter.formAction || form.action || location.href,
          location.href,
        ).origin === site
      )
        form.requestSubmit(submitter);
    }
    return true;
  }
  const send = async (message) => {
    const result = await chrome.runtime.sendMessage(message);
    if (!result?.ok) throw Error(result?.error || "browserUnavailable");
    return result.data;
  };
  function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text) element.textContent = text;
    if (className) element.className = className;
    return element;
  }
  function closePanel(restore = false) {
    sequence++;
    if (!panel) return;
    panel.hidden = true;
    button.setAttribute("aria-expanded", "false");
    if (restore && focusedField?.isConnected) {
      suppressFocusUntil = Date.now() + 200;
      focusedField.focus();
    }
  }
  function place() {
    if (!host) return;
    const anchored = focusedField?.isConnected && visible(focusedField);
    button.classList.toggle("field-button", Boolean(anchored));
    if (anchored) {
      const rect = focusedField.getBoundingClientRect();
      if (rect.bottom < 0 || rect.top > innerHeight) {
        host.hidden = true;
        return;
      }
      const size = matchMedia("(pointer:coarse)").matches ? 40 : 30;
      Object.assign(button.style, {
        left: Math.min(innerWidth - size - 8, rect.right + 6) + "px",
        top: Math.max(6, rect.top + (rect.height - size) / 2) + "px",
        right: "auto",
        bottom: "auto",
      });
      const width = Math.min(320, innerWidth - 16);
      const height = Math.min(panel.scrollHeight || 260, 360);
      const below = innerHeight - rect.bottom - 14;
      Object.assign(panel.style, {
        left: Math.max(8, Math.min(rect.left, innerWidth - width - 8)) + "px",
        width: width + "px",
        top:
          (below >= Math.min(height, 140)
            ? rect.bottom + 6
            : Math.max(8, rect.top - height - 6)) + "px",
        right: "auto",
        bottom: "auto",
        maxHeight:
          Math.max(100, Math.min(360, below >= 140 ? below : rect.top - 14)) +
          "px",
      });
    } else host.hidden = true;
  }

  function mount() {
    if (host?.isConnected) return;
    host = node("div");
    host.id = "passward-assistant";
    host.style.cssText =
      "position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;";
    const shadow = host.attachShadow({ mode: "closed" });
    const style = node("style");
    style.textContent =
      ":host{font:13px/1.5 system-ui,sans-serif;color-scheme:dark;color:#ececea}*{box-sizing:border-box}[hidden]{display:none!important}button,input,select{font:inherit}button{cursor:pointer;color:inherit;background:#28292c;border:1px solid #48494d;border-radius:7px;padding:8px 11px;min-height:36px;text-align:start;transition:background .14s ease,opacity .14s ease}button:hover{background:#343539}button:disabled{opacity:.55;cursor:default}button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid #91bec9;outline-offset:2px}.trigger{position:fixed;pointer-events:auto;background:#222326;color:#ececea;box-shadow:0 2px 10px #0002}.field-button{width:30px;height:30px;min-height:30px;padding:4px;font-size:0;display:grid;place-items:center;border-color:#6b8790}.field-button:before{content:'✳';font-size:19px;line-height:1;color:#a1cbd6}.panel{position:fixed;pointer-events:auto;background:#202123;border:1px solid #4a4b4f;border-radius:10px;padding:10px;overflow:auto;box-shadow:0 8px 24px #0003}.panel:not([hidden]){animation:passwards-in .16s ease-out}.heading{font-size:11px;color:#b8bbc1;margin:1px 3px 8px;overflow-wrap:anywhere}.panel button{display:block;width:100%;margin-top:4px}.account{border:0;background:transparent;padding:9px 10px}.account strong,.account small{display:block}.account small,.hint{font-size:12px;color:#b4b6bc;overflow-wrap:anywhere}.panel p{margin:7px 3px}.quiet{border:0;background:transparent;font-size:12px;color:#b4b6bc}.primary{background:#e1e1dd;color:#242527;border-color:#e1e1dd}.primary:hover{background:#f0f0ec}@keyframes passwards-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}@media(pointer:coarse){button{min-height:44px}.field-button{width:40px;height:40px}}@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}";
    panel = node("div", null, "panel");
    panel.hidden = true;
    panel.setAttribute("role", "region");
    panel.setAttribute("aria-label", "PassWards login assistant");
    button = node("button", "PassWards", "trigger");
    button.type = "button";
    button.setAttribute("aria-label", "PassWards: show login suggestions");
    button.setAttribute("aria-expanded", "false");
    button.addEventListener("click", (event) => {
      if (!event.isTrusted) return;
      if (!panel.hidden) {
        closePanel();
        return;
      }
      void choose();
    });
    panel.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closePanel(true);
      }
      if (
        !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) ||
        ["INPUT", "SELECT"].includes(event.target.tagName)
      )
        return;
      const buttons = Array.from(
        panel.querySelectorAll("button:not(:disabled)"),
      );
      if (!buttons.length) return;
      event.preventDefault();
      const index = buttons.indexOf(event.target);
      buttons[
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? buttons.length - 1
            : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) %
              buttons.length
      ].focus();
    });
    shadow.append(style, panel, button);
    document.documentElement.append(host);
  }
  function begin() {
    mount();
    panel.replaceChildren();
    panel.hidden = false;
    host.hidden = false;
    button.setAttribute("aria-expanded", "true");
    panel.append(node("p", "PassWards · " + location.hostname, "heading"));
    place();
    return ++sequence;
  }
  function action(text, callback, className = "") {
    const item = node("button", text, className);
    item.type = "button";
    item.addEventListener("click", (event) => {
      if (event.isTrusted) void callback(item);
    });
    panel.append(item);
    return item;
  }
  function errorText(error) {
    if (error.message === "locked")
      return "Unlock your vault in PassWards, then try again.";
    if (error.message === "browserUnpaired")
      return "Connect this browser in the PassWards app.";
    if (error.message === "browserExpired")
      return "This request expired. Try again.";
    if (error.message === "pageChanged")
      return "The page changed. Your saved login is still in the vault.";
    return "Open PassWards and try again.";
  }
  async function choose() {
    const ticket = begin();
    const feedback = node("p", "Looking for saved logins…", "hint");
    feedback.setAttribute("role", "status");
    panel.append(feedback);
    try {
      const { accounts } = await send({ type: "detect" });
      if (ticket !== sequence) return;
      feedback.textContent = accounts.length
        ? "Choose a login"
        : "No saved login. Sign in to get a save suggestion.";
      for (const account of accounts) {
        const row = action(
          "",
          async (item) => {
            for (const b of panel.querySelectorAll("button")) b.disabled = true;
            feedback.textContent = "Approve the fill in PassWards…";
            try {
              await send({ type: "fill", id: account.id });
              closePanel(true);
            } catch (error) {
              feedback.textContent = errorText(error);
              for (const b of panel.querySelectorAll("button"))
                b.disabled = false;
            }
          },
          "account",
        );
        row.append(
          node("strong", account.title),
          node("small", account.username),
        );
      }
    } catch (error) {
      if (ticket !== sequence) return;
      feedback.textContent = errorText(error);
      action("Open PassWards", () => send({ type: "focus" }));
    }
    action("Close", () => closePanel(), "quiet");
    place();
  }
  async function scan() {
    if (document.hidden) return;
    if (location.href !== scannedUrl) {
      autoForms = new WeakSet();
      scannedUrl = location.href;
    }
    try {
      pagePreferences = await send({ type: "pageSettings" });
      if (!pagePreferences.paired) {
        if (host) host.hidden = true;
        return;
      }
      const result = await send({ type: "captureState" });
      capture = result.capture;
      if (capture) {
        closePanel();
        if (host) host.hidden = true;
        if (
          capture.automatic &&
          offered !== capture.id &&
          !["checking", "waiting"].includes(capture.status)
        ) {
          const result = await send({ type: "openSavePopup", id: capture.id });
          if (result.attempted) offered = capture.id;
        }
        return;
      }
    } catch {}
    if (document.hasFocus() && pagePreferences.paired) {
      const form = group();
      const anchor = form?.user || form?.password;
      if (anchor && !autoForms.has(anchor)) {
        autoForms.add(anchor);
        if (!form.password?.value && !form.user?.value) {
          const ticket = sequence;
          try {
            const result = await send({ type: "openLoginPopup" });
            if (result.opened) {
              if (ticket === sequence) focusedField = null;
              return;
            }
          } catch {}
          if (
            ticket === sequence &&
            document.hasFocus() &&
            visible(anchor) &&
            !form.password?.value &&
            !form.user?.value
          ) {
            focusedField = anchor;
            await choose();
            return;
          }
        }
      }
    }
    if (focusedField?.isConnected && visible(focusedField)) {
      mount();
      host.hidden = false;
      place();
    } else if (host) host.hidden = true;
  }
  document.addEventListener(
    "focusin",
    (event) => {
      if (
        event.composedPath().includes(host) ||
        Date.now() < suppressFocusUntil
      )
        return;
      const input = event.composedPath()[0];
      if (
        !(input instanceof HTMLInputElement) ||
        !visible(input) ||
        !pagePreferences.paired
      )
        return;
      focusedField = input;
      const login = group();
      if (input !== login?.password && input !== login?.user) {
        focusedField = null;
        closePanel();
        if (host && !capture) host.hidden = true;
        return;
      }
      if (login.user) autoForms.add(login.user);
      if (login.password) autoForms.add(login.password);
      capture = null;
      mount();
      host.hidden = false;
      place();
      void choose();
    },
    true,
  );
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape" && panel && !panel.hidden) {
        closePanel(true);
        return;
      }
      if (
        event.target === focusedField &&
        event.key === "ArrowDown" &&
        pagePreferences.paired
      ) {
        event.preventDefault();
        void choose().then(() =>
          panel.querySelector("button:not(:disabled)")?.focus(),
        );
      }
    },
    true,
  );
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (
        panel &&
        !event.composedPath().includes(host) &&
        event.target !== focusedField
      )
        closePanel();
    },
    true,
  );
  addEventListener("resize", place);
  addEventListener("scroll", place, true);
  globalThis.__passward = Object.freeze({
    version: 3,
    detect,
    fill,
    captureManual,
  });
  new MutationObserver((records) => {
    if (records.every((record) => record.target === host)) return;
    clearTimeout(timer);
    timer = setTimeout(() => void scan(), 600);
  }).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["type", "style", "class", "hidden", "autocomplete"],
  });
  addEventListener("pageshow", () => void scan());
  addEventListener("focus", () => void scan());
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void scan();
  });
  setInterval(() => {
    if (!document.hidden) void scan();
  }, 2000);
  void scan();
})();
