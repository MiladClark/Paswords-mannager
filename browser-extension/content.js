(() => {
  if (window.top !== window || globalThis.__passward) return;
  let timer;
  let offered = "";
  const edited = new WeakSet();
  let focusedField = null;
  let pagePreferences = { hidden: false, paired: false };
  let autoForms = new WeakSet();
  let scannedUrl = location.href;
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
        .then(() => void scan())
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
  async function scan() {
    if (document.hidden) return;
    if (location.href !== scannedUrl) {
      scannedUrl = location.href;
      autoForms = new WeakSet();
      focusedField = null;
    }
    try {
      pagePreferences = await send({ type: "pageSettings" });
      if (!pagePreferences.paired) return;
      const { capture } = await send({ type: "captureState" });
      if (capture) {
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
      if (!document.hasFocus()) return;
      const form = group();
      const anchor = form?.user || form?.password;
      if (
        !anchor ||
        autoForms.has(anchor) ||
        form.password?.value ||
        form.user?.value
      )
        return;
      const seen = autoForms;
      seen.add(anchor);
      try {
        const result = await send({ type: "openLoginPopup" });
        if (!result.attempted) seen.delete(anchor);
      } catch {
        seen.delete(anchor);
      }
    } catch {}
  }
  // Remember the form when opening the toolbar popup takes focus off the page.
  document.addEventListener(
    "focusin",
    (event) => {
      const input = event.composedPath()[0];
      if (!(input instanceof HTMLInputElement) || !visible(input)) return;
      focusedField = input;
      const login = group();
      if (input !== login?.password && input !== login?.user) focusedField = null;
    },
    true,
  );
  globalThis.__passward = Object.freeze({
    version: 3,
    detect,
    fill,
    captureManual,
  });
  new MutationObserver(() => {
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
