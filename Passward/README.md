# Passward

A small, offline desktop password vault. English and Persian, with a complete LTR/RTL layout and a compact 900 × 640 default window. Neutral light and dark themes start from the system preference and can be switched in the header. The native title bar is replaced with integrated drag space and minimize, maximize/restore and close controls.

**Early version, not independently audited. Start with test data. There is no promise of being impenetrable.**

## Use the app

The workspace root contains the current version as `Passward.exe` and `Passward-Setup.exe`. The source code is in `Passward/`, and the ready-to-load browser extension is in `Passward-Extension/`. Older releases, duplicate archives and generated build caches have been removed. The existing vault and single-instance identity are preserved. Rust, Node and Build Tools are development requirements; users do not need them to run the finished app. Windows WebView2 is required.

1. Create a vault with a unique master passphrase of at least 12 characters. There is no password reset or recovery backdoor.
2. Add an item with a name, username/email, password, website, folder, tags and notes. Additional fields can be visible or hidden.
3. Use the language button to switch between English and فارسی. Only language and an explicitly chosen theme are saved in localStorage.
4. Use Settings to save an encrypted `.passward` backup, import a `.passward` or legacy `.nook` backup, or change the master password. Import adds separate copies; it never overwrites existing items. Use a new filename when exporting.
5. Keep an encrypted backup off the device. On a new device, create a vault, then import the backup using the master password that applied when that backup was made. Older backups keep their original passwords and contents, including deleted items.

Items can be starred, searched, sorted and grouped by folder. Trash is recoverable until permanent deletion, which requires confirmation. Up to five previous passwords are retained per item. Those versions are encrypted too.

The app locks on minimization and after five minutes of inactivity. Locking discards unsaved edits. Closing with unsaved edits asks before discarding. Copied fields are cleared after about 30 seconds if the clipboard still contains that value; Passward never clears an unrelated replacement. Windows clipboard exclusion hints are used to keep copies out of system history/cloud processing. Third-party clipboard managers may not honor these hints.

## Four-digit device PIN

In Settings → Device PIN, enter the master password and choose exactly four digits. Persian and Arabic digits are accepted and normalized. Repeated digits and simple sequences are rejected. The PIN is optional and tied to the current Windows account through DPAPI; it is not included in backups.

When enabled, the PIN can unlock the app, and each existing item requires its own PIN or master-password authorization before sensitive details, copying, editing or deletion. An item grant lasts 60 seconds. App unlock does not authorize individual items. Lock item revokes its grant immediately. Editing preserves a draft when the grant expires and requires authentication again to save.

After five failed attempts, further attempts are spaced by a 30-second cooldown; ten failures require the master password. A correct master password restores access. Setting, changing and removing the PIN require the master password. Changing or removing an existing PIN rotates the vault data key. Changing the master password disables the old PIN. Keep the master password: the PIN is a local convenience, not an independent authentication factor or hardware-backed protection.

Keyboard shortcuts: `Ctrl N` new item, `Ctrl K` search, `Ctrl S` save edits, `Ctrl Shift L` lock. Every shortcut also has a visible control.

There is no artificial item-count limit. Available storage, memory and hardware set the practical limit. Lists return 50 items per page; names and other search metadata are indexed in Rust memory while unlocked. Unlocking authenticates and indexes every record, and search scans that in-memory index. The core tests exercise a 10,000-item vault; this is not a claim of infinite scale.

The live database is in the per-user Tauri application-data directory, normally `%APPDATA%\com.parag.nook\vault.sqlite3` on Windows. The identifier and encryption format retain their old name for compatibility. Do not edit it by hand or replace an active database. The app enforces a single running instance.

## Chrome and Edge

Version 0.3 includes the Manifest V3 extension in `browser-extension/`. Load that folder with Developer mode → Load unpacked in `chrome://extensions` or `edge://extensions`. It is not published to either extension store yet.

Open Passward 0.3, then Settings → Browsers → Enable browser connection → Pair browser. Enter the one-time six-digit code in the extension. Pair each browser profile separately. If you move the executable or switch to an installed copy, use Repair connection in that copy of the app.

Open a login page, select a matching account and choose Fill. Approve the domain/account in the desktop app with the device PIN or master password. Only that account is released, once, within a 90-second request window. The extension fills visible fields and does not submit the form. Enable Always detect logins on this site to opt into automatic detection and an in-page account suggestion on future visits. Without that permission, opening the extension uses temporary access to the current tab.

Matching uses the exact scheme, host and port stored in the item's Website. Login iframes, hidden fields, sign-up forms, OTP/PIN inputs and forms with a different-origin action are excluded. Custom site widgets can require manual copying. See [extension setup and supported forms](browser-extension/README.md).

## Develop

Prerequisites: Rust stable MSVC, Microsoft C++ Build Tools with Windows SDK, Node.js, pnpm and WebView2. Open a new terminal after installing Rust so Cargo is on PATH.

Run development commands from the `Passward/` source directory. `node_modules`, `dist`, Cargo `target`, generated schemas and test screenshots are reproducible outputs and are not included in the cleaned workspace. `pnpm install` restores frontend dependencies, and Cargo/Tauri commands regenerate their build outputs.

```powershell
pnpm install
pnpm tauri dev
```

The native app is required for the real vault. Opening `http://localhost:1420` in a normal browser does not expose the Rust bridge. An explicit development-only `?preview=1` route uses fictional in-memory UI fixtures. It never opens the real vault; those fixtures and their adapter are removed from the production bundle.

```powershell
pnpm build
pnpm test:core
pnpm check:core
pnpm test:ui
pnpm build:extension
cargo build --manifest-path src-tauri/Cargo.toml --example browser_fixture
pnpm test:extension
pnpm tauri build --bundles nsis
```

UI tests launch an isolated headless Microsoft Edge context with fictional data. They exercise CRUD, generation, trash/restore/delete, keyboard actions, unsaved changes, lock-state cleanup, both languages, light/dark accessibility, narrow layouts, PIN flows and reauthentication after expiry. Core tests cover authenticated encryption, wrong passwords, tampering, persistence, key rotation, rollback, backups, history, pagination, 10,000 records, DPAPI PIN storage, persisted attempt limits and item authorization. DPAPI tests must run under a normal Windows user profile; a restricted sandbox account may not have usable DPAPI credentials.

Extension integration tests launch a fresh Edge or Chrome profile and register a separate temporary `com.passward.fixture` native host. The test-only Rust example uses a temporary fictional vault and a private test pipe; no real vault is opened. The same suite can exercise the release binary's real native-host path by setting `PASSWARD_NATIVE_EXE` to its absolute path. It acquires exclusive ownership of the standard pipe first and fails if a running Passward 0.3 instance already owns it. Test host registry entries and the isolated profile are removed afterward.

The Windows installers are currently **unsigned**. Automatic updates, Windows Hello, save/update prompts from the browser, TOTP, passkeys, cloud sync, sharing and mobile apps are not implemented in this version.

See [SECURITY.md](SECURITY.md) for the security model and its limits, and [ROADMAP.md](ROADMAP.md) for the browser-extension and product development plan.

To test installed Chrome, set PASSWARD_TEST_CHANNEL=chrome. The harness uses Chrome's Extensions.loadUnpacked CDP testing API in a new disposable profile. It does not change your normal browser profile or leave debugging flags enabled. Edge uses its supported test-process extension-loading flags. Chrome for Testing is optional; the downloaded build on this machine had a Windows side-by-side packaging error, so installed Chrome was used for successful validation.
