# Security model — Passward 0.3

This is an early implementation, not an independently audited password manager. Use test credentials until the design and implementation have received independent security review. The security boundary assumes the OS, application binary and bundled frontend are trusted while the vault is unlocked.

## Cryptography and storage

- RustCrypto Argon2id v1.3 derives a 32-byte key from the master passphrase, using a fresh 16-byte OS-random salt, 64 MiB of memory, three passes and one lane. Format 1 accepts only these fixed parameters, avoiding attacker-controlled excessive KDF costs.
- A separate OS-random 256-bit data key is wrapped using XChaCha20-Poly1305. The master passphrase and derived wrapping key are not persisted.
- Each record is encrypted and authenticated with XChaCha20-Poly1305 and a fresh 24-byte OS-random nonce. Associated data binds the format, vault identifier and record identifier. Record swaps between identifiers or vaults fail authentication.
- Record payloads include name, username, password, website, notes, folder, tags, favorite/trash state, timestamps, custom fields and password history. SQLite contains only opaque identifiers, encrypted record blobs and a public key-wrapping header. File size, row count and ciphertext lengths remain observable. The header contains the salt, version, KDF parameters, vault identifier and wrapped key.
- SQLite runs with full synchronous commits and a rollback journal. Plaintext record values never enter SQL queries, logs, SQLite indexes or journal pages. Save operations commit before updating the in-memory index.
- Changing the master password verifies the current passphrase, generates a new data key and salt, re-encrypts every record and updates the header in a single transaction. A failure rolls back all records and the header; the in-memory key is changed only after commit. Copies of old backups remain decryptable with their old password; they cannot decrypt newly rotated vault ciphertext.
- Backup uses SQLite's consistent backup API and never writes a decrypted export. A backup import is authenticated in full first, then merged under fresh record IDs and the destination key in one transaction. Invalid or corrupt backups leave the destination unchanged.
- Keys, decrypted Rust JSON buffers and Rust record structures use `zeroize` on drop. List responses omit passwords, notes, custom values and password history; the selected record is decrypted on demand.

## Optional device PIN

The four-digit PIN is a local unlock mechanism, not MFA. An Argon2id-derived key wraps the vault data key with authenticated encryption. Windows DPAPI then protects the entire device-PIN configuration for the current Windows user, including its salt, ciphertext and attempt counters. The PIN itself is not persisted. The configuration is separate from the encrypted backup and is bound to the current vault header by SHA-256. DPAPI uses `CRYPTPROTECT_UI_FORBIDDEN`, without machine-wide protection. See [Microsoft's DPAPI documentation](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata).

Failures are committed before checking the candidate. After five failures there is a 30-second cooldown between attempts; after ten, correct master-password authentication is required. Limits survive application restart, but are software state: clock manipulation or replaying older files is outside this protection. This is not a hardware-backed rate limiter. Corrupt or stale PIN configuration fails closed for PIN unlock; master-password authentication remains available.

PIN setup, change and removal require the master password. Changing or removing an existing PIN rotates the data key and re-encrypts the vault, so replaying the old PIN file alone cannot reopen the current vault. A master-password change also invalidates the device PIN. Old vault snapshots retain their old keys and credentials.

When a PIN is configured, the backend independently requires a 60-second, item-scoped authorization before returning passwords, notes, custom-field values or history. Sensitive copying, editing and deletion enforce the same grant. App unlock creates no item grants. Locked item responses contain metadata and presence flags only. Favoriting uses a separate metadata command so a redacted frontend payload cannot erase stored secrets. Item grants are cleared on app lock; an open edit draft can remain in frontend memory after grant expiry, and saving it requires reauthentication.

## Application boundaries

The bundled webview has no generic filesystem, clipboard or opener plugin permissions. Narrow Rust commands validate records, website schemes, sizes and session state. Only `http` and `https` websites can be opened; embedded URL credentials are rejected. File pickers run in Rust, so frontend callers cannot provide arbitrary backup paths. A backup export refuses to overwrite an existing file.

The production CSP blocks remote scripts, fonts, frames and connections. There are no remote icons, analytics, cloud APIs or embedded remote pages. Websites open only in the user's external browser after a user action. A single-instance plugin prevents competing Passward instances. Window permissions permit dragging, minimize, maximize/restore and close for the integrated title bar. Browser integration adds narrow native commands; it does not give the webview a general IPC, registry or filesystem API.

## Browser extension boundary

The Manifest V3 extension connects through Native Messaging. The same Passward executable runs a stdio-only native-host mode when invoked by the allowlisted extension origin, and forwards bounded messages to the running app. That mode never opens the database. A per-user named pipe rejects remote clients and uses an explicit DACL granting access only to the current user's SID. The first listener requires exclusive pipe ownership. Read/write timeouts, message-size limits, bounded concurrency and pipe-busy retries constrain resource use. The app exposes no localhost HTTP server.

Native host registration is scoped to HKCU for Chrome and Edge, with one fixed extension ID. This origin check is not protection from a local process running as the same user. The OS/user account and the installed extension package remain trusted. Publishing to an extension store may produce a different ID; that requires updating and reviewing the allowlist, not allowing arbitrary extension IDs.

Pairing is explicitly initiated in an unlocked desktop app using a six-digit, single-use code valid for two minutes and limited to ten attempts. A random 256-bit token is issued per connection. The desktop persists its SHA-256 digest inside a DPAPI-protected file. The extension stores its token only in `chrome.storage.local`, with access restricted to trusted extension contexts. It is not synced. Browser storage is not claimed to be a secure hardware keystore. Pairing tokens authorize origin-scoped metadata and fill requests; they do not authorize secret release without a new desktop approval. Each request carries a UUID; recent duplicates are rejected. Revoke in the desktop invalidates that token immediately and cancels its pending request.

Matching requires equal parsed scheme, hostname and port, excludes URL credentials, and omits trash. Metadata responses contain only ID, title and username, with at most 100 matches per request. A fill request binds one account, one origin, one paired client and a 90-second lifetime. The desktop shows the origin and account, then verifies the PIN or master password. Denial, lock, expiry or disconnection prevents release. The approved result is consumed exactly once; the backend rechecks item access, deletion and the stored URL before returning only username and password.

The background worker derives the origin from browser tab/sender APIs. It restricts content messages to frame 0, checks the active tab/document before requesting and before releasing, and targets the same browser document ID for insertion. Navigation invalidates a pending fill. The content script runs in the isolated extension world, rechecks `location.origin`, visibility, login-field heuristics and form destination, then dispatches native input/change events. It never submits a form or collects existing field values. Credentials are not returned to popup/content-message callers, stored in extension storage or passed through DOM message events; the intended website can necessarily read credentials once they are filled.

No site permission is granted by default. The popup uses `activeTab` for an explicit user invocation. Optional per-site host permissions enable future automatic detection; only the top frame is injected. Signup, hidden fields, OTP/PIN and cross-origin login frames are excluded. The small in-page picker is page-visible UI, not a trustworthy OS surface; the desktop confirmation is the final approval surface.

Official API references: [Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging), [Edge registration](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/native-messaging), [scripting targets](https://developer.chrome.com/docs/extensions/reference/api/scripting) and [extension storage](https://developer.chrome.com/docs/extensions/reference/api/storage).

The backend independently enforces a five-minute idle timeout and locks on minimization. The UI also clears its selected record, drafts, search index results, generated passwords and dialogs when it receives a lock event. Async responses from an earlier session cannot repopulate a locked UI. Native file pickers do not hold the vault mutex, so they cannot suspend timeout enforcement.

Copy operations are authorized again immediately before writing to the clipboard and serialized with vault locking. Windows receives an `ExcludeClipboardContentFromMonitorProcessing` hint. One backend worker expires the current clipboard lease after approximately 30 seconds, preserving values subsequently copied by another application and retrying when the clipboard is temporarily busy. Lock and exit also attempt to clear Passward-owned content.

## Important limits

- Malware, administrators, debuggers, keyloggers, screen capture and a compromised webview or OS can access secrets while they are in use. This app cannot make a compromised computer trustworthy.
- JavaScript strings, IPC serialization, UI controls, OS clipboard memory, paging, hibernation and crash dumps cannot be guaranteed to be zeroized. Rust zeroization is best effort, not a claim that plaintext never exists in RAM.
- Third-party clipboard managers and remote-access software can ignore exclusion hints or capture values before cleanup. Abrupt process termination can prevent cleanup.
- Per-record AEAD detects changed ciphertext and record swaps. It does not prove database completeness or stop deletion, replay of older records, or rollback of the entire vault/backup. There is no trusted external monotonic state.
- Permanent deletion affects the current database only. Backups, filesystem snapshots, SSD wear leveling and external copies can retain previous ciphertext. Secure physical erasure is not promised.
- DPAPI assumes the current Windows user and OS are trusted. Same-user malware can invoke DPAPI and attack the low-entropy PIN offline. An attacker who restores an older PIN-state file can roll back software attempt counters. A four-digit PIN does not provide the offline resistance of a strong master passphrase.
- There is no reset/recovery service. A working device PIN may still open the local vault if the master password is forgotten, but it cannot authorize PIN changes, master-password changes or authenticated imports, and does not travel with backups. Passward cannot recover a forgotten master password.
- Unlock and search are O(n) in record count, with decrypted search metadata held in Rust memory while open. There is no artificial record-count quota, and no infinite-capacity guarantee.
- The installer is unsigned and the extension is currently loaded unpacked. Signed releases, extension-store publication, dependency audit automation, platform memory protections, hardware-backed unlock and independent penetration/cryptographic review remain future work.

## Validation scope

Core tests use temporary directories and fictional secrets; they include a 10,000-record fixture, database persistence, ciphertext authentication, key rotation, transaction rollback under corruption, DPAPI persistence and item-authorization bypass attempts. Browser tests use only the development preview and fresh isolated browser contexts. Browser checks do not establish that the native OS clipboard, native file dialogs or integrated window controls work under every desktop configuration. The release is compiled separately; this version's native window controls still need an interactive check in the user's session. No real user vault is initialized or populated by automated tests.
