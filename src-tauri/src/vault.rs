use crate::memory::LockedKey;
use base64::Engine;
use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::{
    XChaCha20Poly1305, XNonce,
    aead::{Aead, KeyInit, Payload},
};
use rand::{Rng, RngCore, rngs::OsRng, seq::SliceRandom};
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

pub type Result<T> = std::result::Result<T, String>;
const FORMAT: u32 = 1;
const MEMORY_KIB: u32 = 65_536;
const ITERATIONS: u32 = 3;
const IDLE_SECONDS: u64 = 300;
const CLOUD_AAD: &[u8] = b"passwards:cloud-snapshot:v1:sha256";
const CLOUD_MAGIC: &[u8; 8] = b"PWCLD001";
const CLOUD_TRAILER: u64 = 80;
const RESET_CONFIRMATION: &str = "موافقم";

fn snapshot_digest(file: &mut File) -> Result<[u8; 32]> {
    file.rewind().map_err(|_| "storageError")?;
    let mut hash = Sha256::new();
    std::io::copy(file, &mut hash).map_err(|_| "storageError")?;
    Ok(hash.finalize().into())
}

fn db_error(_: rusqlite::Error) -> String {
    "storageError".into()
}
pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[derive(Serialize, Deserialize)]
struct Header {
    version: u32,
    vault_id: String,
    salt: Vec<u8>,
    wrapped_key: Vec<u8>,
    memory: u32,
    iterations: u32,
}

#[derive(Clone, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
#[serde(rename_all = "camelCase")]
pub struct ExtraField {
    pub label: String,
    pub value: String,
    pub hidden: bool,
}

#[derive(Clone, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    pub title: String,
    pub username: String,
    pub password: String,
    pub url: String,
    #[serde(default)]
    pub favicon: String,
    pub notes: String,
    pub folder: String,
    pub tags: Vec<String>,
    pub favorite: bool,
    pub created_at: u64,
    pub updated_at: u64,
    #[serde(default)]
    pub fields: Vec<ExtraField>,
    #[serde(default)]
    pub history: Vec<String>,
}

#[derive(Clone, Serialize, Zeroize, ZeroizeOnDrop)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub id: String,
    pub title: String,
    pub username: String,
    pub url: String,
    pub favicon: String,
    pub folder: String,
    pub tags: Vec<String>,
    pub favorite: bool,
    pub updated_at: u64,
}
impl From<&Entry> for Summary {
    fn from(e: &Entry) -> Self {
        Self {
            id: e.id.clone(),
            title: e.title.clone(),
            username: e.username.clone(),
            url: e.url.clone(),
            favicon: e.favicon.clone(),
            folder: e.folder.clone(),
            tags: e.tags.clone(),
            favorite: e.favorite,
            updated_at: e.updated_at,
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub exists: bool,
    pub unlocked: bool,
    pub idle_seconds: u64,
    pub legacy_pin_retired: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryView {
    #[serde(flatten)]
    pub entry: Entry,
    pub protected: bool,
    pub has_password: bool,
    pub has_notes: bool,
    pub grant_expires_at: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListQuery {
    pub search: String,
    pub filter: String,
    pub folder: String,
    pub sort: String,
    pub offset: usize,
    pub limit: usize,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub items: Vec<Summary>,
    pub total: usize,
    pub all_count: usize,
    pub favorite_count: usize,
    pub folders: Vec<String>,
}

struct Session {
    key: LockedKey,
    vault_id: String,
    index: BTreeMap<String, Summary>,
    touched: u64,
}
pub struct Vault {
    conn: Connection,
    pub path: PathBuf,
    session: Option<Session>,
    legacy_pin_retired: bool,
    auth_failures: u8,
    auth_retry_at: Option<std::time::Instant>,
    backups: crate::backups::Backups,
    writable: bool,
}

pub(crate) fn derive(password: &str, salt: &[u8]) -> Result<Zeroizing<[u8; 32]>> {
    let params = Params::new(MEMORY_KIB, ITERATIONS, 1, Some(32)).map_err(|_| "cryptoError")?;
    let mut key = Zeroizing::new([0; 32]);
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(password.as_bytes(), salt, key.as_mut())
        .map_err(|_| "cryptoError")?;
    Ok(key)
}
pub(crate) fn seal(key: &[u8; 32], plaintext: &[u8], aad: &[u8]) -> Result<Vec<u8>> {
    let cipher = XChaCha20Poly1305::new(key.into());
    let mut nonce = [0u8; 24];
    OsRng
        .try_fill_bytes(&mut nonce)
        .map_err(|_| "randomError")?;
    let encrypted = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| "cryptoError")?;
    let mut output = nonce.to_vec();
    output.extend_from_slice(&encrypted);
    Ok(output)
}
pub(crate) fn unseal(key: &[u8; 32], data: &[u8], aad: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    if data.len() < 40 {
        return Err("damagedVault".into());
    }
    XChaCha20Poly1305::new(key.into())
        .decrypt(
            XNonce::from_slice(&data[..24]),
            Payload {
                msg: &data[24..],
                aad,
            },
        )
        .map(Zeroizing::new)
        .map_err(|_| "damagedVault".into())
}
fn entry_aad(vault_id: &str, id: &str) -> String {
    format!("nook:v1:entry:{vault_id}:{id}")
}
fn key_aad(id: &str) -> String {
    format!("nook:v1:wrapped-key:{id}")
}
fn valid_password(password: &str) -> Result<()> {
    if password.chars().count() < 12 || password.len() > 1024 {
        Err("masterLength".into())
    } else {
        let lower = Zeroizing::new(password.to_lowercase());
        let common = ["password1234", "password12345", "password123456", "password123456!", "123456789012", "qwerty123456", "qwerty123456!", "letmeinletmein", "passwordpassword"];
        if common.contains(&lower.as_str()) || password.chars().all(|c| password.starts_with(c)) {
            return Err("weakMaster".into());
        }
        Ok(())
    }
}
pub(crate) fn valid_favicon(value: &str) -> bool {
    if value.is_empty() { return true; }
    if value.len() > 12_288 { return false; }
    let Some(encoded) = value.strip_prefix("data:image/png;base64,") else { return false; };
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(encoded) else { return false; };
    bytes.len() >= 45
        && bytes.starts_with(b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR")
        && bytes[16..24] == [0, 0, 0, 32, 0, 0, 0, 32]
        && bytes.ends_with(b"\0\0\0\0IEND\xaeB`\x82")
}
fn validate(e: &Entry) -> Result<()> {
    if !valid_favicon(&e.favicon)
        || e.title.trim().is_empty()
        || e.title.len() > 512
        || e.username.len() > 2048
        || e.password.len() > 4096
        || e.url.len() > 4096
        || e.notes.len() > 131_072
        || e.history.len() > 5
        || e.history.iter().any(|p| p.len() > 4096)
        || e.created_at > 253_402_300_799
        || e.updated_at > 253_402_300_799
        || e.folder.len() > 128
        || e.tags.len() > 24
        || e.tags.iter().any(|t| t.len() > 64)
        || e.fields.len() > 24
        || e.fields
            .iter()
            .any(|f| f.label.len() > 128 || f.value.len() > 8192)
    {
        return Err("invalidEntry".into());
    }
    if !e.url.is_empty() {
        let u = url::Url::parse(&e.url).map_err(|_| "invalidUrl")?;
        if !matches!(u.scheme(), "http" | "https")
            || u.host_str().is_none()
            || !u.username().is_empty()
            || u.password().is_some()
        {
            return Err("invalidUrl".into());
        }
    }
    Ok(())
}
impl Vault {
    pub fn open(path: PathBuf) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|_| "storageError")?;
        }
        let conn = Connection::open(&path).map_err(db_error)?;
        conn.busy_timeout(Duration::from_secs(5))
            .map_err(db_error)?;
        conn.execute_batch("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY CHECK (id=1), header TEXT NOT NULL); CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, sealed BLOB NOT NULL);").map_err(db_error)?;
        Ok(Self {
            conn,
            backups: crate::backups::Backups::open(&path),
            writable: true,
            path,
            session: None,
            legacy_pin_retired: false,
            auth_failures: 0,
            auth_retry_at: None,
        })
    }
    fn readonly(path: &Path) -> Result<Self> {
        let conn = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|_| "damagedVault")?;
        Ok(Self {
            conn,
            backups: crate::backups::Backups::open(path),
            writable: false,
            path: path.to_path_buf(),
            session: None,
            legacy_pin_retired: false,
            auth_failures: 0,
            auth_retry_at: None,
        })
    }
    fn header(&self) -> Result<Option<Header>> {
        let raw: Option<String> = self
            .conn
            .query_row("SELECT header FROM meta WHERE id=1", [], |r| r.get(0))
            .optional()
            .map_err(db_error)?;
        raw.map(|s| serde_json::from_str(&s).map_err(|_| "damagedVault".into()))
            .transpose()
    }
    pub fn status(&mut self) -> Result<Status> {
        self.expire();
        Ok(Status {
            exists: self.header()?.is_some(),
            unlocked: self.session.is_some(),
            idle_seconds: IDLE_SECONDS,
            legacy_pin_retired: self.legacy_pin_retired,
        })
    }
    pub fn lock(&mut self) -> bool {
        self.session.take().is_some()
    }
    pub fn expire(&mut self) -> bool {
        let expired = self
            .session
            .as_ref()
            .is_some_and(|s| now().saturating_sub(s.touched) >= IDLE_SECONDS || now() < s.touched);
        if expired {
            self.lock();
        }
        expired
    }
    pub fn touch(&mut self) -> Result<()> {
        self.expire();
        let s = self.session.as_mut().ok_or("locked")?;
        s.touched = now();
        Ok(())
    }
    pub fn create(&mut self, password: &str) -> Result<()> {
        valid_password(password)?;
        if self.header()?.is_some() {
            return Err("vaultExists".into());
        }
        let mut salt = vec![0; 16];
        OsRng.try_fill_bytes(&mut salt).map_err(|_| "randomError")?;
        let wrapping = derive(password, &salt)?;
        let mut key = Zeroizing::new([0u8; 32]);
        OsRng
            .try_fill_bytes(key.as_mut())
            .map_err(|_| "randomError")?;
        let key = LockedKey::new(key)?;
        let vault_id = Uuid::new_v4().to_string();
        let header = Header {
            version: FORMAT,
            salt,
            wrapped_key: seal(&wrapping, key.as_ref(), key_aad(&vault_id).as_bytes())?,
            vault_id: vault_id.clone(),
            memory: MEMORY_KIB,
            iterations: ITERATIONS,
        };
        let tx = self.conn.transaction().map_err(db_error)?;
        tx.execute(
            "INSERT INTO meta(id,header) VALUES(1,?1)",
            [serde_json::to_string(&header).map_err(|_| "cryptoError")?],
        )
        .map_err(db_error)?;
        tx.commit().map_err(db_error)?;
        self.session = Some(Session {
            key,
            vault_id,
            index: BTreeMap::new(),
            touched: now(),
        });
        Ok(())
    }
    pub fn unlock(&mut self, password: &str) -> Result<()> {
        self.lock();
        let (header, key) = self.master_key(password)?;
        // Check filesystem access while the vault is still locked. A failed
        // migration lookup must not leave an authenticated session behind.
        let retire_legacy = self.writable && !self.legacy_pin_files()?.is_empty();
        self.load_session(header, key)?;
        // Retire every old device-PIN file only after a verified master unlock.
        // Rotate first: copying the old file back must never reveal the current key.
        if retire_legacy {
            if let Err(cause) = self.change_password(password, password) {
                self.lock();
                return Err(cause);
            }
            self.legacy_pin_retired = true;
        }
        Ok(())
    }
    fn master_key(&mut self, password: &str) -> Result<(Header, Zeroizing<[u8; 32]>)> {
        if self.auth_retry_at.is_some_and(|until| std::time::Instant::now() < until) {
            return Err("authCooldown".into());
        }
        if password.len() > 1024 {
            return Err("invalidPassword".into());
        }
        let header = self.header()?.ok_or("noVault")?;
        if header.version != FORMAT
            || header.salt.len() != 16
            || header.wrapped_key.len() != 72
            || header.memory != MEMORY_KIB
            || header.iterations != ITERATIONS
            || Uuid::parse_str(&header.vault_id).is_err()
        {
            return Err("damagedVault".into());
        }
        let wrapping = derive(password, &header.salt)?;
        let raw = unseal(
            &wrapping,
            &header.wrapped_key,
            key_aad(&header.vault_id).as_bytes(),
        )
        .map_err(|_| {
            self.auth_failures = self.auth_failures.saturating_add(1);
            if self.auth_failures >= 5 {
                let delay = (1u64 << (self.auth_failures - 5).min(5)).min(30);
                self.auth_retry_at = Some(std::time::Instant::now() + Duration::from_secs(delay));
            }
            "invalidPassword".to_string()
        })?;
        self.auth_failures = 0;
        self.auth_retry_at = None;
        if raw.len() != 32 {
            return Err("damagedVault".into());
        }
        let mut key = Zeroizing::new([0; 32]);
        key.copy_from_slice(&raw);
        Ok((header, key))
    }
    fn legacy_pin_files(&self) -> Result<Vec<PathBuf>> {
        let mut files = Vec::new();
        let legacy = self.path.with_extension("device-pin");
        if legacy.try_exists().map_err(|_| "storageError")? { files.push(legacy); }
        if let Some(parent) = self.path.parent() {
            for entry in std::fs::read_dir(parent).map_err(|_| "storageError")? {
                let entry = entry.map_err(|_| "storageError")?;
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if entry.file_type().map_err(|_| "storageError")?.is_file()
                    && name.strip_prefix(".pin-").and_then(|s| s.strip_suffix(".tmp")).is_some_and(|s| Uuid::parse_str(s).is_ok()) {
                    files.push(entry.path());
                }
            }
        }
        Ok(files)
    }
    fn load_session(&mut self, header: Header, key: Zeroizing<[u8; 32]>) -> Result<()> {
        let key = LockedKey::new(key)?;
        let mut index = BTreeMap::new();
        let mut stmt = self
            .conn
            .prepare("SELECT id,sealed FROM entries")
            .map_err(db_error)?;
        let rows = stmt
            .query_map([], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?))
            })
            .map_err(db_error)?;
        for row in rows {
            let (id, sealed) = row.map_err(db_error)?;
            let plain = unseal(&key, &sealed, entry_aad(&header.vault_id, &id).as_bytes())?;
            let entry: Entry = serde_json::from_slice(&plain).map_err(|_| "damagedVault")?;
            if entry.id != id {
                return Err("damagedVault".into());
            }
            validate(&entry).map_err(|_| "damagedVault")?;
            index.insert(id, Summary::from(&entry));
        }
        self.session = Some(Session {
            key,
            vault_id: header.vault_id,
            index,
            touched: now(),
        });
        Ok(())
    }
    pub fn require_item_access(&mut self, id: &str) -> Result<()> {
        self.touch()?;
        if !self.session.as_ref().ok_or("locked")?.index.contains_key(id) { return Err("notFound".into()); }
        Ok(())
    }
    pub fn authorize_entry(&mut self, id: &str, secret: &str) -> Result<EntryView> {
        self.touch()?;
        if !self
            .session
            .as_ref()
            .ok_or("locked")?
            .index
            .contains_key(id)
        {
            return Err("notFound".into());
        }
        self.master_key(secret)?;
        self.view_entry(id)
    }
    pub fn view_entry(&mut self, id: &str) -> Result<EntryView> {
        let entry = self.get(id)?;
        let has_password = !entry.password.is_empty();
        let has_notes = !entry.notes.is_empty();
        Ok(EntryView {
            entry,
            protected: false,
            has_password,
            has_notes,
            grant_expires_at: 0,
        })
    }
    pub fn sensitive_entry(&mut self, id: &str) -> Result<Entry> {
        self.require_item_access(id)?;
        self.get(id)
    }
    pub fn save_from_ui(&mut self, entry: Entry) -> Result<EntryView> {
        if !entry.id.is_empty() {
            self.require_item_access(&entry.id)?;
        }
        let saved = self.save(entry)?;
        self.view_entry(&saved.id)
    }
    pub fn set_favorite(&mut self, id: &str, favorite: bool) -> Result<EntryView> {
        let mut e = self.get(id)?;
        e.favorite = favorite;
        self.save(e)?;
        self.view_entry(id)
    }

    pub fn authorize_browser_save(&mut self, master: &str) -> Result<()> { self.touch()?; self.master_key(master)?; Ok(()) }
    pub fn browser_password_digest(&mut self, id: &str) -> Result<Vec<u8>> {
        use sha2::{Digest, Sha256};
        self.expire();
        Ok(Sha256::digest(self.read_entry(id)?.password.as_bytes()).to_vec())
    }
    pub fn browser_password_matches(&mut self, id: &str, password: &str) -> Result<bool> {
        use sha2::{Digest, Sha256};
        use subtle::ConstantTimeEq;
        Ok(bool::from(self.browser_password_digest(id)?.ct_eq(Sha256::digest(password.as_bytes()).as_slice())))
    }
    pub fn browser_matches(&mut self, origin: &str) -> Result<Vec<crate::browser::Account>> {
        self.expire();
        let session = self.session.as_ref().ok_or("locked")?;
        Ok(session
            .index
            .values()
            .filter(|e| {
                crate::browser::canonical_origin(&e.url).is_ok_and(|o| o == origin)
            })
            .take(100)
            .map(|e| crate::browser::Account {
                id: e.id.clone(),
                title: e.title.clone(),
                username: e.username.clone(),
            })
            .collect())
    }
    pub fn list(&mut self, q: ListQuery) -> Result<Page> {
        self.touch()?;
        let s = self.session.as_ref().ok_or("locked")?;
        let search = q.search.to_lowercase();
        let all_count = s.index.len();
        let favorite_count = s
            .index
            .values()
            .filter(|e| e.favorite)
            .count();
        let mut folders: Vec<String> = s
            .index
            .values()
            .filter(|e| !e.folder.is_empty())
            .map(|e| e.folder.clone())
            .collect();
        folders.sort();
        folders.dedup();
        let mut entries: Vec<&Summary> = s
            .index
            .values()
            .filter(|e| {
                (q.filter != "favorites" || e.favorite)
                    && (q.folder.is_empty() || e.folder == q.folder)
                    && (search.is_empty()
                        || format!(
                            "{} {} {} {} {}",
                            e.title,
                            e.username,
                            e.url,
                            e.folder,
                            e.tags.join(" ")
                        )
                        .to_lowercase()
                        .contains(&search))
            })
            .collect();
        if q.sort == "title" {
            entries.sort_by_cached_key(|e| e.title.to_lowercase());
        } else {
            entries.sort_by(|a, b| {
                b.updated_at
                    .cmp(&a.updated_at)
                    .then_with(|| a.title.cmp(&b.title))
            });
        }
        let total = entries.len();
        let items = entries
            .into_iter()
            .skip(q.offset)
            .take(q.limit.clamp(1, 100))
            .cloned()
            .collect();
        Ok(Page {
            items,
            total,
            all_count,
            favorite_count,
            folders,
        })
    }
    pub fn get(&mut self, id: &str) -> Result<Entry> {
        self.touch()?;
        self.read_entry(id)
    }
    fn read_entry(&self, id: &str) -> Result<Entry> {
        let s = self.session.as_ref().ok_or("locked")?;
        let sealed: Vec<u8> = self
            .conn
            .query_row("SELECT sealed FROM entries WHERE id=?1", [id], |r| r.get(0))
            .optional()
            .map_err(db_error)?
            .ok_or("notFound")?;
        let plain = unseal(&s.key, &sealed, entry_aad(&s.vault_id, id).as_bytes())?;
        let entry: Entry = serde_json::from_slice(&plain).map_err(|_| "damagedVault")?;
        if entry.id != id {
            return Err("damagedVault".into());
        }
        Ok(entry)
    }
    pub fn save(&mut self, mut entry: Entry) -> Result<Entry> {
        self.touch()?;
        validate(&entry)?;
        entry.title = entry.title.trim().to_string();
        entry.folder = entry.folder.trim().to_string();
        entry.tags = entry
            .tags
            .iter()
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
            .collect();
        entry.tags.sort();
        entry.tags.dedup();
        if entry.id.is_empty() {
            entry.id = Uuid::new_v4().to_string();
            entry.created_at = now();
            entry.history.clear();
        } else {
            let previous = self.get(&entry.id)?;
            if url::Url::parse(&previous.url).ok().map(|u| u.origin()) != url::Url::parse(&entry.url).ok().map(|u| u.origin()) {
                entry.favicon.clear();
            }
            entry.created_at = previous.created_at;
            entry.history = previous.history.clone();
            if previous.password != entry.password && !previous.password.is_empty() {
                entry.history.insert(0, previous.password.clone());
                entry.history.truncate(5);
            }
        }
        entry.updated_at = now();
        let s = self.session.as_mut().ok_or("locked")?;
        let plain = Zeroizing::new(serde_json::to_vec(&entry).map_err(|_| "cryptoError")?);
        let sealed = seal(&s.key, &plain, entry_aad(&s.vault_id, &entry.id).as_bytes())?;
        self.conn.execute("INSERT INTO entries(id,sealed) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET sealed=excluded.sealed",params![entry.id,sealed]).map_err(db_error)?;
        s.index.insert(entry.id.clone(), Summary::from(&entry));
        self.backups.dirty = true;
        Ok(entry)
    }
    pub fn delete_forever(&mut self, id: &str, confirmation: &str, confirmation_repeat: &str, master: &str) -> Result<()> {
        self.touch()?;
        if confirmation != "I agree" || confirmation_repeat != "I agree" {
            return Err("deleteConfirmationInvalid".into());
        }
        if !self.session.as_ref().ok_or("locked")?.index.contains_key(id) {
            return Err("notFound".into());
        }
        // Deletion always verifies the master password again.
        self.master_key(master)?;
        self.conn
            .execute("DELETE FROM entries WHERE id=?1", [id])
            .map_err(db_error)?;
        self.session.as_mut().ok_or("locked")?.index.remove(id);
        self.backups.dirty = true;
        Ok(())
    }
    pub(crate) fn reset_local(
        &mut self,
        confirmation: &str,
        master: &str,
        cleanup: impl FnOnce(&Path) -> Result<()>,
    ) -> Result<()> {
        self.touch()?;
        if confirmation.trim() != RESET_CONFIRMATION {
            return Err("resetConfirmationInvalid".into());
        }
        self.master_key(master)?;
        let directory = self.path.parent().ok_or("resetCleanupFailed")?;
        let cleanup_result = cleanup(directory);
        self.backups = crate::backups::Backups::open(&self.path);
        cleanup_result?;
        // secure_delete is enabled on this connection. Wipe the wrapped key and
        // every record in one transaction, so an interrupted commit keeps the vault intact.
        let tx = self.conn.transaction().map_err(db_error)?;
        tx.execute_batch("DELETE FROM entries; DELETE FROM meta;").map_err(db_error)?;
        tx.commit().map_err(db_error)?;
        self.lock();
        self.legacy_pin_retired = false;
        Ok(())
    }
    pub fn change_password(&mut self, current: &str, new: &str) -> Result<()> {
        self.touch()?;
        if new != current { valid_password(new)?; }
        let mut header = self.header()?.ok_or("noVault")?;
        self.master_key(current)?;
        let legacy_files = self.legacy_pin_files()?;
        OsRng
            .try_fill_bytes(&mut header.salt)
            .map_err(|_| "randomError")?;
        let wrapping = derive(new, &header.salt)?;
        let s = self.session.as_ref().ok_or("locked")?;
        let mut next_key = Zeroizing::new([0u8; 32]);
        OsRng
            .try_fill_bytes(next_key.as_mut())
            .map_err(|_| "randomError")?;
        let next_key = LockedKey::new(next_key)?;
        header.wrapped_key = seal(
            &wrapping,
            next_key.as_ref(),
            key_aad(&header.vault_id).as_bytes(),
        )?;
        // Rotate the data key too: knowing an old backup's password must not
        // expose records in the current vault after a master-password change.
        // SQLite commits the records and header together, or rolls all of them back.
        let tx = self.conn.transaction().map_err(db_error)?;
        for id in s.index.keys() {
            let sealed: Vec<u8> = tx
                .query_row("SELECT sealed FROM entries WHERE id=?1", [id], |r| r.get(0))
                .map_err(db_error)?;
            let aad = entry_aad(&s.vault_id, id);
            let plain = unseal(&s.key, &sealed, aad.as_bytes())?;
            let encrypted = seal(&next_key, &plain, aad.as_bytes())?;
            tx.execute(
                "UPDATE entries SET sealed=?1 WHERE id=?2",
                params![encrypted, id],
            )
            .map_err(db_error)?;
        }
        tx.execute(
            "UPDATE meta SET header=?1 WHERE id=1",
            [serde_json::to_string(&header).map_err(|_| "cryptoError")?],
        )
        .map_err(db_error)?;
        tx.commit().map_err(db_error)?;
        self.session.as_mut().ok_or("locked")?.key = next_key;
        self.backups.dirty = true;
        for legacy in legacy_files {
            if std::fs::remove_file(legacy).is_err() { self.lock(); return Err("storageError".into()); }
        }
        Ok(())
    }
    pub fn backup(&mut self, path: &Path) -> Result<()> {
        self.touch()?;
        self.verified_backup(path)
    }
    pub(crate) fn cloud_revision(&self) -> Option<u64> {
        self.session.as_ref().map(|_| self.conn.total_changes())
    }
    pub(crate) fn cloud_snapshot(&mut self, path: &Path) -> Result<u64> {
        self.expire();
        let revision = self.cloud_revision().ok_or("locked")?;
        self.verified_backup(path)?;
        let mut file = OpenOptions::new().read(true).append(true).open(path).map_err(|_| "storageError")?;
        let digest = snapshot_digest(&mut file)?;
        let key = &self.session.as_ref().ok_or("locked")?.key;
        let trailer = seal(key, &digest, CLOUD_AAD)?;
        file.write_all(&trailer).and_then(|_| file.write_all(CLOUD_MAGIC)).map_err(|_| "storageError")?;
        Ok(revision)
    }
    pub(crate) fn restore_cloud_snapshot(&mut self, path: &Path, password: &str) -> Result<()> {
        if self.header()?.is_some() {
            return Err("vaultExists".into());
        }
        let mut file = OpenOptions::new().read(true).write(true).open(path).map_err(|_| "storageError")?;
        let size = file.metadata().map_err(|_| "storageError")?.len();
        let snapshot_size = size.checked_sub(CLOUD_TRAILER).filter(|len| *len >= 512).ok_or("backupValidationFailed")?;
        let mut trailer = [0u8; CLOUD_TRAILER as usize];
        file.seek(SeekFrom::Start(snapshot_size)).and_then(|_| file.read_exact(&mut trailer)).map_err(|_| "backupValidationFailed")?;
        if &trailer[72..] != CLOUD_MAGIC {
            return Err("backupValidationFailed".into());
        }
        file.set_len(snapshot_size).map_err(|_| "storageError")?;
        let digest = snapshot_digest(&mut file)?;
        drop(file);

        let mut source = Self::readonly(path)?;
        let (header, key) = source.master_key(password)?;
        let authenticated = unseal(&key, &trailer[..72], CLOUD_AAD).map_err(|_| "backupValidationFailed")?;
        if authenticated.as_slice() != digest {
            return Err("backupValidationFailed".into());
        }
        source.load_session(header, key)?;
        let integrity: String = source.conn.query_row("PRAGMA quick_check", [], |row| row.get(0)).map_err(db_error)?;
        if integrity != "ok" {
            return Err("backupValidationFailed".into());
        }
        let header: String = source.conn.query_row("SELECT header FROM meta WHERE id=1", [], |row| row.get(0)).map_err(db_error)?;
        let mut entries = source.conn.prepare("SELECT id, sealed FROM entries").map_err(db_error)?;
        let mut rows = entries.query([]).map_err(db_error)?;
        let tx = self.conn.transaction().map_err(db_error)?;
        tx.execute("INSERT INTO meta(id, header) VALUES (1, ?1)", [header]).map_err(db_error)?;
        while let Some(row) = rows.next().map_err(db_error)? {
            tx.execute("INSERT INTO entries(id, sealed) VALUES (?1, ?2)", params![row.get::<_, String>(0).map_err(db_error)?, row.get::<_, Vec<u8>>(1).map_err(db_error)?]).map_err(db_error)?;
        }
        tx.commit().map_err(db_error)?;
        self.backups.dirty = true;
        Ok(())
    }
    fn verified_backup(&self, path: &Path) -> Result<()> {
        if path == self.path || path.exists() {
            return Err("chooseNewFile".into());
        }
        // Reserve without overwriting even if another file appears after exists().
        let reserved = std::fs::OpenOptions::new().write(true).create_new(true).open(path).map_err(|_| "chooseNewFile")?;
        drop(reserved);
        let result = (|| {
            let session = self.session.as_ref().ok_or("locked")?;
            {
                let mut destination = Connection::open(path).map_err(db_error)?;
                let backup = rusqlite::backup::Backup::new(&self.conn, &mut destination).map_err(db_error)?;
                backup.run_to_completion(128, Duration::from_millis(5), None).map_err(db_error)?;
            }
            let snapshot = Self::readonly(path)?;
            let integrity: String = snapshot.conn.query_row("PRAGMA quick_check", [], |r| r.get(0)).map_err(db_error)?;
            if integrity != "ok" { return Err("backupValidationFailed".into()); }
            let current: String = self.conn.query_row("SELECT header FROM meta WHERE id=1", [], |r| r.get(0)).map_err(db_error)?;
            let copied: String = snapshot.conn.query_row("SELECT header FROM meta WHERE id=1", [], |r| r.get(0)).map_err(db_error)?;
            if current != copied { return Err("backupValidationFailed".into()); }
            let mut statement = snapshot.conn.prepare("SELECT id,sealed FROM entries").map_err(db_error)?;
            let rows = statement.query_map([],|r| Ok((r.get::<_,String>(0)?,r.get::<_,Vec<u8>>(1)?))).map_err(db_error)?;
            let mut count = 0;
            for row in rows {
                let (id,sealed) = row.map_err(db_error)?;
                if !session.index.contains_key(&id) { return Err("backupValidationFailed".into()); }
                let plain = unseal(&session.key,&sealed,entry_aad(&session.vault_id,&id).as_bytes())?;
                let entry: Entry = serde_json::from_slice(&plain).map_err(|_| "backupValidationFailed")?;
                if entry.id != id { return Err("backupValidationFailed".into()); }
                validate(&entry)?;
                count += 1;
            }
            if count != session.index.len() { return Err("backupValidationFailed".into()); }
            Ok(())
        })();
        if result.is_err() { let _ = std::fs::remove_file(path); }
        result
    }
    pub fn automatic_backup_info(&self) -> crate::backups::Info { self.backups.info() }
    pub fn configure_automatic_backups(&mut self, enabled: bool) -> Result<crate::backups::Info> {
        self.touch()?;
        let previous = self.backups.enabled;
        self.backups.configure(enabled)?;
        if enabled && let Err(cause) = self.automatic_backup_tick(true) {
            let _ = self.backups.configure(previous);
            return Err(cause);
        }
        Ok(self.backups.info())
    }
    pub fn automatic_backup_tick(&mut self, force: bool) -> Result<()> {
        if !self.writable || self.session.is_none() || !self.backups.enabled || (!force && !self.backups.due(now())) { return Ok(()); }
        let time = now();
        let path = self.backups.begin(time)?;
        self.verified_backup(&path)?;
        self.backups.finish(time);
        Ok(())
    }
    pub fn import_backup(&mut self, path: &Path, password: &str) -> Result<usize> {
        self.touch()?;
        if std::fs::canonicalize(path).ok() == std::fs::canonicalize(&self.path).ok() {
            return Err("sameVault".into());
        }
        let mut source = Self::readonly(path)?;
        source.unlock(password)?;
        let ids: Vec<String> = source
            .session
            .as_ref()
            .ok_or("locked")?
            .index
            .keys()
            .cloned()
            .collect();
        let s = self.session.as_mut().ok_or("locked")?;
        let tx = self.conn.transaction().map_err(db_error)?;
        let mut summaries = Vec::new();
        for id in ids {
            let mut entry = source.get(&id)?;
            entry.id = Uuid::new_v4().to_string();
            let plain = Zeroizing::new(serde_json::to_vec(&entry).map_err(|_| "cryptoError")?);
            let sealed = seal(&s.key, &plain, entry_aad(&s.vault_id, &entry.id).as_bytes())?;
            tx.execute(
                "INSERT INTO entries(id,sealed) VALUES(?1,?2)",
                params![entry.id, sealed],
            )
            .map_err(db_error)?;
            summaries.push(Summary::from(&entry));
        }
        tx.commit().map_err(db_error)?;
        let count = summaries.len();
        for e in summaries {
            s.index.insert(e.id.clone(), e);
        }
        self.backups.dirty = true;
        Ok(count)
    }
}

pub fn generate_password(length: usize, symbols: bool) -> Result<String> {
    if !(8..=128).contains(&length) {
        return Err("invalidLength".into());
    }
    let mut groups: Vec<&[u8]> = vec![
        b"abcdefghijkmnopqrstuvwxyz",
        b"ABCDEFGHJKLMNPQRSTUVWXYZ",
        b"23456789",
    ];
    if symbols {
        groups.push(b"!@#$%&*+-=?_");
    }
    let all: Vec<u8> = groups.iter().flat_map(|g| g.iter().copied()).collect();
    let mut rng = OsRng;
    let mut out: Vec<u8> = groups
        .iter()
        .map(|g| g[rng.gen_range(0..g.len())])
        .collect();
    while out.len() < length {
        out.push(all[rng.gen_range(0..all.len())]);
    }
    out.shuffle(&mut rng);
    String::from_utf8(out).map_err(|_| "randomError".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn entry(title: &str) -> Entry {
        Entry {
            id: String::new(),
            title: title.into(),
            username: "test@example.test".into(),
            password: "VerySecret123!".into(),
            url: "https://example.test".into(),
            favicon: String::new(),
            notes: "Private note".into(),
            folder: "Personal".into(),
            tags: vec!["test".into()],
            favorite: false,
            created_at: 0,
            updated_at: 0,
            fields: vec![],
            history: vec![],
        }
    }
    fn query() -> ListQuery {
        ListQuery {
            search: String::new(),
            filter: "all".into(),
            folder: String::new(),
            sort: "title".into(),
            offset: 0,
            limit: 50,
        }
    }
    #[test]
    fn encryption_authenticates_ciphertext_and_record_identity() {
        let key = [7; 32];
        let a = seal(&key, b"secret", b"id-a").unwrap();
        let b = seal(&key, b"secret", b"id-a").unwrap();
        assert_ne!(a, b);
        assert_eq!(&**unseal(&key, &a, b"id-a").unwrap(), b"secret");
        assert!(unseal(&key, &a, b"id-b").is_err());
        let mut broken = a;
        broken[25] ^= 1;
        assert!(unseal(&key, &broken, b"id-a").is_err());
        assert!(unseal(&key, &[1; 4], b"id").is_err());
    }
    #[test]
    fn vault_round_trip_lock_change_password_and_no_plaintext_on_disk() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("vault.db");
        let mut v = Vault::open(path.clone()).unwrap();
        v.create("a long master passphrase").unwrap();
        let saved = v.save(entry("Private account")).unwrap();
        let disk = std::fs::read(&path).unwrap();
        for secret in [
            "Private account",
            "VerySecret123!",
            "Private note",
            "example.test",
        ] {
            assert!(!disk.windows(secret.len()).any(|w| w == secret.as_bytes()));
        }
        v.lock();
        assert!(v.get(&saved.id).is_err());
        assert!(v.unlock("wrong password").is_err());
        assert!(!v.status().unwrap().unlocked);
        v.unlock("a long master passphrase").unwrap();
        assert_eq!(v.get(&saved.id).unwrap().password, "VerySecret123!");
        assert!(
            v.change_password("wrong", "new long master passphrase")
                .is_err()
        );
        let old_key = Zeroizing::new(*v.session.as_ref().unwrap().key);
        v.change_password("a long master passphrase", "new long master passphrase")
            .unwrap();
        let changed_blob: Vec<u8> = v
            .conn
            .query_row("SELECT sealed FROM entries WHERE id=?1", [&saved.id], |r| {
                r.get(0)
            })
            .unwrap();
        let aad = entry_aad(&v.session.as_ref().unwrap().vault_id, &saved.id);
        assert!(unseal(&old_key, &changed_blob, aad.as_bytes()).is_err());
        v.lock();
        assert!(v.unlock("a long master passphrase").is_err());
        v.unlock("new long master passphrase").unwrap();
        assert_eq!(v.list(query()).unwrap().total, 1);
        v.session.as_mut().unwrap().touched = now() - IDLE_SECONDS;
        assert!(v.expire());
        assert!(v.get(&saved.id).is_err());
        drop(v);
        let mut reopened = Vault::open(path).unwrap();
        reopened.unlock("new long master passphrase").unwrap();
        assert_eq!(reopened.get(&saved.id).unwrap().title, "Private account");
    }
    #[test]
    fn cloud_restore_authenticates_whole_snapshot_and_only_fills_an_empty_vault() {
        let temp = tempfile::tempdir().unwrap();
        let master = "fictional cloud restore passphrase";
        let mut original = Vault::open(temp.path().join("original.sqlite")).unwrap();
        original.create(master).unwrap();
        let saved = original.save(entry("Cloud recovery test")).unwrap();
        let snapshot = temp.path().join("backup.pwcloud");
        original.cloud_snapshot(&snapshot).unwrap();

        let tampered = temp.path().join("tampered.pwcloud");
        let mut bytes = std::fs::read(&snapshot).unwrap();
        let trailer = bytes.split_off(bytes.len() - CLOUD_TRAILER as usize);
        std::fs::write(&tampered, &bytes).unwrap();
        {
            let db = Connection::open(&tampered).unwrap();
            db.execute("DELETE FROM entries", []).unwrap();
        }
        OpenOptions::new().append(true).open(&tampered).unwrap().write_all(&trailer).unwrap();
        let mut restored = Vault::open(temp.path().join("restored.sqlite")).unwrap();
        assert_eq!(restored.restore_cloud_snapshot(&tampered, master).unwrap_err(), "backupValidationFailed");
        assert!(!restored.status().unwrap().exists);

        let wrong = temp.path().join("wrong.pwcloud");
        std::fs::copy(&snapshot, &wrong).unwrap();
        assert_eq!(restored.restore_cloud_snapshot(&wrong, "incorrect password").unwrap_err(), "invalidPassword");
        assert!(!restored.status().unwrap().exists);

        restored.restore_cloud_snapshot(&snapshot, master).unwrap();
        assert!(!restored.status().unwrap().unlocked);
        restored.unlock(master).unwrap();
        assert_eq!(restored.get(&saved.id).unwrap().password, saved.password);
        assert_eq!(restored.restore_cloud_snapshot(&snapshot, master).unwrap_err(), "vaultExists");
    }
    #[test]
    fn favicons_are_bounded_local_pngs_and_survive_encrypted_backups() {
        let icon = format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(include_bytes!("../icons/32x32.png")));
        assert!(valid_favicon(&icon));
        assert!(!valid_favicon("https://example.test/favicon.png"));
        assert!(!valid_favicon("data:image/svg+xml;base64,PHN2Zz4="));
        assert!(!valid_favicon("data:image/png;base64,broken"));
        assert!(!valid_favicon(&"x".repeat(12_289)));
        let mut legacy = serde_json::to_value(entry("Legacy")).unwrap();
        legacy.as_object_mut().unwrap().remove("favicon");
        assert!(serde_json::from_value::<Entry>(legacy).unwrap().favicon.is_empty());
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("icons.db");
        let mut vault = Vault::open(path.clone()).unwrap();
        vault.create("A fictional favicon master").unwrap();
        let mut item = entry("Icon account"); item.favicon = icon.clone();
        let saved = vault.save(item).unwrap();
        assert_eq!(vault.list(query()).unwrap().items[0].favicon, icon);
        let backup = dir.path().join("icon.passward"); vault.backup(&backup).unwrap();
        drop(vault);
        assert!(!std::fs::read(&path).unwrap().windows(icon.len()).any(|bytes| bytes == icon.as_bytes()));
        let mut reopened = Vault::open(path).unwrap(); reopened.unlock("A fictional favicon master").unwrap();
        assert_eq!(reopened.get(&saved.id).unwrap().favicon, icon);
        let mut imported = Vault::open(dir.path().join("import.db")).unwrap(); imported.create("Another fictional favicon master").unwrap();
        assert_eq!(imported.import_backup(&backup,"A fictional favicon master").unwrap(),1);
        assert_eq!(imported.list(query()).unwrap().items[0].favicon, icon);
        let mut changed = reopened.get(&saved.id).unwrap(); changed.url = "https://different.example.test".into();
        assert!(reopened.save(changed).unwrap().favicon.is_empty());
    }
    #[test]
    fn history_pagination_and_encrypted_backup_import() {
        let tmp = tempfile::tempdir().unwrap();
        let mut v = Vault::open(tmp.path().join("a.db")).unwrap();
        v.create("a long master passphrase").unwrap();
        let mut e = v.save(entry("First")).unwrap();
        let id = e.id.clone();
        e.password = "UpdatedSecret456!".into();
        v.save(e).unwrap();
        assert_eq!(v.get(&id).unwrap().history, vec!["VerySecret123!"]);
        for n in 0..105 {
            v.save(entry(&format!("Account {n:03}"))).unwrap();
        }
        let mut q = query();
        q.limit = 1000;
        assert_eq!(v.list(q).unwrap().items.len(), 100);
        let mut q = query();
        q.offset = 100;
        assert_eq!(v.list(q).unwrap().items.len(), 6);
        let backup = tmp.path().join("backup.nook");
        v.backup(&backup).unwrap();
        assert!(v.backup(&backup).is_err());
        let mut other = Vault::open(tmp.path().join("b.db")).unwrap();
        other.create("a different long passphrase").unwrap();
        assert!(other.import_backup(&backup, "wrong").is_err());
        assert_eq!(other.list(query()).unwrap().total, 0);
        assert_eq!(
            other
                .import_backup(&backup, "a long master passphrase")
                .unwrap(),
            106
        );
        assert_eq!(other.list(query()).unwrap().total, 106);

    }
    #[test]
    fn legacy_trash_marker_does_not_hide_or_delete_existing_data() {
        let mut payload = serde_json::to_value(entry("Legacy item")).unwrap();
        payload["deleted"] = serde_json::json!(true);
        let restored: Entry = serde_json::from_value(payload).unwrap();
        let serialized = serde_json::to_value(restored).unwrap();
        assert_eq!(serialized["title"], "Legacy item");
        assert!(serialized.get("deleted").is_none());
    }
    #[test]
    fn master_only_delete_always_reauthenticates_and_preserves_backups() {
        let tmp=tempfile::tempdir().unwrap();
        let path=tmp.path().join("vault.db");
        let master="a long deletion test passphrase";
        let mut v=Vault::open(path.clone()).unwrap();
        v.create(master).unwrap();
        let a=v.save(entry("Delete A")).unwrap();
        let b=v.save(entry("Keep B")).unwrap();
        let backup=tmp.path().join("backup.passward");
        v.backup(&backup).unwrap();
        assert_eq!(v.view_entry(&a.id).unwrap().entry.password,"VerySecret123!");
        assert!(v.delete_forever(&a.id,"I agree","wrong",master).is_err());
        assert!(v.delete_forever(&a.id,"I agree","I agree","7294").is_err());
        assert!(v.delete_forever(&a.id,"I agree","I agree","incorrect master").is_err());
        assert!(v.get(&a.id).is_ok());
        v.lock();
        assert!(v.delete_forever(&a.id,"I agree","I agree",master).is_err());
        v.unlock(master).unwrap();
        v.delete_forever(&a.id,"I agree","I agree",master).unwrap();
        assert!(v.get(&a.id).is_err()); assert!(v.get(&b.id).is_ok());
        drop(v);
        let mut reopened=Vault::open(path).unwrap(); reopened.unlock(master).unwrap();
        assert_eq!(reopened.list(query()).unwrap().total,1);
        let mut snapshot=Vault::readonly(&backup).unwrap(); snapshot.unlock(master).unwrap();
        assert_eq!(snapshot.list(query()).unwrap().total,2);
    }
    #[test]
    fn master_attempts_are_throttled_and_common_new_passwords_are_rejected() {
        let tmp=tempfile::tempdir().unwrap(); let mut v=Vault::open(tmp.path().join("vault.db")).unwrap();
        for weak in ["password123456!","aaaaaaaaaaaa","123456789012"] { assert_eq!(v.create(weak).unwrap_err(),"weakMaster"); }
        let master="a uniquely fictional master passphrase"; v.create(master).unwrap(); v.lock();
        for _ in 0..5 { assert_eq!(v.unlock("wrong").unwrap_err(),"invalidPassword"); }
        assert_eq!(v.unlock(master).unwrap_err(),"authCooldown");
        assert!(!v.status().unwrap().unlocked);
        v.auth_retry_at=Some(std::time::Instant::now()-Duration::from_secs(1));
        v.unlock(master).unwrap(); assert_eq!(v.auth_failures,0);
    }
    #[test]
    fn retiring_legacy_pin_rotates_key_before_removing_files() {
        let tmp=tempfile::tempdir().unwrap(); let path=tmp.path().join("vault.db");
        let master="a legacy migration test passphrase";
        let mut v=Vault::open(path.clone()).unwrap(); v.create(master).unwrap();
        let saved=v.save(entry("Keep during migration")).unwrap();
        let old_key=Zeroizing::new(*v.session.as_ref().unwrap().key);
        // Model an older main PIN record and an interrupted temporary write.
        let legacy=path.with_extension("device-pin");
        let orphan=tmp.path().join(format!(".pin-{}.tmp",Uuid::new_v4()));
        std::fs::write(&legacy,b"legacy device-protected record").unwrap();
        std::fs::write(&orphan,b"interrupted legacy record").unwrap();
        v.lock(); assert!(v.unlock("wrong master").is_err()); assert!(legacy.exists());
        v.unlock(master).unwrap();
        assert!(!legacy.exists()); assert!(!orphan.exists());
        assert!(v.status().unwrap().legacy_pin_retired);
        assert_eq!(v.get(&saved.id).unwrap().password,"VerySecret123!");
        let sealed:Vec<u8>=v.conn.query_row("SELECT sealed FROM entries WHERE id=?1",[&saved.id],|r|r.get(0)).unwrap();
        let aad=entry_aad(&v.session.as_ref().unwrap().vault_id,&saved.id);
        assert!(unseal(&old_key,&sealed,aad.as_bytes()).is_err());
        v.lock(); v.unlock(master).unwrap(); assert!(v.get(&saved.id).is_ok());
    }
    #[test]
    fn failed_legacy_lookup_does_not_leave_a_session_unlocked() {
        let temp=tempfile::tempdir().unwrap();
        let path=temp.path().join("vault.db");
        let master="a filesystem failure test passphrase";
        let mut vault=Vault::open(path.clone()).unwrap(); vault.create(master).unwrap();
        let saved=vault.save(entry("Preserve on failure")).unwrap();
        let not_directory=temp.path().join("not-a-directory");
        std::fs::write(&not_directory,b"fixture").unwrap();
        vault.path=not_directory.join("vault.db");
        assert!(vault.unlock(master).is_err());
        assert!(!vault.status().unwrap().unlocked);
        vault.path=path;
        vault.unlock(master).unwrap();
        assert!(vault.get(&saved.id).is_ok());
    }
    #[test]
    fn automatic_snapshots_are_encrypted_verified_and_do_not_extend_idle() {
        let tmp=tempfile::tempdir().unwrap(); let mut v=Vault::open(tmp.path().join("vault.db")).unwrap();
        let master="an automatic backup test passphrase"; v.create(master).unwrap();
        let saved=v.save(entry("Encrypted backup fixture")).unwrap();
        assert!(!v.automatic_backup_info().enabled);
        let info=v.configure_automatic_backups(true).unwrap(); assert_eq!(info.retained,1);
        v.session.as_mut().unwrap().touched=now()-10;
        let touched=v.session.as_ref().unwrap().touched;
        v.automatic_backup_tick(true).unwrap(); assert_eq!(v.session.as_ref().unwrap().touched,touched);
        let folder=tmp.path().join("automatic-backups");
        let files:Vec<_>=std::fs::read_dir(folder).unwrap().map(|e|e.unwrap().path()).collect();
        for file in &files {
            let bytes=std::fs::read(file).unwrap(); assert!(!bytes.windows(14).any(|w|w==b"VerySecret123!"));
            let mut snapshot=Vault::readonly(file).unwrap(); snapshot.unlock(master).unwrap(); assert!(snapshot.get(&saved.id).is_ok());
        }
        v.conn.execute("UPDATE entries SET sealed=?1 WHERE id=?2",params![vec![0u8;40],&saved.id]).unwrap();
        assert!(v.automatic_backup_tick(true).is_err());
        assert_eq!(v.automatic_backup_info().retained,2);
        v.configure_automatic_backups(false).unwrap(); assert!(!v.automatic_backup_info().enabled);
    }
    #[test]
    fn corrupt_records_fail_closed_and_generation_is_bounded() {
        let tmp = tempfile::tempdir().unwrap();
        let mut v = Vault::open(tmp.path().join("v.db")).unwrap();
        v.create("a long master passphrase").unwrap();
        v.save(entry("Test")).unwrap();
        v.lock();
        v.conn
            .execute("UPDATE entries SET sealed=?1", [vec![0u8; 80]])
            .unwrap();
        assert!(v.unlock("a long master passphrase").is_err());
        assert!(!v.status().unwrap().unlocked);
        assert!(generate_password(2, true).is_err());
        for _ in 0..30 {
            let p = generate_password(24, true).unwrap();
            assert_eq!(p.len(), 24);
            assert!(p.chars().any(|c| c.is_ascii_uppercase()));
            assert!(p.chars().any(|c| c.is_ascii_lowercase()));
            assert!(p.chars().any(|c| c.is_ascii_digit()));
            assert!(p.chars().any(|c| !c.is_alphanumeric()));
        }
        let mut bad = entry("bad");
        bad.url = "javascript:alert(1)".into();
        assert!(validate(&bad).is_err());
    }

    #[test]
    fn ten_thousand_records_paginate_without_sending_passwords() {
        let tmp = tempfile::tempdir().unwrap();
        let mut v = Vault::open(tmp.path().join("large.db")).unwrap();
        v.create("large test master passphrase").unwrap();
        let session = v.session.as_ref().unwrap();
        let tx = v.conn.transaction().unwrap();
        for n in 0..10_000 {
            let mut e = entry(&format!("Account {n:05}"));
            e.id = Uuid::new_v4().to_string();
            let plain = Zeroizing::new(serde_json::to_vec(&e).unwrap());
            let encrypted = seal(
                &session.key,
                &plain,
                entry_aad(&session.vault_id, &e.id).as_bytes(),
            )
            .unwrap();
            tx.execute(
                "INSERT INTO entries(id,sealed) VALUES(?1,?2)",
                params![e.id, encrypted],
            )
            .unwrap();
        }
        tx.commit().unwrap();
        v.lock();
        v.unlock("large test master passphrase").unwrap();
        let mut q = query();
        q.offset = 9950;
        let page = v.list(q).unwrap();
        assert_eq!(page.total, 10_000);
        assert_eq!(page.items.len(), 50);
        assert_eq!(page.items[0].title, "Account 09950");
        let serialized = serde_json::to_string(&page).unwrap();
        assert!(!serialized.contains("VerySecret123!"));
        assert!(!serialized.contains("password"));
    }

    #[test]
    fn failed_key_rotation_rolls_back_every_record_and_header() {
        let tmp = tempfile::tempdir().unwrap();
        let mut v = Vault::open(tmp.path().join("rotate.db")).unwrap();
        v.create("original master passphrase").unwrap();
        v.save(entry("A")).unwrap();
        v.save(entry("B")).unwrap();
        let ids: Vec<String> = v.session.as_ref().unwrap().index.keys().cloned().collect();
        let header: String = v
            .conn
            .query_row("SELECT header FROM meta", [], |r| r.get(0))
            .unwrap();
        let first: Vec<u8> = v
            .conn
            .query_row("SELECT sealed FROM entries WHERE id=?1", [&ids[0]], |r| {
                r.get(0)
            })
            .unwrap();
        v.conn
            .execute(
                "UPDATE entries SET sealed=?1 WHERE id=?2",
                params![vec![0u8; 80], ids[1]],
            )
            .unwrap();
        assert!(
            v.change_password(
                "original master passphrase",
                "replacement master passphrase"
            )
            .is_err()
        );
        let after_header: String = v
            .conn
            .query_row("SELECT header FROM meta", [], |r| r.get(0))
            .unwrap();
        let after_first: Vec<u8> = v
            .conn
            .query_row("SELECT sealed FROM entries WHERE id=?1", [&ids[0]], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(header, after_header);
        assert_eq!(first, after_first);
        assert!(v.get(&ids[0]).is_ok());
    }

}
