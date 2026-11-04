use crate::pin::{PinInfo, PinStore};
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
    pub notes: String,
    pub folder: String,
    pub tags: Vec<String>,
    pub favorite: bool,
    pub deleted: bool,
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
    pub folder: String,
    pub tags: Vec<String>,
    pub favorite: bool,
    pub deleted: bool,
    pub updated_at: u64,
}
impl From<&Entry> for Summary {
    fn from(e: &Entry) -> Self {
        Self {
            id: e.id.clone(),
            title: e.title.clone(),
            username: e.username.clone(),
            url: e.url.clone(),
            folder: e.folder.clone(),
            tags: e.tags.clone(),
            favorite: e.favorite,
            deleted: e.deleted,
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
    pub pin: PinInfo,
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
    pub trash_count: usize,
    pub folders: Vec<String>,
}

struct Session {
    key: Zeroizing<[u8; 32]>,
    vault_id: String,
    index: BTreeMap<String, Summary>,
    touched: u64,
    grants: BTreeMap<String, u64>,
}
pub struct Vault {
    conn: Connection,
    pub path: PathBuf,
    session: Option<Session>,
    pin: PinStore,
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
        Ok(())
    }
}
fn validate(e: &Entry) -> Result<()> {
    if e.title.trim().is_empty()
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
        let pin = PinStore::new(Some(path.with_extension("device-pin")));
        Ok(Self {
            conn,
            path,
            session: None,
            pin,
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
            path: path.to_path_buf(),
            session: None,
            pin: PinStore::new(None),
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
            pin: self.pin.info(&self.header_stamp()?),
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
            grants: BTreeMap::new(),
        });
        Ok(())
    }
    pub fn unlock(&mut self, password: &str) -> Result<()> {
        self.lock();
        let (header, key) = self.master_key(password)?;
        self.load_session(header, key)?;
        let stamp = self.header_stamp()?;
        let _ = self.pin.rearm(&stamp);
        Ok(())
    }
    fn master_key(&self, password: &str) -> Result<(Header, Zeroizing<[u8; 32]>)> {
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
        .map_err(|_| "invalidPassword")?;
        if raw.len() != 32 {
            return Err("damagedVault".into());
        }
        let mut key = Zeroizing::new([0; 32]);
        key.copy_from_slice(&raw);
        Ok((header, key))
    }
    fn load_session(&mut self, header: Header, key: Zeroizing<[u8; 32]>) -> Result<()> {
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
            grants: BTreeMap::new(),
        });
        Ok(())
    }
    fn header_stamp(&self) -> Result<Vec<u8>> {
        let bytes = serde_json::to_vec(&self.header()?).map_err(|_| "damagedVault")?;
        Ok(Sha256::digest(bytes).to_vec())
    }
    pub fn configure_pin(&mut self, master: &str, pin: &str) -> Result<PinInfo> {
        self.touch()?;
        PinStore::validate_candidate(pin)?;
        self.master_key(master)?;
        if self.pin.enabled() {
            self.change_password(master, master)?;
        }
        let (_, key) = self.master_key(master)?;
        let stamp = self.header_stamp()?;
        self.pin.configure(pin, &stamp, &key)?;
        self.session.as_mut().ok_or("locked")?.grants.clear();
        Ok(self.pin.info(&stamp))
    }
    pub fn remove_pin(&mut self, master: &str) -> Result<()> {
        self.touch()?;
        // Rotate the key so replaying a previously saved device PIN file cannot
        // restore a removed or changed PIN against the current vault.
        self.change_password(master, master)?;
        self.pin.remove()?;
        self.session.as_mut().ok_or("locked")?.grants.clear();
        Ok(())
    }
    pub fn unlock_pin(&mut self, pin: &str) -> Result<()> {
        self.lock();
        let header = self.header()?.ok_or("noVault")?;
        let stamp = self.header_stamp()?;
        let key = self.pin.verify(pin, &stamp)?;
        self.load_session(header, key)
    }
    pub fn require_item_access(&mut self, id: &str) -> Result<()> {
        self.touch()?;
        if self.pin.enabled()
            && !self
                .session
                .as_ref()
                .ok_or("locked")?
                .grants
                .get(id)
                .is_some_and(|until| *until > now())
        {
            return Err("pinRequired".into());
        }
        Ok(())
    }
    pub fn authorize_entry(&mut self, id: &str, secret: &str, method: &str) -> Result<EntryView> {
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
        let stamp = self.header_stamp()?;
        match method {
            "pin" => {
                self.pin.verify(secret, &stamp)?;
            }
            "master" => {
                self.master_key(secret)?;
                let _ = self.pin.rearm(&stamp);
            }
            _ => return Err("invalidEntry".into()),
        }
        let s = self.session.as_mut().ok_or("locked")?;
        s.grants.retain(|_, until| *until > now());
        s.grants.insert(id.into(), now() + 60);
        self.view_entry(id)
    }
    pub fn view_entry(&mut self, id: &str) -> Result<EntryView> {
        let mut entry = self.get(id)?;
        let until = self
            .session
            .as_ref()
            .ok_or("locked")?
            .grants
            .get(id)
            .copied()
            .unwrap_or(0);
        let protected = self.pin.enabled() && until <= now();
        let has_password = !entry.password.is_empty();
        let has_notes = !entry.notes.is_empty();
        if protected {
            entry.password.zeroize();
            entry.notes.zeroize();
            entry.history.zeroize();
            entry.history.clear();
            for f in &mut entry.fields {
                f.value.zeroize();
            }
        }
        Ok(EntryView {
            entry,
            protected,
            has_password,
            has_notes,
            grant_expires_at: if self.pin.enabled() { until } else { 0 },
        })
    }
    pub fn lock_entry(&mut self, id: &str) -> Result<EntryView> {
        self.touch()?;
        self.session.as_mut().ok_or("locked")?.grants.remove(id);
        self.view_entry(id)
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

    pub fn browser_matches(&mut self, origin: &str) -> Result<Vec<crate::browser::Account>> {
        self.expire();
        let session = self.session.as_ref().ok_or("locked")?;
        Ok(session
            .index
            .values()
            .filter(|e| {
                !e.deleted && crate::browser::canonical_origin(&e.url).is_ok_and(|o| o == origin)
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
        let all_count = s.index.values().filter(|e| !e.deleted).count();
        let favorite_count = s
            .index
            .values()
            .filter(|e| !e.deleted && e.favorite)
            .count();
        let trash_count = s.index.values().filter(|e| e.deleted).count();
        let mut folders: Vec<String> = s
            .index
            .values()
            .filter(|e| !e.deleted && !e.folder.is_empty())
            .map(|e| e.folder.clone())
            .collect();
        folders.sort();
        folders.dedup();
        let mut entries: Vec<&Summary> = s
            .index
            .values()
            .filter(|e| {
                (if q.filter == "trash" {
                    e.deleted
                } else {
                    !e.deleted
                }) && (q.filter != "favorites" || e.favorite)
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
            trash_count,
            folders,
        })
    }
    pub fn get(&mut self, id: &str) -> Result<Entry> {
        self.touch()?;
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
            entry.deleted = false;
            entry.history.clear();
        } else {
            let previous = self.get(&entry.id)?;
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
        Ok(entry)
    }
    pub fn set_deleted(&mut self, id: &str, deleted: bool) -> Result<()> {
        self.require_item_access(id)?;
        let mut e = self.get(id)?;
        e.deleted = deleted;
        self.save(e)?;
        Ok(())
    }
    pub fn delete_forever(&mut self, id: &str) -> Result<()> {
        self.require_item_access(id)?;
        let entry = self.get(id)?;
        if !entry.deleted {
            return Err("trashFirst".into());
        }
        self.conn
            .execute("DELETE FROM entries WHERE id=?1", [id])
            .map_err(db_error)?;
        self.session.as_mut().ok_or("locked")?.index.remove(id);
        Ok(())
    }
    pub fn change_password(&mut self, current: &str, new: &str) -> Result<()> {
        self.touch()?;
        valid_password(new)?;
        let mut header = self.header()?.ok_or("noVault")?;
        let old = derive(current, &header.salt)?;
        let _verified = unseal(
            &old,
            &header.wrapped_key,
            key_aad(&header.vault_id).as_bytes(),
        )
        .map_err(|_| "invalidPassword")?;
        OsRng
            .try_fill_bytes(&mut header.salt)
            .map_err(|_| "randomError")?;
        let wrapping = derive(new, &header.salt)?;
        let s = self.session.as_ref().ok_or("locked")?;
        let mut next_key = Zeroizing::new([0u8; 32]);
        OsRng
            .try_fill_bytes(next_key.as_mut())
            .map_err(|_| "randomError")?;
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
        self.session.as_mut().ok_or("locked")?.grants.clear();
        // A previous PIN can never open the newly rotated key. Failure to remove
        // its device file leaves it unavailable and keeps item access fail-closed.
        let _ = self.pin.remove();
        Ok(())
    }
    pub fn backup(&mut self, path: &Path) -> Result<()> {
        self.touch()?;
        if path == self.path || path.exists() {
            return Err("chooseNewFile".into());
        }
        let mut destination = Connection::open(path).map_err(db_error)?;
        let backup =
            rusqlite::backup::Backup::new(&self.conn, &mut destination).map_err(db_error)?;
        backup
            .run_to_completion(128, Duration::from_millis(5), None)
            .map_err(db_error)?;
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
            notes: "Private note".into(),
            folder: "Personal".into(),
            tags: vec!["test".into()],
            favorite: false,
            deleted: false,
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
    fn history_trash_pagination_and_encrypted_backup_import() {
        let tmp = tempfile::tempdir().unwrap();
        let mut v = Vault::open(tmp.path().join("a.db")).unwrap();
        v.create("a long master passphrase").unwrap();
        let mut e = v.save(entry("First")).unwrap();
        let id = e.id.clone();
        e.password = "UpdatedSecret456!".into();
        v.save(e).unwrap();
        assert_eq!(v.get(&id).unwrap().history, vec!["VerySecret123!"]);
        v.set_deleted(&id, true).unwrap();
        assert_eq!(v.list(query()).unwrap().total, 0);
        v.set_deleted(&id, false).unwrap();
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
        assert!(v.delete_forever(&id).is_err());
        v.set_deleted(&id, true).unwrap();
        v.delete_forever(&id).unwrap();
        assert!(v.get(&id).is_err());
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

    #[test]
    #[cfg(windows)]
    fn pin_unlock_and_item_authorization_cannot_be_bypassed() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("vault.db");
        let master = "test master passphrase";
        let mut v = Vault::open(path.clone()).unwrap();
        v.create(master).unwrap();
        let a = v.save(entry("A")).unwrap();
        let b = v.save(entry("B")).unwrap();
        assert!(v.configure_pin("wrong", "7294").is_err());
        v.configure_pin(master, "7294").unwrap();
        let redacted = v.view_entry(&a.id).unwrap();
        assert!(redacted.protected);
        assert!(redacted.entry.password.is_empty());
        assert!(redacted.entry.notes.is_empty());
        assert!(redacted.has_password);
        assert!(v.sensitive_entry(&a.id).is_err());
        let attempt = v.get(&a.id).unwrap();
        assert!(v.save_from_ui(attempt).is_err());
        v.set_favorite(&a.id, true).unwrap();
        assert_eq!(v.get(&a.id).unwrap().password, "VerySecret123!");
        assert!(v.set_deleted(&a.id, true).is_err());
        v.authorize_entry(&a.id, "7294", "pin").unwrap();
        assert!(v.sensitive_entry(&a.id).is_ok());
        assert!(v.sensitive_entry(&b.id).is_err());
        v.lock_entry(&a.id).unwrap();
        assert!(v.sensitive_entry(&a.id).is_err());
        v.authorize_entry(&a.id, master, "master").unwrap();
        v.session
            .as_mut()
            .unwrap()
            .grants
            .insert(a.id.clone(), now() - 1);
        assert!(v.view_entry(&a.id).unwrap().protected);
        v.lock();
        v.unlock_pin("7294").unwrap();
        assert!(v.view_entry(&a.id).unwrap().protected);
        let pin_path = path.with_extension("device-pin");
        let old_pin_file = std::fs::read(&pin_path).unwrap();
        v.configure_pin(master, "8362").unwrap();
        v.lock();
        assert!(v.unlock_pin("7294").is_err());
        v.unlock_pin("8362").unwrap();
        v.remove_pin(master).unwrap();
        assert!(!v.status().unwrap().pin.enabled);
        drop(v);
        std::fs::write(&pin_path, old_pin_file).unwrap();
        let mut v = Vault::open(path).unwrap();
        assert!(v.unlock_pin("7294").is_err());
        v.unlock(master).unwrap();
        assert!(v.view_entry(&a.id).unwrap().protected);
        v.authorize_entry(&a.id, master, "master").unwrap();
        assert_eq!(v.sensitive_entry(&a.id).unwrap().password, "VerySecret123!");
    }
}
