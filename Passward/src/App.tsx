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
  Trash,
  X,
  Sun,
  Moon,
} from "@phosphor-icons/react";
import {
  blankEntry,
  call,
  native,
  preview,
  type Entry,
  type Page,
  type Status,
  type EntryView,
  type PinInfo,
  noPin,
  editable,
  redact,
} from "./api";
import { en, translator, type Key as TextKey, type Language } from "./i18n";
import { Auth, hostname, IconButton, initials } from "./ui";
import EntryForm from "./EntryForm";
import EntryDetail from "./EntryDetail";
import VaultDialogs, { type Modal } from "./VaultDialogs";
import PinDialog, { type PinTask } from "./PinDialog";
import WindowControls from "./WindowControls";
import BrowserFillDialog, { type BrowserFill } from "./BrowserFillDialog";
import "./App.css";
import brandIcon from "../app-icon.svg";

const emptyPage: Page = {
  items: [],
  total: 0,
  allCount: 0,
  favoriteCount: 0,
  trashCount: 0,
  folders: [],
};
const PAGE_SIZE = 50;
function initialLanguage(): Language {
  try {
    return localStorage.getItem("nook.language") === "fa" ? "fa" : "en";
  } catch {
    return "en";
  }
}
export default function App() {
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
  const [pin, setPin] = useState<PinInfo>(noPin);
  const [pinTask, setPinTask] = useState<PinTask | null>(null);
  const [browserFill, setBrowserFill] = useState<BrowserFill | null>(null);
  const pendingItemAction = useRef<
    ((value: EntryView) => void | Promise<void>) | null
  >(null);
  const [revealRequest, setRevealRequest] = useState(0);
  const allowClose = useRef(false);
  const [draft, setDraft] = useState<Entry | null>(null);
  const draftRef = useRef<Entry | null>(null);
  draftRef.current = draft;
  const [baseline, setBaseline] = useState("");
  const [reveal, setReveal] = useState(false);
  const [modal, setModal] = useState<Modal | null>(null);
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
    setExists(true);
    setEntry(null);
    setDraft(null);
    setBaseline("");
    setSelectedId(null);
    setPage(emptyPage);
    setReveal(false);
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
    setPinTask(null);
    setBrowserFill(null);
    pendingItemAction.current = null;
  }, []);
  const fail = useCallback(
    (cause: unknown) => {
      const code = String(cause);
      if (code === "stale") return;
      if (code === "locked") {
        clearSensitive();
        return;
      }
      setError(tRef.current(code in en ? (code as TextKey) : "genericError"));
      if (code.startsWith("pin") || code === "invalidPin")
        void call<Status>("vault_status")
          .then((s) => setPin(s.pin))
          .catch(() => {});
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
          setPin(status.pin);
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
    if (phase !== "open" || modal || pinTask || draft || busy) return;
    let active = true;
    const poll = () =>
      void request<BrowserFill | null>("pending_browser_fill")
        .then((value) => {
          if (active) {
            setBrowserFill(value);
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
  }, [phase, modal, pinTask, !!draft, busy, browserFill?.id, fail]);
  async function decideBrowserFill(
    allow: boolean,
    secret: string,
    method: string,
  ) {
    if (!browserFill || busy) return;
    setBusy(true);
    setError("");
    try {
      await request("decide_browser_fill", {
        id: browserFill.id,
        allow,
        secret,
        method,
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
        setPinTask(null);
        pendingItemAction.current = null;
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
      } else if (
        e.key.toLowerCase() === "s" &&
        draftRef.current &&
        !modal &&
        !pinTask &&
        !browserFill
      ) {
        e.preventDefault();
        editorForm.current?.requestSubmit();
      } else if (
        e.key.toLowerCase() === "n" &&
        !modal &&
        !pinTask &&
        !browserFill
      ) {
        e.preventDefault();
        startNew();
      } else if (
        e.key.toLowerCase() === "k" &&
        !modal &&
        !pinTask &&
        !browserFill
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
  function startNew() {
    guard(() => {
      const next = blankEntry();
      setDraft(next);
      setBaseline(JSON.stringify(next));
      setReveal(false);
      setError("");
    });
  }
  async function authenticate(password: string, method: "master" | "pin") {
    setBusy(true);
    setError("");
    try {
      await request(
        !exists
          ? "create_vault"
          : method === "pin"
            ? "unlock_with_pin"
            : "unlock_vault",
        method === "pin" && exists ? { pin: password } : { password },
      );
      const status = await request<Status>("vault_status");
      setPin(status.pin);
      setExists(true);
      setPhase("open");
      reload();
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
  function select(id: string) {
    guard(() => {
      selectedRef.current = id;
      setSelectedId(id);
      setEntry(null);
      setDraft(null);
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
    if (!entry) return;
    if (
      force ||
      entry.protected ||
      (entry.grantExpiresAt > 0 && entry.grantExpiresAt * 1000 <= Date.now())
    ) {
      pendingItemAction.current = action;
      setModal(null);
      setError("");
      setPinTask({ kind: "item", id: entry.id, title: entry.title });
    } else void action(entry);
  }
  async function securityRefresh() {
    const status = await request<Status>("vault_status");
    setPin(status.pin);
    setEntry(null);
    setDraft(null);
    setBaseline("");
    selectedRef.current = null;
    setSelectedId(null);
    reload();
  }
  async function pinDone(value?: EntryView) {
    const task = pinTask;
    const action = pendingItemAction.current;
    pendingItemAction.current = null;
    setPinTask(null);
    setError("");
    const status = await request<Status>("vault_status");
    setPin(status.pin);
    if (value) {
      if (selectedRef.current === value.id) {
        setEntry(value);
        await action?.(value);
      }
    } else {
      await securityRefresh();
      message(task?.kind === "remove" ? "pinRemoved" : "pinSaved");
      setModal("settings");
    }
  }
  function editEntry() {
    requestItemAccess((value) => {
      const next = editable(value);
      setDraft(next);
      setBaseline(JSON.stringify(next));
      setReveal(false);
      setError("");
    });
  }
  async function persist(value: Entry) {
    setBusy(true);
    setError("");
    try {
      const saved = await request<EntryView>("save_entry", { entry: value });
      setEntry(saved);
      selectedRef.current = saved.id;
      setSelectedId(saved.id);
      setDraft(null);
      setBaseline("");
      setFilter(saved.deleted ? "trash" : "all");
      setFolder("");
      setQuery("");
      setPageIndex(0);
      reload();
      message("saved");
    } catch (cause) {
      if (String(cause) === "pinRequired")
        requestItemAccess(() => persist(value), true);
      else fail(cause);
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
  async function moveTrash(deleted: boolean) {
    if (!entry || busy) return;
    requestItemAccess((value) => performMove(value.id, deleted));
  }
  async function performMove(id: string, deleted: boolean) {
    setBusy(true);
    try {
      await request("trash_entry", { id, deleted });
      setEntry(null);
      selectedRef.current = null;
      setSelectedId(null);
      reload();
      message(deleted ? "movedTrash" : "restored");
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  }
  async function permanentDelete() {
    if (!entry || busy) return;
    requestItemAccess((value) => performDelete(value.id));
  }
  async function performDelete(id: string) {
    setBusy(true);
    try {
      await request("delete_entry", { id });
      setEntry(null);
      selectedRef.current = null;
      setSelectedId(null);
      setModal(null);
      reload();
      message("deleted");
    } catch (cause) {
      fail(cause);
    } finally {
      setBusy(false);
    }
  }
  const filtered = Boolean(debounced || folder);
  const emptyTitle: TextKey = filtered
    ? "noResults"
    : filter === "favorites"
      ? "emptyFavorites"
      : filter === "trash"
        ? "emptyTrash"
        : "emptyTitle";
  const emptyBody: TextKey = filtered
    ? "noResultsBody"
    : filter === "favorites"
      ? "emptyFavoritesBody"
      : filter === "trash"
        ? "emptyTrashBody"
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
              <span className="brand-symbol brand-logo">
                <img src={brandIcon} width={28} height={28} alt="" />
              </span>
              <span>passward</span>
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
              {phase === "open" && (
                <>
                  <span className="action-divider" />
                  <IconButton
                    label={t("settings")}
                    onClick={() =>
                      guard(() => {
                        setModal("settings");
                        setError("");
                      })
                    }
                  >
                    <GearSix />
                  </IconButton>
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
            onClose={() => {
              if (native)
                guard(() => {
                  allowClose.current = true;
                  void getCurrentWindow().close().catch(fail);
                });
            }}
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
            <h1>Passward</h1>
            <p>{error || t("desktopOnly")}</p>
          </main>
        )}
        {phase === "locked" && (
          <Auth
            key={exists ? "unlock" : "create"}
            exists={exists}
            onUnlock={(password, method) => void authenticate(password, method)}
            pin={pin}
            t={t}
            error={error}
            busy={busy}
          />
        )}
        {phase === "open" && (
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
                <nav className="filters" aria-label={t("personalVault")}>
                  {(["all", "favorites", "trash"] as const).map((value) => (
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
                        {value === "all"
                          ? page.allCount
                          : value === "favorites"
                            ? page.favoriteCount
                            : page.trashCount}
                      </span>
                    </button>
                  ))}
                </nav>
                <div className="list-options">
                  <select
                    name="folder-filter"
                    aria-label={t("folder")}
                    value={folder}
                    onChange={(e) => {
                      const value = e.target.value;
                      guard(() => {
                        setFolder(value);
                        setPageIndex(0);
                      });
                    }}
                  >
                    <option value="">{t("allFolders")}</option>
                    {page.folders.map((value) => (
                      <option key={value}>{value}</option>
                    ))}
                  </select>
                  <select
                    name="sort"
                    aria-label={t("sort")}
                    value={sort}
                    onChange={(e) => {
                      setSort(e.target.value);
                      setPageIndex(0);
                    }}
                  >
                    <option value="recent">{t("recent")}</option>
                    <option value="title">{t("alphabetical")}</option>
                  </select>
                </div>
                <div
                  className={`entry-list ${listLoading ? "is-loading" : ""}`}
                  aria-busy={listLoading}
                >
                  {page.items.map((item) => (
                    <button
                      type="button"
                      className={`entry-row ${selectedId === item.id && !draft ? "active" : ""}`}
                      key={item.id}
                      onClick={() => select(item.id)}
                      aria-pressed={selectedId === item.id && !draft}
                    >
                      <span className="monogram" aria-hidden="true">
                        {initials(item.title)}
                      </span>
                      <span className="entry-row-copy">
                        <strong dir="auto">{item.title}</strong>
                        <span dir="auto">
                          {item.username || hostname(item.url) || t("noFolder")}
                        </span>
                      </span>
                      {item.favorite && (
                        <Star className="row-star" size={13} weight="fill" />
                      )}
                    </button>
                  ))}
                  {!listLoading && page.total === 0 && (
                    <div className="list-empty">
                      <span className="empty-icon">
                        {filter === "trash" ? (
                          <Trash size={23} weight="light" />
                        ) : filtered ? (
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
                    draft={draft}
                    folders={page.folders}
                    reveal={reveal}
                    busy={busy}
                    t={t}
                    formRef={editorForm}
                    onSubmit={(e) => void save(e)}
                    onChange={updateDraft}
                    onCancel={cancelEdit}
                    onReveal={() => setReveal((v) => !v)}
                    onGenerate={() => {
                      setModal("generator");
                      setError("");
                    }}
                  />
                ) : entry ? (
                  <EntryDetail
                    entry={entry}
                    t={t}
                    language={language}
                    busy={busy}
                    onFavorite={() => void favorite()}
                    onEdit={editEntry}
                    revealRequest={revealRequest}
                    pinEnabled={pin.enabled}
                    onUnlock={() =>
                      requestItemAccess(() => {
                        setRevealRequest((v) => v + 1);
                      })
                    }
                    onRelock={() => {
                      void request<EntryView>("lock_entry", { id: entry.id })
                        .then(setEntry)
                        .catch(fail);
                    }}
                    onCopy={(field) => void copy(field)}
                    onOpen={() =>
                      void request("open_website", { id: entry.id }).catch(fail)
                    }
                    onTrash={(value) => void moveTrash(value)}
                    onDelete={() => {
                      setError("");
                      setModal("delete");
                    }}
                  />
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
            {error && !modal && !pinTask && !browserFill && (
              <div className="error-bar" role="alert">
                <span>{error}</span>
                <IconButton label={t("close")} onClick={() => setError("")}>
                  <X size={15} />
                </IconButton>
              </div>
            )}
          </>
        )}
        {toast && (
          <div className="toast" role="status">
            <Check size={16} />
            <span>{toast}</span>
          </div>
        )}
        {modal && phase === "open" && (
          <VaultDialogs
            key={modal}
            modal={modal}
            t={t}
            language={language}
            busy={busy}
            error={error}
            entry={entry}
            run={request}
            onBusy={(value) => {
              if (renderedEpoch === epoch.current) setBusy(value);
            }}
            onError={fail}
            onClose={closeModal}
            onModal={(value) => {
              setError("");
              setModal(value);
            }}
            onMessage={message}
            onImported={() => {
              void securityRefresh().catch(fail);
            }}
            pin={pin}
            onPin={(kind) => {
              setModal(null);
              setError("");
              setPinTask({ kind });
            }}
            onPassword={(value) => updateDraft({ password: value })}
            onDelete={() => void permanentDelete()}
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
        {browserFill && !modal && !pinTask && phase === "open" && (
          <BrowserFillDialog
            key={browserFill.id}
            request={browserFill}
            pin={pin}
            t={t}
            busy={busy}
            error={error}
            onDecide={decideBrowserFill}
          />
        )}
        {pinTask && phase === "open" && (
          <PinDialog
            task={pinTask}
            pin={pin}
            t={t}
            busy={busy}
            error={error}
            run={request}
            onBusy={(value) => {
              if (renderedEpoch === epoch.current) setBusy(value);
            }}
            onError={fail}
            onClose={() => {
              const kind = pinTask.kind;
              setPinTask(null);
              pendingItemAction.current = null;
              setError("");
              if (kind !== "item") setModal("settings");
            }}
            onDone={pinDone}
          />
        )}
      </div>
    </IconContext.Provider>
  );
}
