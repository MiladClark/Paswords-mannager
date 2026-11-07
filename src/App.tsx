import {
  useCallback,
  useLayoutEffect,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CircleNotch,
  GearSix,
  Globe,
  IconContext,
  Key,
  LockSimple,
  MagnifyingGlass,
  Plus,
  Star,
  X,
  Sun,
  Moon,
} from "@phosphor-icons/react";
import {
  blankEntry,
  call,
  native,
  preview,
  redact,
  type Entry,
  type Page,
  type Status,
  type EntryView,
  editable,
} from "./api";
import { en, translator, type Key as TextKey, type Language } from "./i18n";
import { hostname, IconButton, SiteIcon } from "./ui";
import Auth from "./Auth";
import EntryForm from "./EntryForm";
import EntryDetail from "./EntryDetail";
import VaultDialogs, { type Modal } from "./VaultDialogs";
import SettingsPage from "./SettingsPage";
import DestructiveDialog from "./DestructiveDialog";
import WindowControls from "./WindowControls";
import BrowserFillDialog, { type BrowserFill } from "./BrowserFillDialog";
import ExtensionInstall from "./ExtensionInstall";
import BrowserSaveDialog, { type BrowserSave } from "./BrowserSaveDialog";
import Dropdown from "./Dropdown";
import MotionPresence from "./MotionPresence";
import UpdateWidget from "./UpdateWidget";
import { useAppUpdates } from "./updates";
import "./App.css";

const emptyPage: Page = {
  items: [],
  total: 0,
  allCount: 0,
  favoriteCount: 0,
  folders: [],
};
const PAGE_SIZE = 50;
const PERSIAN_ENABLED = false;
function initialLanguage(): Language {
  if (!PERSIAN_ENABLED) return "en";
  try {
    return localStorage.getItem("nook.language") === "fa" ? "fa" : "en";
  } catch {
    return "en";
  }
}
export default function App() {
  const updates = useAppUpdates();
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    try {
      const saved = localStorage.getItem("passward.theme");
      if (saved === "light" || saved === "dark") return saved;
    } catch {}
    return matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  });
  const [language, setLanguage] = useState<Language>(initialLanguage);
  const t = translator(language);
  const tRef = useRef(t);
  tRef.current = t;
  const [phase, setPhase] = useState<
    "loading" | "locked" | "open" | "unavailable"
  >("loading");
  const [exists, setExists] = useState(false);
  const [busy, setBusy] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [page, setPage] = useState<Page>(emptyPage);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [filter, setFilter] = useState("all");
  const [folder, setFolder] = useState("");
  const [sort, setSort] = useState("recent");
  const [pageIndex, setPageIndex] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [listLoading, setListLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  const [entry, setEntry] = useState<EntryView | null>(null);
  const [browserFill, setBrowserFill] = useState<BrowserFill | null>(null);
  const [browserSave, setBrowserSave] = useState<BrowserSave | null>(null);
  const [revealRequest, setRevealRequest] = useState<{
    field: string;
    sequence: number;
  } | null>(null);
  const allowClose = useRef(false);
  const [draft, setDraft] = useState<Entry | null>(null);
  const draftRef = useRef<Entry | null>(null);
  draftRef.current = draft;
  const [baseline, setBaseline] = useState("");
  const [reveal, setReveal] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const settingsButton = useRef<HTMLButtonElement>(null);
  const restoreSettingsFocus = useRef(false);
  const [modal, setModal] = useState<Modal | "reset" | "delete" | null>(null);
  const skipDeleteConfirmation = useRef(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const editorForm = useRef<HTMLFormElement>(null);
  const epoch = useRef(0);
  const pendingAction = useRef<(() => void) | null>(null);
  const dirty = draft !== null && JSON.stringify(draft) !== baseline;
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const openRef = useRef(false);
  openRef.current = phase === "open";
  const reload = () => setRefresh((v) => v + 1);
  const renderedEpoch = epoch.current;
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    document.documentElement.lang = language;
    document.documentElement.dir = language === "fa" ? "rtl" : "ltr";
    try {
      localStorage.setItem("nook.language", language);
    } catch {
      /* Non-secret preferences are optional. */
    }
  }, [language]);
  const clearSensitive = useCallback(() => {
    epoch.current++;
    selectedRef.current = null;
    openRef.current = false;
    setPhase("locked");
    setEntry(null);
    setDraft(null);
    setBaseline("");
    setSelectedId(null);
    setPage(emptyPage);
    setReveal(false);
    setRevealRequest(null);
    setShowSettings(false);
    restoreSettingsFocus.current = false;
    setModal(null);
    setQuery("");
    setDebounced("");
    setError("");
    setToast("");
    setBusy(false);
    setPageIndex(0);
    setFolder("");
    setFilter("all");
    pendingAction.current = null;
    setBrowserFill(null);
    setBrowserSave(null);
  }, []);
  const fail = useCallback(
    (cause: unknown) => {
      const code = String(cause);
      if (!code) {
        setError("");
        return;
      }
      if (code === "stale") return;
      if (code === "locked") {
        clearSensitive();
        return;
      }
      setError(tRef.current(code in en ? (code as TextKey) : "genericError"));
    },
    [clearSensitive],
  );
  async function request<T>(
    command: string,
    args: Record<string, unknown> = {},
  ): Promise<T> {
    const generation = epoch.current;
    try {
      const result = await call<T>(command, args);
      if (generation !== epoch.current) throw "stale";
      return result;
    } catch (cause) {
      if (generation !== epoch.current) throw "stale";
      throw cause;
    }
  }
  useEffect(() => {
    let active = true;
    call<Status>("vault_status")
      .then((status) => {
        if (active) {
          setExists(status.exists);
          setPhase(status.unlocked ? "open" : "locked");
        }
      })
      .catch((cause) => {
        if (active) {
          if (native) fail(cause);
          setPhase("unavailable");
        }
      });
    const unlisten = native
      ? listen("vault-locked", clearSensitive)
      : Promise.resolve(() => {});
    return () => {
      active = false;
      void unlisten.then((fn) => fn());
    };
  }, [clearSensitive, fail]);
  useEffect(() => {
    if (!entry || entry.protected || !entry.grantExpiresAt || draft) return;
    const id = entry.id;
    const timer = setTimeout(
      () => {
        setEntry((value) => (value?.id === id ? redact(value) : value));
      },
      Math.max(0, entry.grantExpiresAt * 1000 - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [entry?.id, entry?.protected, entry?.grantExpiresAt, draft]);
  useEffect(() => {
    if (phase !== "open" || showSettings || modal || draft || busy) return;
    let active = true;
    const poll = () =>
      void Promise.all([
        request<BrowserFill | null>("pending_browser_fill"),
        request<BrowserSave | null>("pending_browser_save"),
      ])
        .then(([value, save]) => {
          if (active) {
            setBrowserFill(value);
            setBrowserSave(save);
            if (save && save.id !== browserSave?.id) setError("");
            if (value && value.id !== browserFill?.id) setError("");
          }
        })
        .catch(fail);
    poll();
    const timer = setInterval(poll, 1000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [phase, showSettings, modal, !!draft, busy, browserFill?.id, browserSave?.id, fail]);
  async function decideBrowserSave(
    allow: boolean,
    secret: string | null,
    target: string,
    username: string,
    title: string,
  ) {
    if (!browserSave || busy) return;
    setBusy(true);
    setError("");
    try {
      const id = await request<string | null>("decide_browser_save", {
        decision: {
          id: browserSave.id,
          allow,
          secret,
          target,
          username,
          title,
        },
      });
      setBrowserSave(null);
      if (id) {
        reload();
        await select(id);
        message(
          browserSave.kind === "update"
            ? "browserLoginUpdated"
            : "browserLoginSaved",
        );
      }
    } catch (cause) {
      if (String(cause) === "browserExpired") setBrowserSave(null);
      fail(cause);
    } finally {
      setBusy(false);
    }
  }
  async function decideBrowserFill(allow: boolean, secret: string) {
    if (!browserFill || busy) return;
    setBusy(true);
    setError("");
    try {
      await request("decide_browser_fill", {
        id: browserFill.id,
        allow,
        secret,
      });
      setBrowserFill(null);
    } catch (cause) {
      if (String(cause) === "browserExpired") setBrowserFill(null);
      fail(cause);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (!native) return;
    const off = getCurrentWindow().onCloseRequested((event) => {
      if (dirtyRef.current && !allowClose.current) {
        event.preventDefault();
        pendingAction.current = () => {
          allowClose.current = true;
          void getCurrentWindow().close().catch(fail);
        };
        setModal("discard");
      }
    });
    return () => {
      void off.then((fn) => fn());
    };
  }, [fail]);
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(query);
      setPageIndex(0);
    }, 160);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 3800);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (phase !== "open") return;
    let active = true;
    const generation = epoch.current;
    setListLoading(true);
    call<Page>("list_entries", {
      query: {
        search: debounced,
        filter,
        folder,
        sort,
        offset: pageIndex * PAGE_SIZE,
        limit: PAGE_SIZE,
      },
    })
      .then((result) => {
        if (!active || generation !== epoch.current) return;
        setPage(result);
        if (pageIndex > 0 && result.items.length === 0) {
          setPageIndex(0);
          return;
        }
        if (!selectedRef.current && !draftRef.current && result.items[0]) {
          const id = result.items[0].id;
          selectedRef.current = id;
          setSelectedId(id);
          call<EntryView>("get_entry", { id })
            .then((value) => {
              if (
                active &&
                generation === epoch.current &&
                selectedRef.current === id
              )
                setEntry(value);
            })
            .catch((cause) => {
              if (active && generation === epoch.current) fail(cause);
            });
        }
      })
      .catch((cause) => {
        if (active && generation === epoch.current) fail(cause);
      })
      .finally(() => {
        if (active) setListLoading(false);
      });
    return () => {
      active = false;
    };
  }, [phase, debounced, filter, folder, sort, pageIndex, refresh, fail]);
  useEffect(() => {
    if (phase !== "open") return;
    let lastTouch = Date.now();
    const activity = () => {
      if (Date.now() - lastTouch > 10_000) {
        lastTouch = Date.now();
        void call("touch_session").catch(fail);
      }
    };
    const visibility = () => {
      if (document.hidden) {
        clearSensitive();
        void call("lock_vault").catch(() => {});
      }
    };
    document.addEventListener("pointerdown", activity);
    document.addEventListener("keydown", activity);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      document.removeEventListener("pointerdown", activity);
      document.removeEventListener("keydown", activity);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [phase, clearSensitive, fail]);
  useEffect(() => {
    const keyboard = (e: KeyboardEvent) => {
      if (!openRef.current || !(e.ctrlKey || e.metaKey)) return;
      if (e.key.toLowerCase() === "l" && e.shiftKey) {
        e.preventDefault();
        void lock();
        return;
      }
      if (showSettings) return;
      if (
        e.key.toLowerCase() === "s" &&
        draftRef.current &&
        !modal &&
        !browserFill &&
        !browserSave
      ) {
        e.preventDefault();
        editorForm.current?.requestSubmit();
      } else if (
        e.key.toLowerCase() === "n" &&
        !modal &&
        !browserFill &&
        !browserSave
      ) {
        e.preventDefault();
        startNew();
      } else if (
        e.key.toLowerCase() === "k" &&
        !modal &&
        !browserFill &&
        !browserSave
      ) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    document.addEventListener("keydown", keyboard);
    return () => document.removeEventListener("keydown", keyboard);
  });
  function message(key: TextKey, suffix = "") {
    setToast(t(key) + suffix);
    setError("");
  }
  function closeModal() {
    setModal(null);
    setError("");
    pendingAction.current = null;
  }
  function guard(action: () => void) {
    if (busy) return;
    if (dirtyRef.current) {
      pendingAction.current = action;
      setModal("discard");
    } else action();
  }
  useLayoutEffect(() => {
    if (!showSettings && restoreSettingsFocus.current) {
      restoreSettingsFocus.current = false;
      settingsButton.current?.focus();
    }
  }, [showSettings]);
  function closeSettings() {
    restoreSettingsFocus.current = true;
    setShowSettings(false);
    setError("");
  }
  function quit() {
    if (native)
      guard(() => {
        allowClose.current = true;
        void getCurrentWindow().close().catch(fail);
      });
  }
  function startNew() {
    guard(() => {
      const next = blankEntry();
      setDraft(next);
      setBaseline(JSON.stringify(next));
      setReveal(false);
      setError("");
    });
  }
  async function authenticate(password: string, enableCloud: boolean) {
    setBusy(true);
    setError("");
    try {
      await request(exists ? "unlock_vault" : "create_vault", { password });
      let cloudError: unknown;
      if (!exists && enableCloud && native) {
        try {
          await request("cloud_enable", { enabled: true });
        } catch (cause) {
          cloudError = cause;
        }
      }
      const status = await request<Status>("vault_status");
      setExists(true);
      setPhase(status.unlocked ? "open" : "locked");
      if (cloudError) {
        fail(cloudError);
        if (status.unlocked) setShowSettings(true);
      }
      reload();
      if (status.legacyPinRetired) message("legacyPinRetired");
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  }
  async function lock() {
    clearSensitive();
    try {
      await call("lock_vault");
    } catch {
      setError(tRef.current("genericError"));
    }
  }
  async function resetLocal(master: string) {
    if (busy || resetting) return;
    setBusy(true);
    setResetting(true);
    setError("");
    try {
      // A native lock event can arrive while the reset is finishing.
      // Apply the successful reset even if that event has already cleared the vault view.
      await call("reset_local", { master });
      skipDeleteConfirmation.current = false;
      clearSensitive();
      setExists(false);
      setSort("recent");
      setTheme(matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
      setLanguage("en");
      try {
        localStorage.removeItem("passward.theme");
        localStorage.removeItem("nook.language");
      } catch {}
    } catch (cause) {
      fail(cause);
    } finally {
      setResetting(false);
      setBusy(false);
    }
  }
  function select(id: string) {
    guard(() => {
      selectedRef.current = id;
      setSelectedId(id);
      setEntry(null);
      setDraft(null);
      setRevealRequest(null);
      setError("");
      const generation = epoch.current;
      void call<EntryView>("get_entry", { id })
        .then((value) => {
          if (generation === epoch.current && selectedRef.current === id)
            setEntry(value);
        })
        .catch((cause) => {
          if (generation === epoch.current) fail(cause);
        });
    });
  }
  function updateDraft(patch: Partial<Entry>) {
    setDraft((value) => (value ? { ...value, ...patch } : null));
  }
  function requestItemAccess(
    action: (value: EntryView) => void | Promise<void>,
    force = false,
  ) {
    if (!entry || (busy && !force)) return;
    void action(entry);
  }
  function revealField(field: string) {
    requestItemAccess(() => {
      setRevealRequest((value) => ({
        field,
        sequence: (value?.sequence ?? 0) + 1,
      }));
    });
  }
  async function securityRefresh() {
    setEntry(null);
    setDraft(null);
    setRevealRequest(null);
    setBaseline("");
    selectedRef.current = null;
    setSelectedId(null);
    reload();
  }
  function editEntry() {
    requestItemAccess((value) => {
      const next = editable(value);
      setDraft(next);
      setBaseline(JSON.stringify(next));
      setReveal(false);
      setRevealRequest(null);
      setError("");
    });
  }
  async function persist(value: Entry) {
    setBusy(true);
    setError("");
    try {
      const saved = await request<EntryView>("save_entry", { entry: value });
      setRevealRequest(null);
      setEntry(saved);
      selectedRef.current = saved.id;
      setSelectedId(saved.id);
      setDraft(null);
      setBaseline("");
      setFilter("all");
      setFolder("");
      setQuery("");
      setPageIndex(0);
      reload();
      message("saved");
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  }
  function cancelEdit() {
    guard(() => {
      setDraft(null);
      setReveal(false);
      setError("");
    });
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!draft || busy) return;
    if (!draft.title.trim()) {
      setError(t("required"));
      return;
    }
    await persist(draft);
  }
  async function favorite() {
    if (!entry || busy) return;
    setBusy(true);
    try {
      const saved = await request<EntryView>("set_favorite", {
        id: entry.id,
        favorite: !entry.favorite,
      });
      setEntry(saved);
      reload();
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  }
  async function copy(field: string) {
    if (!entry) return;
    if (!["username", "url"].includes(field)) {
      requestItemAccess((value) => performCopy(value.id, field));
      return;
    }
    await performCopy(entry.id, field);
  }
  async function performCopy(id: string, field: string) {
    try {
      await request("copy_field", { id, field });
      message("copied");
    } catch (cause) {
      fail(cause);
    }
  }
  async function performDelete(
    master: string | null,
    skipConfirmation: boolean,
  ) {
    if (!entry || busy) return;
    const id = entry.id;
    setBusy(true);
    try {
      skipDeleteConfirmation.current = await request<boolean>("delete_entry", {
        id,
        master,
        skipConfirmation,
      });
      setEntry(null);
      selectedRef.current = null;
      setSelectedId(null);
      setModal(null);
      reload();
      message("deleted");
    } catch (cause) {
      if (cause === "deletePasswordRequired" && master === null) {
        skipDeleteConfirmation.current = false;
        setModal("delete");
      } else {
        fail(cause);
      }
    } finally {
      setBusy(false);
    }
  }
  const filtered = Boolean(debounced || folder);
  const emptyTitle: TextKey = filtered
    ? "noResults"
    : filter === "favorites"
      ? "emptyFavorites"
      : "emptyTitle";
  const emptyBody: TextKey = filtered
    ? "noResultsBody"
    : filter === "favorites"
      ? "emptyFavoritesBody"
      : "emptyBody";

  return (
    <IconContext.Provider value={{ size: 18, weight: "regular" }}>
      <div className={`app ${draft || selectedId ? "has-detail" : ""}`}>
        <header className="topbar" data-tauri-drag-region>
          <div
            className="topbar-main"
            dir={language === "fa" ? "rtl" : "ltr"}
            data-tauri-drag-region
          >
            <div className="brand" data-tauri-drag-region>
              <span className="brand-symbol brand-logo" aria-hidden="true">
                <svg
                  width="32"
                  height="32"
                  viewBox="0 0 64 64"
                  fill="none"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path
                    stroke="currentColor"
                    d="M20 8 8 16v29l12 11 12-10 12 10 12-11V16L44 8"
                  />
                  <path
                    className="brand-asterisk"
                    d="M32 19v20M23.34 24l17.32 10M23.34 34l17.32-10"
                  />
                </svg>
              </span>
              <span className="brand-wordmark">PassWards</span>
              {phase === "open" && (
                <span className="vault-label">{t("personalVault")}</span>
              )}
            </div>
            <div className="top-actions">
              <IconButton
                label={t(theme === "dark" ? "themeLight" : "themeDark")}
                onClick={() => {
                  const next = theme === "dark" ? "light" : "dark";
                  setTheme(next);
                  try {
                    localStorage.setItem("passward.theme", next);
                  } catch {}
                }}
              >
                {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
              </IconButton>
              {PERSIAN_ENABLED && (
                <button
                  type="button"
                  className="language-button"
                  title={t("language")}
                  aria-label={t("language")}
                  onClick={() =>
                    setLanguage((value) => (value === "en" ? "fa" : "en"))
                  }
                >
                  <Globe size={15} />
                  <span>{language === "en" ? "فارسی" : "English"}</span>
                </button>
              )}
              {phase === "open" && (
                <>
                  <span className="action-divider" />
                  <button
                    ref={settingsButton}
                    type="button"
                    className="icon-button"
                    aria-label={t("settings")}
                    title={t("settings")}
                    disabled={busy || showSettings}
                    onClick={() =>
                      guard(() => {
                        setShowSettings(true);
                        setError("");
                      })
                    }
                  >
                    <GearSix />
                  </button>
                  <IconButton label={t("lock")} onClick={() => void lock()}>
                    <LockSimple />
                  </IconButton>
                </>
              )}
            </div>
          </div>
          <WindowControls
            t={t}
            onError={fail}
            onClose={quit}
          />
        </header>
        {preview && <div className="preview-banner">{t("preview")}</div>}
        {phase === "loading" && (
          <main className="center-state">
            <CircleNotch className="spin" />
            <p>{t("loading")}</p>
          </main>
        )}
        {phase === "unavailable" && (
          <main className="center-state">
            <LockSimple size={28} />
            <h1>PassWards</h1>
            <p>{error || t("desktopOnly")}</p>
          </main>
        )}
        {phase === "locked" && (
          <Auth
            key={exists ? "unlock" : "create"}
            exists={exists}
            onUnlock={(password, enableCloud) => void authenticate(password, enableCloud)}
            onClearError={() => setError("")}
            onRestored={() => {
              setExists(true);
              message("cloudRestored");
            }}
            extensionInstall={<ExtensionInstall t={t} />}
            t={t}
            error={error}
            busy={busy || resetting}
          />
        )}
        {phase === "open" && showSettings && (
          <SettingsPage
            updates={updates}
            t={t}
            language={language}
            busy={busy}
            error={modal ? "" : error}
            run={request}
            onBusy={(value) => {
              if (renderedEpoch === epoch.current) setBusy(value);
            }}
            onError={fail}
            onMessage={message}
            onBack={closeSettings}
            onModal={(value) => {
              setError("");
              setModal(value);
            }}
          />
        )}
        {phase === "open" && !showSettings && (
          <>
            <div className="toolbar">
              <div className="search-field">
                <MagnifyingGlass />
                <input
                  ref={searchRef}
                  name="search"
                  aria-label={t("search")}
                  placeholder={t("search")}
                  value={query}
                  onChange={(e) => {
                    const value = e.target.value;
                    guard(() => setQuery(value));
                  }}
                  autoComplete="off"
                  spellCheck={false}
                />
                <kbd>Ctrl K</kbd>
                {query && (
                  <IconButton
                    label={t("clearFilters")}
                    onClick={() => setQuery("")}
                  >
                    <X size={14} />
                  </IconButton>
                )}
              </div>
              <button
                type="button"
                className={`${draft ? "secondary" : "primary"} new-button`}
                onClick={startNew}
                disabled={busy}
              >
                <Plus />
                <span>{t("new")}</span>
              </button>
            </div>
            <main className="workspace">
              <section className="list-pane" aria-label={t("all")}>
                <nav
                  className="filters"
                  data-filter={filter}
                  aria-label={t("personalVault")}
                >
                  {(["all", "favorites"] as const).map((value) => (
                    <button
                      type="button"
                      key={value}
                      aria-pressed={filter === value}
                      className={filter === value ? "selected" : ""}
                      onClick={() =>
                        guard(() => {
                          setFilter(value);
                          setPageIndex(0);
                          setDraft(null);
                          setEntry(null);
                          setSelectedId(null);
                          selectedRef.current = null;
                        })
                      }
                    >
                      {t(value)}
                      <span>
                        {value === "all" ? page.allCount : page.favoriteCount}
                      </span>
                    </button>
                  ))}
                </nav>
                <div className="list-options">
                  <Dropdown
                    label={t("folder")}
                    value={folder}
                    options={[
                      { value: "", label: t("allFolders") },
                      ...page.folders.map((value) => ({ value, label: value })),
                    ]}
                    onChange={(value) =>
                      guard(() => {
                        setFolder(value);
                        setPageIndex(0);
                      })
                    }
                  />
                  <Dropdown
                    label={t("sort")}
                    align="end"
                    value={sort}
                    options={[
                      { value: "recent", label: t("recent") },
                      { value: "title", label: t("alphabetical") },
                    ]}
                    onChange={(value) => {
                      setSort(value);
                      setPageIndex(0);
                    }}
                  />
                </div>
                <div
                  className={`entry-list ${listLoading ? "is-loading" : ""}`}
                  aria-busy={listLoading}
                >
                  <div
                    className="entry-list-content"
                    key={`${filter}:${folder}:${sort}:${pageIndex}`}
                  >
                    {page.items.map((item) => (
                      <button
                        type="button"
                        className={`entry-row ${selectedId === item.id && !draft ? "active" : ""}`}
                        key={item.id}
                        onClick={() => select(item.id)}
                        aria-pressed={selectedId === item.id && !draft}
                      >
                        <SiteIcon title={item.title} favicon={item.favicon} />
                        <span className="entry-row-copy">
                          <strong dir="auto">{item.title}</strong>
                          <span dir="auto">
                            {item.username ||
                              hostname(item.url) ||
                              t("noFolder")}
                          </span>
                        </span>
                        {item.favorite && (
                          <Star className="row-star" size={13} weight="fill" />
                        )}
                      </button>
                    ))}
                  </div>
                  {!listLoading && page.total === 0 && (
                    <div className="list-empty">
                      <span className="empty-icon">
                        {filtered ? (
                          <MagnifyingGlass size={23} weight="light" />
                        ) : (
                          <Key size={23} weight="light" />
                        )}
                      </span>
                      <h2>{t(emptyTitle)}</h2>
                      <p>{t(emptyBody)}</p>
                      {filtered && (
                        <button
                          type="button"
                          className="text-button"
                          onClick={() => {
                            setQuery("");
                            setFolder("");
                          }}
                        >
                          {t("clearFilters")}
                        </button>
                      )}
                    </div>
                  )}
                </div>
                <footer className="list-footer">
                  <span>
                    {page.total} {t("items")}
                  </span>
                  {page.total > PAGE_SIZE ? (
                    <div className="pagination">
                      <IconButton
                        label={t("previous")}
                        disabled={pageIndex === 0 || listLoading}
                        onClick={() => guard(() => setPageIndex((v) => v - 1))}
                      >
                        {language === "fa" ? (
                          <ArrowRight size={14} />
                        ) : (
                          <ArrowLeft size={14} />
                        )}
                      </IconButton>
                      <span>
                        {pageIndex + 1} / {Math.ceil(page.total / PAGE_SIZE)}
                      </span>
                      <IconButton
                        label={t("next")}
                        disabled={
                          (pageIndex + 1) * PAGE_SIZE >= page.total ||
                          listLoading
                        }
                        onClick={() => guard(() => setPageIndex((v) => v + 1))}
                      >
                        {language === "fa" ? (
                          <ArrowLeft size={14} />
                        ) : (
                          <ArrowRight size={14} />
                        )}
                      </IconButton>
                    </div>
                  ) : (
                    <span className="local-indicator">
                      <span />
                      {t("local")}
                    </span>
                  )}
                </footer>
              </section>
              <section
                className="detail-pane"
                aria-busy={Boolean(selectedId && !entry && !draft)}
                aria-label={
                  draft ? t("editTitle") : entry?.title || t("personalVault")
                }
              >
                {(selectedId || draft) && (
                  <button
                    type="button"
                    className="mobile-back text-button"
                    onClick={() =>
                      guard(() => {
                        setDraft(null);
                        setEntry(null);
                        setSelectedId(null);
                        selectedRef.current = null;
                      })
                    }
                  >
                    {language === "fa" ? <ArrowRight /> : <ArrowLeft />}
                    {t("back")}
                  </button>
                )}
                {draft ? (
                  <EntryForm
                    key={`edit:${draft.id || "new"}`}
                    draft={draft}
                    folders={page.folders}
                    reveal={reveal}
                    busy={busy}
                    t={t}
                    formRef={editorForm}
                    onSubmit={(e) => void save(e)}
                    onChange={updateDraft}
                    onCancel={cancelEdit}
                    onReveal={() => {
                      if (reveal || !draft.id) setReveal((v) => !v);
                      else requestItemAccess(() => setReveal(true));
                    }}
                  />
                ) : entry ? (
                  <EntryDetail
                    key={entry.id}
                    entry={entry}
                    t={t}
                    language={language}
                    busy={busy}
                    onFavorite={() => void favorite()}
                    onEdit={editEntry}
                    revealRequest={revealRequest}
                    onReveal={revealField}
                    onCopy={(field) => void copy(field)}
                    onOpen={() =>
                      void request("open_website", { id: entry.id }).catch(fail)
                    }
                    onDelete={() => {
                      setError("");
                      if (skipDeleteConfirmation.current) void performDelete(null, false);
                      else setModal("delete");
                    }}
                  />
                ) : selectedId ? (
                  <div className="detail-loading" aria-hidden="true">
                    <span />
                    <span />
                    <span />
                  </div>
                ) : (
                  <div className="detail-placeholder">
                    <span className="placeholder-mark">
                      <Key size={36} weight="light" />
                    </span>
                    <h2>{t("chooseTitle")}</h2>
                    <p>{t("chooseBody")}</p>
                    <span className="quiet-shortcut">
                      <kbd>Ctrl N</kbd>
                      {t("shortcutNew")}
                    </span>
                  </div>
                )}
              </section>
            </main>
            {error && !modal && !browserFill && !browserSave && (
              <div className="error-bar" role="alert">
                <span>{error}</span>
                <IconButton label={t("close")} onClick={() => setError("")}>
                  <X size={15} />
                </IconButton>
              </div>
            )}
          </>
        )}
        <MotionPresence key={phase}>
          {toast && (
            <div className="toast" role="status">
              <Check size={16} />
              <span>{toast}</span>
            </div>
          )}
        </MotionPresence>
        {phase === "open" && (
          <MotionPresence>
            {modal === "reset" || modal === "delete" ? (
              (modal === "reset" || entry) && <DestructiveDialog
                key={modal}
                itemTitle={modal === "delete" ? entry?.title : undefined}
                t={t}
                busy={modal === "reset" ? resetting : busy}
                error={error}
                onClose={closeModal}
                onConfirm={modal === "reset" ? resetLocal : performDelete}
              />
            ) : modal && (
              <VaultDialogs
                key={modal}
                modal={modal}
                t={t}
                language={language}
                busy={busy}
                error={error}
                run={request}
                onBusy={(value) => {
                  if (renderedEpoch === epoch.current) setBusy(value);
                }}
                onError={fail}
                onClose={closeModal}
                onMessage={message}
                onImported={() => {
                  void securityRefresh().catch(fail);
                }}
                onDiscard={() => {
                  const action = pendingAction.current;
                  pendingAction.current = null;
                  setModal(null);
                  setDraft(null);
                  setError("");
                  action?.();
                }}
              />
            )}
          </MotionPresence>
        )}
        {phase === "open" && (
          <MotionPresence>
            {browserFill && !showSettings && !modal && (
              <BrowserFillDialog
                key={browserFill.id}
                request={browserFill}
                t={t}
                busy={busy}
                error={error}
                onDecide={decideBrowserFill}
              />
            )}
          </MotionPresence>
        )}
        {phase === "open" && (
          <MotionPresence>
            {browserSave && !showSettings && !modal && !browserFill && (
              <BrowserSaveDialog
                key={browserSave.id}
                request={browserSave}
                t={t}
                busy={busy}
                error={error}
                onDecide={decideBrowserSave}
              />
            )}
          </MotionPresence>
        )}
        <UpdateWidget
          {...updates}
          hidden={!!modal || !!browserFill || !!browserSave || phase === "loading"}
          installDisabled={busy}
          onInstall={() => guard(updates.install)}
        />
      </div>
    </IconContext.Provider>
  );
}
