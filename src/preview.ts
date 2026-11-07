// Development-only, in-memory UI fixture. Not imported into production builds.
import {
  blankEntry,
  type Entry,
  type EntryView,
  type Page,
  type Summary,
} from "./api";
let unlocked = false;
let exists = false;
let master = "A fictional test passphrase";
let failures = 0;
let cooldown = 0;
let browserHandled = false;
let browserSaveHandled = false;
let automaticBackups = false;
let skipDeleteConfirmation = false;
let cloudInfo = { email: "", enabled: false, lastBackup: null as number | null, issue: null as string | null };
let cloudSnapshot = { id: "9b5b1ed5-a171-4d90-b5ec-1608e3bd517b", createdAt: "2026-11-06T10:30:00Z", size: 16384 };
let cloudEntries: Entry[] = [{ ...blankEntry(), id: "sample-cloud-login", title: "Home computer login", username: "alex@example.test", password: "Fictional-cloud-password-123!", url: "https://home.example.test", createdAt: 1793961000, updatedAt: 1793961000 }];
function checkMaster(value: unknown) {
  if (cooldown > Date.now()) throw "authCooldown";
  if (value !== master) {
    failures++;
    if (failures >= 5)
      cooldown =
        Date.now() + Math.min(30_000, 1000 * 2 ** Math.min(failures - 5, 5));
    throw "invalidPassword";
  }
  failures = 0;
  cooldown = 0;
}
function view(e: Entry): EntryView {
  return {
    ...structuredClone(e),
    protected: false,
    hasPassword: !!e.password,
    hasNotes: !!e.notes,
    grantExpiresAt: 0,
  };
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
if (new URLSearchParams(location.search).has("favicon")) {
  entries[0].favicon =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAADkElEQVR42r1XW08TURD+uq206JZWKuUOFQRMVFoVEERNNJroA1DQB4wRrxE1McY3H/0HxsQY5QGJIfHFSFWCt6jxCiKXIhcVTFgKiLShFq2hBcp6dkMBQ7fdAuVLTnP2nNkz30xnz8zIMAc6nUE9CedFQGIEWAOWFBIzOdMkA32NYcyOmVXvJFGXdpwIXGUBNUIIopAol1zqZ3qquGepVzkL9jaZKhB6cDqMKrWm77fDbpZwbvfA2Rtqy315Qgp6rZRW05fJ834sPxRTGHdThEuR2Dei1qxZEpk5fiiixEb7weICxMRoA8rFxcWguKhAJAHWII1QR17xJ7I+Ix1ny0/iQ/1HtHd0BTxyeNiKsLAwnDpZhmGrDSMjdv8+SNCtY4U2S4yFWLFChnv3H8Dj8QT1B8tkMhwqKYLL5YbpYW1wBHgLTpTh7ft6dHR0LirSMjdtQF5uDiqrqjExMTFvn/IZnnI5FAp5QOXK2HhEkOEPn9s7QdM0f6YvUMLxwQa0bqU6EuFkBAw1P2dRwbo03pANBR0x32tKFb8XLGTBvuCwMEjK2wWndQie8XFIJBLE67OwKioaA80NoSfw125D9/NaaFLTsf6Akc9mX+pqMNjWtKAglS3kJaU2FpqUdPzq7eFvdW7udv4hXvkZegJx+i2Q0ypY6t9AlZjMr40OWBCr3wpldCyG2ltDS2D0xwD+2lr4uWp6zfVnFL3vXoImcRD6GLBZBfectuHliQEv7NMxsBgIEpAL3FxzMeFyiUv8CuFCy2c2nCSJRxWhBEuss9uFs9munflITk5Cn6VfUCYjPQ1u9zi+fuv2eSP6vAm5zFdb9xRZWwzQZ270XR+UFEIqpfhRUlzoU2azQU/GJjx+8kwwm/qtBzo6u5Cbkw2NJhL9A4Mz6+fKT6GltQ2Nn5rBMBZCQkpIFKCpefYT3LE9F9HRWtyvebTwesCLfXv3YGpqiig148L5ctysqITVZvtPRqvV4szpY7h+owI52VnwTE7ixavXgYsyMQQ45OdtQ2pqCu5U3xXObBSFo0dK0d3zHfUNjeKqwgRdGtex6MUIh4eHY2xsbNEyc9S3cUWpSew3K+Zg8cr5SsHkbUwYdvZmXa7GZJQ0Jjqpw/HTRdokLo0Zl5cAddjCdJr53pDr0bhejbDaHer+kLOcU97PdJtmmlMviUh10k2uXSJiq8lSzBKrbiM/t0h7XspZ7l3+Bx92MyxGdFxsAAAAAElFTkSuQmCC";
  entries[1].favicon = "https://invalid.example.test/untrusted-icon.png";
  entries[2].favicon = "data:image/png;base64,broken";
}
export async function request(
  command: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  await new Promise((r) => setTimeout(r, 35));
  if (command === "vault_status")
    return { exists, unlocked, idleSeconds: 300, legacyPinRetired: false };
  if (command === "cloud_info") return { ...cloudInfo };
  if (command === "cloud_connect") {
    cloudInfo = { ...cloudInfo, email: "alex@example.test", issue: null };
    return { ...cloudInfo };
  }
  if (command === "cloud_list") {
    if (!cloudInfo.email) throw "cloudSignInRequired";
    return [{ ...cloudSnapshot }];
  }
  if (command === "prepare_browser_extension")
    return { directory: "", browserInstalled: true, preview: true };
  if (
    command === "open_extension_folder" ||
    command === "copy_extension_setup_value"
  )
    throw "desktopOnly";
  if (command === "pending_browser_save") {
    const kind = new URLSearchParams(location.search).get("browser-save");
    return !browserSaveHandled && (kind === "new" || kind === "update")
      ? {
          id: "fictional-browser-save",
          origin: "https://mail.example.test",
          title: "mail.example.test",
          username: "alex@example.test",
          kind: kind === "new" ? "save" : "update",
          accounts:
            kind === "update"
              ? [
                  {
                    id: "sample-1",
                    title: "Personal email",
                    username: "alex@example.test",
                  },
                ]
              : [],
          expiresAt: Math.floor(Date.now() / 1000) + 120,
        }
      : null;
  }
  if (command === "decide_browser_save") {
    args = args.decision as Record<string, unknown>;
    if (!args.allow) {
      browserSaveHandled = true;
      return null;
    }
    const updating =
      new URLSearchParams(location.search).get("browser-save") === "update";
    if (updating) checkMaster(args.secret);
    const entry = updating
      ? entries.find((e) => e.id === args.target)!
      : {
          ...blankEntry(),
          id: "sample-browser-save",
          title: String(args.title),
          username: String(args.username),
          url: "https://mail.example.test",
          createdAt: Math.floor(Date.now() / 1000),
        };
    if (updating)
      entry.history = [entry.password, ...entry.history].slice(0, 5);
    entry.password = "Fictional-captured-password-901!";
    entry.updatedAt = Math.floor(Date.now() / 1000);
    if (!updating) entries.unshift(entry);
    browserSaveHandled = true;
    return entry.id;
  }
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
      checkMaster(args.secret);
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
    else checkMaster(args.password);
    failures = 0;
    cooldown = 0;
    exists = true;
    unlocked = true;
    return;
  }
  if (command === "lock_vault") {
    unlocked = false;
    return;
  }
  if (command === "reset_local") {
    if (!unlocked) throw "locked";
    checkMaster(args.master);
    entries = [];
    master = "";
    exists = false;
    unlocked = false;
    automaticBackups = false;
    skipDeleteConfirmation = false;
    browserHandled = true;
    browserSaveHandled = true;
    cloudInfo = { email: "", enabled: false, lastBackup: null, issue: null };
    return;
  }
  if (!unlocked) throw "locked";
  if (command === "cloud_sync") {
    if (!cloudInfo.email) throw "cloudSignInRequired";
    if (args.id !== cloudSnapshot.id) throw "cloudChanged";
    const additions = cloudEntries.filter((item) => !entries.some((local) => local.id === item.id));
    entries.push(...structuredClone(additions));
    cloudEntries = structuredClone(entries);
    cloudInfo = { ...cloudInfo, lastBackup: Math.floor(Date.now() / 1000), issue: null };
    cloudSnapshot = { ...cloudSnapshot, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
    return { imported: additions.length, info: { ...cloudInfo } };
  }
  if (command === "automatic_backup_info")
    return { enabled: automaticBackups, lastCreated: 0, retained: 0 };
  if (command === "configure_automatic_backups") {
    automaticBackups = Boolean(args.enabled);
    return { enabled: automaticBackups, lastCreated: 0, retained: 0 };
  }
  if (command === "set_favorite") {
    const e = entries.find((e) => e.id === args.id);
    if (!e) throw "notFound";
    e.favorite = Boolean(args.favorite);
    return view(e);
  }
  if (command === "change_master") {
    checkMaster(args.current);
    master = String(args.password);
    return;
  }
  if (command === "copy_field") {
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
      allCount: entries.length,
      favoriteCount: entries.filter((e) => e.favorite).length,
      folders: [
        ...new Set(entries.map((e) => e.folder).filter(Boolean)),
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
  if (command === "delete_entry") {
    if (!entries.some((e) => e.id === args.id)) throw "notFound";
    if (args.master !== null) checkMaster(args.master);
    else if (!skipDeleteConfirmation) throw "deletePasswordRequired";
    entries = entries.filter((e) => e.id !== args.id);
    if (args.master !== null) skipDeleteConfirmation = args.skipConfirmation === true;
    return skipDeleteConfirmation;
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
