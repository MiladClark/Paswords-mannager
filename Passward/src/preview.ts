// Development-only, in-memory UI fixture. Not imported into production builds.
import {
  blankEntry,
  redact,
  type Entry,
  type EntryView,
  type Page,
  type Summary,
} from "./api";
let unlocked = false;
let exists = false;
let master = "A fictional test passphrase";
let devicePin: string | null = null;
let failures = 0;
let cooldown = 0;
const grants = new Map<string, number>();
let browserHandled = false;
function pinInfo() {
  return {
    enabled: devicePin !== null,
    available: true,
    blocked: failures >= 10,
    attemptsRemaining: Math.max(0, 10 - failures),
    cooldownSeconds: Math.max(0, Math.ceil((cooldown - Date.now()) / 1000)),
  };
}
function checkPin(value: unknown) {
  if (failures >= 10) throw "pinBlocked";
  if (cooldown > Date.now()) throw "pinCooldown";
  if (value !== devicePin) {
    failures++;
    if (failures >= 5) cooldown = Date.now() + 30_000;
    throw failures >= 10 ? "pinBlocked" : "invalidPin";
  }
  failures = 0;
  cooldown = 0;
}
function guard(id: string) {
  if (devicePin && (grants.get(id) || 0) <= Date.now()) throw "pinRequired";
}
function view(e: Entry): EntryView {
  const value = {
    ...structuredClone(e),
    protected: !!devicePin && (grants.get(e.id) || 0) <= Date.now(),
    hasPassword: !!e.password,
    hasNotes: !!e.notes,
    grantExpiresAt: devicePin ? Math.floor((grants.get(e.id) || 0) / 1000) : 0,
  };
  return value.protected ? redact(value) : value;
}
let entries: Entry[] = [
  {
    ...blankEntry(),
    id: "sample-1",
    title: "Personal email",
    username: "alex@example.test",
    url: "https://mail.example.test",
    password: "Preview-password-only-123!",
    folder: "Personal",
    favorite: true,
    tags: ["email"],
    notes:
      "These are fictional design samples. Your desktop vault starts empty.",
    createdAt: 1793779200,
    updatedAt: 1793779200,
  },
  {
    ...blankEntry(),
    id: "sample-2",
    title: "Design workspace",
    username: "alex@studio.example.test",
    url: "https://studio.example.test",
    password: "Sample-only-not-a-real-secret!",
    folder: "Work",
    tags: ["work"],
    createdAt: 1793692800,
    updatedAt: 1793692800,
  },
  {
    ...blankEntry(),
    id: "sample-3",
    title: "Reading list",
    username: "alex",
    url: "https://books.example.test",
    password: "Another-fictional-password!",
    folder: "Personal",
    createdAt: 1793606400,
    updatedAt: 1793606400,
  },
];
export async function request(
  command: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  await new Promise((r) => setTimeout(r, 35));
  if (command === "vault_status")
    return { exists, unlocked, idleSeconds: 300, pin: pinInfo() };
  if (command === "pending_browser_fill")
    return !browserHandled &&
      new URLSearchParams(location.search).has("browser-request")
      ? {
          id: "fictional-browser-request",
          origin: "https://mail.example.test",
          title: "Personal email",
          username: "alex@example.test",
          expiresAt: Math.floor(Date.now() / 1000) + 90,
        }
      : null;
  if (command === "decide_browser_fill") {
    if (args.allow) {
      if (args.method === "pin") checkPin(args.secret);
      else if (args.secret !== master) throw "invalidPassword";
    }
    browserHandled = true;
    return;
  }
  if (command === "browser_connections")
    return { installed: true, available: true, connections: [] };
  if (command === "begin_browser_pairing")
    return { code: "482916", expiresAt: Math.floor(Date.now() / 1000) + 120 };
  if (command === "install_browser_bridge" || command === "revoke_browser")
    return;
  if (command === "create_vault" || command === "unlock_vault") {
    if (command === "create_vault") master = String(args.password);
    else if (args.password !== master) throw "invalidPassword";
    failures = 0;
    cooldown = 0;
    grants.clear();
    exists = true;
    unlocked = true;
    return;
  }
  if (command === "unlock_with_pin") {
    checkPin(args.pin);
    unlocked = true;
    grants.clear();
    return;
  }
  if (command === "lock_vault") {
    unlocked = false;
    grants.clear();
    return;
  }
  if (!unlocked) throw "locked";
  if (command === "configure_pin") {
    if (args.master !== master) throw "invalidPassword";
    const pin = String(args.pin);
    if (!/^\d{4}$/.test(pin)) throw "pinLength";
    if (
      /^(.)\1{3}$/.test(pin) ||
      [
        "0123",
        "1234",
        "2345",
        "3456",
        "4567",
        "5678",
        "6789",
        "9876",
        "8765",
        "7654",
        "6543",
        "5432",
        "4321",
        "3210",
      ].includes(pin)
    )
      throw "weakPin";
    devicePin = pin;
    failures = 0;
    grants.clear();
    return pinInfo();
  }
  if (command === "remove_pin") {
    if (args.master !== master) throw "invalidPassword";
    devicePin = null;
    grants.clear();
    return;
  }
  if (command === "authorize_entry") {
    if (args.method === "master") {
      if (args.secret !== master) throw "invalidPassword";
      failures = 0;
      cooldown = 0;
    } else checkPin(args.secret);
    const e = entries.find((e) => e.id === args.id);
    if (!e) throw "notFound";
    grants.set(e.id, Date.now() + 60_000);
    return view(e);
  }
  if (command === "lock_entry") {
    const e = entries.find((e) => e.id === args.id);
    if (!e) throw "notFound";
    grants.delete(e.id);
    return view(e);
  }
  if (command === "set_favorite") {
    const e = entries.find((e) => e.id === args.id);
    if (!e) throw "notFound";
    e.favorite = Boolean(args.favorite);
    return view(e);
  }
  if (command === "change_master") {
    if (args.current !== master) throw "invalidPassword";
    master = String(args.password);
    devicePin = null;
    grants.clear();
    return;
  }
  if (command === "copy_field") {
    if (args.field !== "username" && args.field !== "url")
      guard(String(args.id));
    return;
  }
  if (command === "touch_session" || command === "open_website") return;
  if (command === "list_entries") {
    const q = args.query as {
      search: string;
      filter: string;
      folder: string;
      sort: string;
      offset: number;
      limit: number;
    };
    let matches = entries.filter(
      (e) =>
        (q.filter === "trash" ? e.deleted : !e.deleted) &&
        (q.filter !== "favorites" || e.favorite) &&
        (!q.folder || e.folder === q.folder) &&
        `${e.title} ${e.username} ${e.url} ${e.tags.join(" ")}`
          .toLowerCase()
          .includes(q.search.toLowerCase()),
    );
    matches = [...matches].sort(
      q.sort === "title"
        ? (a, b) => a.title.localeCompare(b.title)
        : (a, b) => b.updatedAt - a.updatedAt,
    );
    return {
      items: matches
        .slice(q.offset, q.offset + q.limit)
        .map(
          ({
            password: _p,
            notes: _n,
            fields: _f,
            history: _h,
            createdAt: _c,
            ...summary
          }) => summary as Summary,
        ),
      total: matches.length,
      allCount: entries.filter((e) => !e.deleted).length,
      favoriteCount: entries.filter((e) => e.favorite && !e.deleted).length,
      trashCount: entries.filter((e) => e.deleted).length,
      folders: [
        ...new Set(
          entries
            .filter((e) => !e.deleted)
            .map((e) => e.folder)
            .filter(Boolean),
        ),
      ].sort(),
    } satisfies Page;
  }
  if (command === "get_entry") {
    const entry = entries.find((e) => e.id === args.id);
    if (!entry) throw "notFound";
    return view(entry);
  }
  if (command === "save_entry") {
    const entry = structuredClone(args.entry as Entry);
    const prior = entries.find((e) => e.id === entry.id);
    if (prior) guard(prior.id);
    if (!entry.id) entry.id = crypto.randomUUID();
    entry.createdAt = prior?.createdAt || Math.floor(Date.now() / 1000);
    entry.updatedAt = Math.floor(Date.now() / 1000);
    entry.history = prior?.history || [];
    if (prior && prior.password !== entry.password)
      entry.history = [prior.password, ...entry.history].slice(0, 5);
    entries = entries.filter((e) => e.id !== entry.id);
    entries.unshift(entry);
    return view(entry);
  }
  if (command === "trash_entry") {
    guard(String(args.id));
    const e = entries.find((e) => e.id === args.id);
    if (e) e.deleted = Boolean(args.deleted);
    return;
  }
  if (command === "delete_entry") {
    guard(String(args.id));
    entries = entries.filter((e) => e.id !== args.id);
    return;
  }
  if (command === "generate_password") {
    const alphabet =
      "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789" +
      (args.symbols ? "!@#$%&*+-=?_" : "");
    let output = "";
    while (output.length < Number(args.length)) {
      const n = crypto.getRandomValues(new Uint8Array(1))[0];
      if (n < 256 - (256 % alphabet.length))
        output += alphabet[n % alphabet.length];
    }
    return output;
  }
  if (command === "export_backup" || command === "import_backup")
    throw "desktopOnly";
  throw "genericError";
}
