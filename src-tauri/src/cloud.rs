use std::{
    fs::{self, File},
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
    thread,
    time::{Duration, Instant},
};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use rand::{RngCore, rngs::OsRng};
use reqwest::blocking::{Body, Client, Response};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;
use tempfile::{NamedTempFile, TempDir};
use url::Url;
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::{
    BrowserIntegration, VaultState,
    device_protection::{platform_protect, platform_unprotect},
    vault::{Result, now},
};

const MAX_SIZE: u64 = 1024 * 1024 * 1024;
const OCTETS: &str = "application/octet-stream";
const INTERVAL: Duration = Duration::from_secs(5);
const RETRY: Duration = Duration::from_secs(30);
const API_TIMEOUT: Duration = Duration::from_secs(12);
const TRANSFER_TIMEOUT: Duration = Duration::from_secs(25);
const SYNC_TIMEOUT: Duration = Duration::from_secs(45);
const DOWNLOAD_CACHE_TTL: Duration = Duration::from_secs(120);

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SyncStage { Downloading, Merging, Preparing, Checking, Uploading, Finishing }

struct CachedDownload { id: Uuid, file: NamedTempFile, expires: Instant }

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Config {
    token: Zeroizing<String>,
    email: String,
    enabled: bool,
    last_backup: Option<u64>,
    #[serde(default)]
    last_snapshot: Option<Uuid>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Info {
    email: String,
    enabled: bool,
    last_backup: Option<u64>,
    issue: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    id: Uuid,
    created_at: String,
    size: u64,
}

struct Pending {
    id: Uuid,
    directory: TempDir,
    revision: u64,
    size: u64,
}

impl Pending {
    fn path(&self) -> PathBuf {
        self.directory.path().join("snapshot")
    }
}

struct Runtime {
    last_revision: Option<u64>,
    pending: Option<Pending>,
    next_try: Instant,
    downloaded: Option<CachedDownload>,
}

impl Default for Runtime {
    fn default() -> Self {
        Self {
            last_revision: None,
            pending: None,
            next_try: Instant::now(),
            downloaded: None,
        }
    }
}

struct Inner {
    path: PathBuf,
    config: Mutex<Config>,
    runtime: Mutex<Runtime>,
    issue: Mutex<Option<String>>,
    operation: Mutex<()>,
}

#[derive(Clone)]
pub(crate) struct Cloud(Arc<Inner>);

impl Cloud {
    pub(crate) fn open(path: PathBuf) -> Self {
        let config = fs::read(&path)
            .ok()
            .and_then(|bytes| platform_unprotect(&bytes).ok())
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        Self(Arc::new(Inner {
            path,
            config: Mutex::new(config),
            runtime: Mutex::new(Runtime::default()),
            issue: Mutex::new(None),
            operation: Mutex::new(()),
        }))
    }

    fn directory(&self) -> Result<PathBuf> {
        self.0
            .path
            .parent()
            .map(PathBuf::from)
            .ok_or_else(|| "storageError".into())
    }

    fn config(&self) -> Result<Config> {
        self.0
            .config
            .lock()
            .map(|config| config.clone())
            .map_err(|_| "storageError".into())
    }

    fn update(&self, config: Config) -> Result<()> {
        if config.token.is_empty() {
            match fs::remove_file(&self.0.path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err("storageError".into()),
            }
        } else {
            let bytes = Zeroizing::new(serde_json::to_vec(&config).map_err(|_| "storageError")?);
            let protected = platform_protect(&bytes).map_err(|_| "storageError")?;
            let mut file = NamedTempFile::new_in(self.directory()?).map_err(|_| "storageError")?;
            file.write_all(&protected)
                .and_then(|_| file.as_file().sync_all())
                .map_err(|_| "storageError")?;
            file.persist(&self.0.path).map_err(|_| "storageError")?;
        }
        *self.0.config.lock().map_err(|_| "storageError")? = config;
        Ok(())
    }

    fn info(&self) -> Result<Info> {
        let config = self.config()?;
        Ok(Info {
            email: config.email,
            enabled: config.enabled,
            last_backup: config.last_backup,
            issue: self.0.issue.lock().map_err(|_| "storageError")?.clone(),
        })
    }

    fn record_issue(&self, issue: Option<String>) {
        if let Ok(mut value) = self.0.issue.lock() {
            *value = issue;
        }
    }

    fn connected(&self) -> Result<Config> {
        let config = self.config()?;
        if config.token.is_empty() {
            return Err("cloudSignInRequired".into());
        }
        Ok(config)
    }

    fn backup(&self, vault: &VaultState, manual: bool) -> Result<()> {
        let _operation = match self.0.operation.try_lock() {
            Ok(lock) => lock,
            Err(_) if !manual => return Ok(()),
            Err(_) => return Err("cloudBusy".into()),
        };
        self.backup_locked(vault, manual, self.config()?.last_snapshot, Instant::now() + SYNC_TIMEOUT, &|_| {})
    }

    fn backup_locked(&self, vault: &VaultState, manual: bool, mut expected: Option<Uuid>, deadline: Instant, progress: &dyn Fn(SyncStage)) -> Result<()> {
        let mut config = self.config()?;
        if !manual && !config.enabled {
            return Ok(());
        }
        if config.token.is_empty() {
            return Err("cloudSignInRequired".into());
        }
        let requested_revision = if manual {
            let mut vault = vault.0.lock().map_err(|_| "storageError")?;
            vault.touch()?;
            vault.cloud_revision()
        } else {
            None
        };
        let mut runtime = self.0.runtime.lock().map_err(|_| "storageError")?;
        if !manual && Instant::now() < runtime.next_try {
            return Ok(());
        }
        loop {
            if runtime.pending.is_none() {
                progress(SyncStage::Preparing);
                let mut vault = vault.0.lock().map_err(|_| "storageError")?;
                let revision = vault.cloud_revision();
                if !manual && (revision.is_none() || revision == runtime.last_revision) {
                    return Ok(());
                }
                let directory =
                    tempfile::tempdir_in(self.directory()?).map_err(|_| "storageError")?;
                let path = directory.path().join("snapshot");
                let revision = vault.cloud_snapshot(&path)?;
                let size = fs::metadata(path).map_err(|_| "storageError")?.len();
                if size > MAX_SIZE {
                    runtime.next_try = Instant::now() + RETRY;
                    self.record_issue(Some("cloudTooLarge".into()));
                    return Err("cloudTooLarge".into());
                }
                runtime.pending = Some(Pending {
                    id: Uuid::new_v4(),
                    directory,
                    revision,
                    size,
                });
            }
            let pending = runtime.pending.as_ref().ok_or("storageError")?;
            // A different device may have uploaded since our last backup. Do not
            // bury its records under a one-way automatic backup before a merge.
            progress(SyncStage::Checking);
            let latest = match self.snapshots_until(deadline) {
                Ok(snapshots) => snapshots.first().map(|snapshot| snapshot.id),
                Err(cause) => {
                    runtime.next_try = Instant::now() + RETRY;
                    self.record_issue(Some(cause.clone()));
                    return Err(cause);
                }
            };
            if latest != expected && latest != Some(pending.id) {
                runtime.next_try = Instant::now() + RETRY;
                self.record_issue(Some("cloudChanged".into()));
                return Err("cloudChanged".into());
            }
            let result = upload(&config.token, pending, deadline, progress);
            let uploaded_revision = pending.revision;
            let uploaded_id = pending.id;
            match result {
                Ok(()) => {
                    runtime.last_revision = Some(uploaded_revision);
                    expected = Some(uploaded_id);
                    runtime.pending = None;
                    runtime.next_try = Instant::now() + INTERVAL;
                    config.last_backup = Some(now());
                    config.last_snapshot = expected;
                    self.update(config)?;
                    self.record_issue(None);
                    if requested_revision
                        .is_some_and(|revision| runtime.last_revision < Some(revision))
                    {
                        config = self.connected()?;
                        continue;
                    }
                    return Ok(());
                }
                Err(error) => {
                    if error == "cloudRetrySnapshot" {
                        runtime.pending = None;
                    }
                    runtime.next_try = Instant::now() + RETRY;
                    self.record_issue(Some(error.clone()));
                    return Err(error);
                }
            }
        }
    }

    fn snapshots(&self) -> Result<Vec<Snapshot>> {
        self.snapshots_until(Instant::now() + API_TIMEOUT)
    }

    fn snapshots_until(&self, deadline: Instant) -> Result<Vec<Snapshot>> {
        #[derive(Deserialize)]
        struct List { snapshots: Vec<Snapshot> }
        let config = self.connected()?;
        let mut list: List = api_until(&client()?, "/api/passwards/backup", &config.token, json!({ "action": "list" }), deadline)?;
        list.snapshots.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        Ok(list.snapshots)
    }

    fn download(&self, id: Uuid) -> Result<NamedTempFile> {
        self.download_until(id, Instant::now() + SYNC_TIMEOUT)
    }

    fn download_until(&self, id: Uuid, deadline: Instant) -> Result<NamedTempFile> {
        #[derive(Deserialize)]
        struct Download { url: String, size: u64 }
        let config = self.connected()?;
        let client = client()?;
        let download: Download = api_until(&client, "/api/passwards/backup", &config.token,
            json!({ "action": "download", "id": id }), deadline)?;
        if !(512..=MAX_SIZE).contains(&download.size) { return Err("backupValidationFailed".into()); }
        let response = client.get(signed_url(&download.url, false)?)
            .timeout(remaining(deadline, TRANSFER_TIMEOUT)?).send().map_err(network_error)?;
        if response.status().as_u16() == 404 { return Err("cloudMissing".into()); }
        if !response.status().is_success() { return Err("cloudDownloadFailed".into()); }
        let mut response = response.take(download.size + 1);
        let mut file = NamedTempFile::new_in(self.directory()?).map_err(|_| "storageError")?;
        let bytes = std::io::copy(&mut response, &mut file).map_err(read_network_error)?;
        if bytes != download.size { return Err("backupValidationFailed".into()); }
        Ok(file)
    }

    fn cached_snapshot(&self, id: Uuid, deadline: Instant) -> Result<NamedTempFile> {
        {
            let runtime = self.0.runtime.lock().map_err(|_| "storageError")?;
            if let Some(cached) = runtime.downloaded.as_ref().filter(|cached| cached.id == id && cached.expires > Instant::now()) {
                return copy_download(&cached.file);
            }
        }
        let file = self.download_until(id, deadline)?;
        let attempt = copy_download(&file)?;
        self.0.runtime.lock().map_err(|_| "storageError")?.downloaded = Some(CachedDownload {
            id, file, expires: Instant::now() + DOWNLOAD_CACHE_TTL,
        });
        Ok(attempt)
    }

    fn sync(&self, vault: &VaultState, id: Option<Uuid>, password: Option<&str>, progress: &dyn Fn(SyncStage)) -> Result<usize> {
        let _operation = self.0.operation.try_lock().map_err(|_| "cloudBusy")?;
        let deadline = Instant::now() + SYNC_TIMEOUT;
        vault.0.lock().map_err(|_| "storageError")?.touch()?;
        let imported = if let Some(id) = id {
            progress(SyncStage::Downloading);
            let file = self.cached_snapshot(id, deadline)?;
            progress(SyncStage::Merging);
            vault.0.lock().map_err(|_| "storageError")?.merge_cloud_snapshot(file.path(), password)?
        } else { 0 };
        // Keep the same upload ID after a failed transfer if its contents still
        // match. Creating a fresh ID on every retry makes the server reject it
        // as backup_pending until the previous reservation expires.
        let revision = vault.0.lock().map_err(|_| "storageError")?.cloud_revision();
        {
            let mut runtime = self.0.runtime.lock().map_err(|_| "storageError")?;
            if runtime.pending.as_ref().is_some_and(|pending| Some(pending.revision) != revision) { runtime.pending = None; }
        }
        // The selected backup is immutable and was explicitly confirmed in the
        // UI. Check for a newer backup once, immediately before uploading, rather
        // than making three identical list requests around the local merge.
        self.backup_locked(vault, true, id, deadline, progress)?;
        self.0.runtime.lock().map_err(|_| "storageError")?.downloaded = None;
        Ok(imported)
    }

    pub(crate) fn start_worker(self, vault: VaultState, app: AppHandle) {
        thread::spawn(move || {
            loop {
                thread::sleep(Duration::from_secs(5));
                if let Ok(mut runtime) = self.0.runtime.try_lock() {
                    if runtime.downloaded.as_ref().is_some_and(|cached| cached.expires <= Instant::now()) { runtime.downloaded = None; }
                }
                let before = self.info().ok().map(|info| (info.last_backup, info.issue));
                let _ = self.backup(&vault, false);
                let after = self.info().ok().map(|info| (info.last_backup, info.issue));
                if before != after {
                    let _ = app.emit("cloud-backup-changed", ());
                }
            }
        });
    }
}

fn base_url() -> Result<Url> {
    let url = Url::parse(option_env!("PASSWARDS_CLOUD_ORIGIN").unwrap_or("https://devtune.app"))
        .map_err(|_| "cloudUnavailable")?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("cloudUnavailable".into());
    }
    Ok(url)
}

fn client() -> Result<Client> {
    // Clones share DNS/TLS connections and the HTTP pool across sync steps.
    static CLIENT: OnceLock<Result<Client>> = OnceLock::new();
    CLIENT.get_or_init(|| client_with_timeout(TRANSFER_TIMEOUT)).clone()
}

fn client_with_timeout(timeout: Duration) -> Result<Client> {
    Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(timeout)
        .pool_idle_timeout(Duration::from_secs(90))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "cloudUnavailable".into())
}

fn revoke_session(token: &str) {
    if !token.is_empty()
        && let Ok(client) = client_with_timeout(Duration::from_secs(5))
    {
        let _: Result<Value> = api_until(
            &client,
            "/api/passwards/backup",
            token,
            json!({ "action": "disconnect" }),
            Instant::now() + Duration::from_secs(5),
        );
    }
}

fn api<T: DeserializeOwned>(
    client: &Client,
    endpoint: &str,
    token: &str,
    body: Value,
) -> Result<T> {
    api_until(client, endpoint, token, body, Instant::now() + API_TIMEOUT)
}

fn remaining(deadline: Instant, limit: Duration) -> Result<Duration> {
    deadline.checked_duration_since(Instant::now()).filter(|left| !left.is_zero())
        .map(|left| left.min(limit)).ok_or_else(|| "cloudTimeout".into())
}

fn network_error(error: reqwest::Error) -> String {
    if error.is_timeout() { "cloudTimeout" } else { "cloudNetwork" }.into()
}

fn read_network_error(error: std::io::Error) -> String {
    if error.kind() == std::io::ErrorKind::TimedOut || error.get_ref().and_then(|source| source.downcast_ref::<reqwest::Error>()).is_some_and(reqwest::Error::is_timeout) {
        "cloudTimeout"
    } else { "cloudNetwork" }.into()
}

fn copy_download(file: &NamedTempFile) -> Result<NamedTempFile> {
    // Validation strips the cloud trailer from its input. Keep the encrypted
    // original intact so asking for its password never downloads it again.
    let mut attempt = NamedTempFile::new_in(file.path().parent().ok_or("storageError")?).map_err(|_| "storageError")?;
    let mut source = File::open(file.path()).map_err(|_| "storageError")?;
    std::io::copy(&mut source, &mut attempt).map_err(|_| "storageError")?;
    Ok(attempt)
}

fn api_until<T: DeserializeOwned>(client: &Client, endpoint: &str, token: &str, body: Value, deadline: Instant) -> Result<T> {
    let url = base_url()?.join(endpoint).map_err(|_| "cloudUnavailable")?;
    let mut request = client.post(url).json(&body).timeout(remaining(deadline, API_TIMEOUT)?);
    if !token.is_empty() {
        request = request.bearer_auth(token);
    }
    decode(request.send().map_err(network_error)?)
}

fn decode<T: DeserializeOwned>(response: Response) -> Result<T> {
    let status = response.status();
    let mut data = Zeroizing::new(Vec::new());
    response
        .take(32_768)
        .read_to_end(&mut data)
        .map_err(read_network_error)?;
    if status.is_success() {
        return serde_json::from_slice(&data).map_err(|_| "cloudUnavailable".into());
    }
    let error: Value = serde_json::from_slice(&data).unwrap_or_default();
    Err(
        match (status.as_u16(), error.get("error").and_then(Value::as_str)) {
            (401, _) => "cloudSignInRequired",
            (409, Some("backup_pending")) => "cloudPending",
            (409, Some("backup_expired")) => "cloudRetrySnapshot",
            (409, Some("backup_incomplete")) => "cloudUploadFailed",
            (404, Some("backup_missing")) => "cloudMissing",
            (429, _) => "cloudBusy",
            _ => "cloudUnavailable",
        }
        .into(),
    )
}

fn signed_url(value: &str, upload: bool) -> Result<Url> {
    let url = Url::parse(value).map_err(|_| "cloudUnavailable")?;
    let host = url.host_str().ok_or("cloudUnavailable")?;
    let allowed = if upload {
        host == "vercel.com" && url.path() == "/api/blob/"
    } else {
        host.ends_with(".private.blob.vercel-storage.com")
    };
    if url.scheme() != "https"
        || !allowed
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err("cloudUnavailable".into());
    }
    Ok(url)
}

fn upload(token: &str, pending: &Pending, deadline: Instant, progress: &dyn Fn(SyncStage)) -> Result<()> {
    #[derive(Deserialize)]
    struct Start {
        url: Option<String>,
        ready: Option<bool>,
    }
    let client = client()?;
    progress(SyncStage::Uploading);
    let start: Start = api_until(
        &client,
        "/api/passwards/backup",
        token,
        json!({
            "action": "start", "id": pending.id, "size": pending.size,
        }),
        deadline,
    )?;
    if start.ready == Some(true) {
        return Ok(());
    }
    let url = signed_url(&start.url.ok_or("cloudUnavailable")?, true)?;
    put_snapshot(&client, url, pending, deadline)?;
    progress(SyncStage::Finishing);
    // A retry may get an upload conflict after a successful earlier transfer.
    // Only the complete API can confirm that this particular snapshot exists.
    let _: Value = api_until(
        &client,
        "/api/passwards/backup",
        token,
        json!({ "action": "complete", "id": pending.id }),
        deadline,
    )?;
    Ok(())
}

fn put_snapshot(client: &Client, url: Url, pending: &Pending, deadline: Instant) -> Result<()> {
    let file = File::open(pending.path()).map_err(|_| "storageError")?;
    let response = client
        .put(url)
        .timeout(remaining(deadline, TRANSFER_TIMEOUT)?)
        .header("content-type", OCTETS)
        .header("x-content-type", OCTETS)
        .body(Body::sized(file, pending.size))
        .send().map_err(network_error)?;
    if !response.status().is_success() && response.status().as_u16() != 409 { return Err("cloudUploadFailed".into()); }
    Ok(())
}

fn random_token() -> Result<Zeroizing<String>> {
    let mut bytes = Zeroizing::new([0; 32]);
    OsRng
        .try_fill_bytes(bytes.as_mut())
        .map_err(|_| "randomError")?;
    Ok(Zeroizing::new(URL_SAFE_NO_PAD.encode(bytes.as_ref())))
}

fn callback_request(stream: &mut TcpStream, port: u16, state: &str) -> Option<Zeroizing<String>> {
    stream.set_read_timeout(Some(Duration::from_secs(1))).ok()?;
    stream
        .set_write_timeout(Some(Duration::from_secs(1)))
        .ok()?;
    let mut request = Zeroizing::new(Vec::new());
    let mut chunk = Zeroizing::new([0; 512]);
    while request.len() < 8192 && !request.windows(4).any(|item| item == b"\r\n\r\n") {
        let count = stream.read(chunk.as_mut()).ok()?;
        if count == 0 {
            return None;
        }
        request.extend_from_slice(&chunk[..count]);
    }
    let raw = std::str::from_utf8(&request).ok()?;
    let mut lines = raw.split("\r\n");
    let mut first = lines.next()?.split_ascii_whitespace();
    if first.next()? != "GET" {
        return None;
    }
    let path = first.next()?;
    if !path.starts_with("/callback?") {
        return None;
    }
    let host = format!("127.0.0.1:{port}");
    if !lines.take_while(|line| !line.is_empty()).any(|line| {
        line.split_once(':')
            .is_some_and(|(key, value)| key.eq_ignore_ascii_case("host") && value.trim() == host)
    }) {
        return None;
    }
    let url = Url::parse(&format!("http://{host}{path}")).ok()?;
    let mut code = None;
    let mut matches = false;
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "code" => code = Some(Zeroizing::new(value.into_owned())),
            "state" => matches = bool::from(value.as_bytes().ct_eq(state.as_bytes())),
            _ => {}
        }
    }
    if !matches {
        return None;
    }
    code.filter(|value| {
        value.len() == 43
            && value
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    })
}

fn write_connection_result(mut response: impl Write, connected: bool) -> std::io::Result<()> {
    let (status, result, title, detail, icon) = if connected {
        (
            "200 OK",
            "success",
            "PassWards is connected",
            "You can close this tab and return to PassWards to manage your cloud backups.",
            "m5 12 4 4L19 6",
        )
    } else {
        (
            "400 Bad Request",
            "error",
            "PassWards couldn’t connect",
            "Return to PassWards and start the connection again.",
            "M12 5v8m0 5h.01",
        )
    };
    let body = include_str!("cloud_connection.html")
        .replace("{{result}}", result)
        .replace("{{title}}", title)
        .replace("{{detail}}", detail)
        .replace("{{icon}}", icon);
    write!(
        response,
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    )
}

#[cfg(test)]
#[test]
fn cloud_callback_returns_html_for_each_connection_result() {
    for (connected, status, title) in [
        (true, "200 OK", "PassWards is connected"),
        (false, "400 Bad Request", "PassWards couldn’t connect"),
    ] {
        let mut bytes = Vec::new();
        write_connection_result(&mut bytes, connected).unwrap();
        let response = String::from_utf8(bytes).unwrap();
        let (headers, body) = response.split_once("\r\n\r\n").unwrap();
        assert!(headers.starts_with(&format!("HTTP/1.1 {status}\r\n")));
        assert!(headers.contains("Content-Type: text/html; charset=utf-8"));
        assert!(headers.contains("Referrer-Policy: no-referrer"));
        assert!(headers.ends_with(&format!("Content-Length: {}", body.len())));
        assert!(body.contains(&format!("<h1 id=\"result-title\">{title}</h1>")));
        assert!(!body.contains("{{"));
    }
}

fn sign_in(app: &AppHandle, expected_email: Option<&str>) -> Result<Config> {
    let listener =
        TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).map_err(|_| "cloudUnavailable")?;
    listener
        .set_nonblocking(true)
        .map_err(|_| "cloudUnavailable")?;
    let port = listener
        .local_addr()
        .map_err(|_| "cloudUnavailable")?
        .port();
    let state = random_token()?;
    let verifier = random_token()?;
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let mut url = base_url()?
        .join("/connect/passwards")
        .map_err(|_| "cloudUnavailable")?;
    url.query_pairs_mut()
        .append_pair("port", &port.to_string())
        .append_pair("state", &state)
        .append_pair("challenge", &challenge);
    if let Some(email) = expected_email {
        let next = format!("{}?{}", url.path(), url.query().ok_or("cloudUnavailable")?);
        url = base_url()?
            .join("/register")
            .map_err(|_| "cloudUnavailable")?;
        url.query_pairs_mut().append_pair("next", &next);
        let hint = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("email", email)
            .finish();
        url.set_fragment(Some(&hint));
    }
    app.opener()
        .open_url(url.to_string(), None::<&str>)
        .map_err(|_| "cloudUnavailable")?;

    let deadline = Instant::now() + Duration::from_secs(180);
    while Instant::now() < deadline {
        match listener.accept() {
            Ok((mut stream, peer)) if peer.ip().is_loopback() => {
                if let Some(code) = callback_request(&mut stream, port, &state) {
                    #[derive(Deserialize)]
                    struct Account {
                        token: Zeroizing<String>,
                        email: String,
                    }
                    let client = client()?;
                    let mut account: Result<Account> = api(
                        &client,
                        "/api/passwards/exchange",
                        "",
                        json!({
                            "code": code.as_str(), "verifier": verifier.as_str(), "port": port,
                        }),
                    );
                    if let Ok(signed_in) = &account
                        && expected_email
                            .is_some_and(|email| !email.eq_ignore_ascii_case(&signed_in.email))
                    {
                        let _: Result<Value> = api(
                            &client,
                            "/api/passwards/backup",
                            &signed_in.token,
                            json!({ "action": "disconnect" }),
                        );
                        account = Err("cloudEmailMismatch".into());
                    }
                    let _ = write_connection_result(&mut stream, account.is_ok());
                    let account = account?;
                    return Ok(Config {
                        token: account.token,
                        email: account.email,
                        ..Config::default()
                    });
                }
                let _ = stream.write_all(
                    b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
                );
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(100))
            }
            Err(_) => return Err("cloudUnavailable".into()),
        }
    }
    Err("cloudSignInTimeout".into())
}

async fn run<T: Send + 'static>(work: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| "cloudUnavailable")?
}

#[tauri::command]
pub(crate) fn cloud_info(cloud: State<'_, Cloud>) -> Result<Info> {
    cloud.info()
}

#[tauri::command]
pub(crate) async fn cloud_connect(
    cloud: State<'_, Cloud>,
    app: AppHandle,
    email: Option<String>,
) -> Result<Info> {
    let cloud = cloud.inner().clone();
    run(move || {
        let _operation = cloud.0.operation.try_lock().map_err(|_| "cloudBusy")?;
        let email = email.as_deref().map(str::trim);
        if email.is_some_and(|value| value.len() > 254 || !value.contains('@')) {
            return Err("cloudEmailInvalid".into());
        }
        let config = sign_in(&app, email)?;
        let previous = cloud.config()?;
        cloud.update(config)?;
        revoke_session(&previous.token);
        *cloud.0.runtime.lock().map_err(|_| "storageError")? = Runtime::default();
        cloud.record_issue(None);
        let _ = app.emit("cloud-backup-changed", ());
        cloud.info()
    })
    .await
}

#[tauri::command]
pub(crate) async fn reset_local(
    app: AppHandle,
    cloud: State<'_, Cloud>,
    vault: State<'_, VaultState>,
    browser: State<'_, BrowserIntegration>,
    master: String,
) -> Result<()> {
    let cloud = cloud.inner().clone();
    let vault = vault.inner().clone();
    let browser = browser.inner().clone();
    let app_data = app.path().app_data_dir().map_err(|_| "resetCleanupFailed")?;
    let master = Zeroizing::new(master);
    run(move || {
        // Backups, account changes and restore all take this lock before the vault.
        let _operation = cloud.0.operation.try_lock().map_err(|_| "cloudBusy")?;
        let mut token = Zeroizing::new(String::new());
        let result = {
            let mut vault = vault.0.lock().map_err(|_| "storageError")?;
            let mut browser = browser.0.lock().map_err(|_| "storageError")?;
            vault.reset_local(&master, |directory| {
                if directory != app_data || cloud.0.path.parent() != Some(directory) {
                    return Err("resetCleanupFailed".into());
                }
                crate::reset::checked_directory(directory)?;
                let previous = cloud.config()?;
                let mut runtime = cloud.0.runtime.lock().map_err(|_| "storageError")?;
                cloud.update(Config::default()).map_err(|_| "resetCleanupFailed")?;
                token = previous.token;
                *runtime = Runtime::default();
                cloud.record_issue(None);
                let result = crate::reset::purge_auxiliary(directory);
                let transport_error = browser.error;
                *browser = crate::browser::BrowserState::open(directory.join("browsers.device"));
                browser.error |= transport_error;
                result
            })
        };
        revoke_session(&token);
        result
    })
    .await?;
    crate::clear_clipboard(&app, false);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.clear_all_browsing_data();
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn cloud_enable(
    cloud: State<'_, Cloud>,
    vault: State<'_, VaultState>,
    enabled: bool,
) -> Result<Info> {
    let cloud = cloud.inner().clone();
    let vault = vault.inner().clone();
    run(move || {
        let _operation = cloud.0.operation.try_lock().map_err(|_| "cloudBusy")?;
        vault.0.lock().map_err(|_| "storageError")?.touch()?;
        let mut config = cloud.connected()?;
        config.enabled = enabled;
        cloud.update(config)?;
        let mut runtime = cloud.0.runtime.lock().map_err(|_| "storageError")?;
        runtime.next_try = Instant::now();
        if !enabled {
            runtime.pending = None;
        }
        cloud.record_issue(None);
        cloud.info()
    })
    .await
}

#[tauri::command]
pub(crate) async fn cloud_backup_now(
    cloud: State<'_, Cloud>,
    vault: State<'_, VaultState>,
) -> Result<Info> {
    let cloud = cloud.inner().clone();
    let vault = vault.inner().clone();
    run(move || {
        cloud.backup(&vault, true)?;
        cloud.info()
    })
    .await
}

#[tauri::command]
pub(crate) async fn cloud_list(cloud: State<'_, Cloud>) -> Result<Vec<Snapshot>> {
    let cloud = cloud.inner().clone();
    run(move || cloud.snapshots()).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncResult { imported: usize, info: Info }

#[tauri::command]
pub(crate) async fn cloud_sync(
    cloud: State<'_, Cloud>, vault: State<'_, VaultState>, app: AppHandle,
    id: Option<Uuid>, password: Option<String>,
    progress: tauri::ipc::Channel<SyncStage>,
) -> Result<SyncResult> {
    let cloud = cloud.inner().clone();
    let vault = vault.inner().clone();
    let password = password.map(Zeroizing::new);
    run(move || {
        let result = cloud.sync(&vault, id, password.as_ref().map(|value| value.as_str()), &|stage| { let _ = progress.send(stage); });
        if let Err(ref cause) = result { cloud.record_issue(Some(cause.clone())); }
        let _ = app.emit("cloud-backup-changed", ());
        Ok(SyncResult { imported: result?, info: cloud.info()? })
    }).await
}

#[tauri::command]
pub(crate) async fn cloud_restore(
    cloud: State<'_, Cloud>,
    vault: State<'_, VaultState>,
    id: Uuid,
    password: String,
) -> Result<()> {
    let cloud = cloud.inner().clone();
    let vault = vault.inner().clone();
    let password = Zeroizing::new(password);
    run(move || {
        let _operation = cloud.0.operation.try_lock().map_err(|_| "cloudBusy")?;
        if vault.0.lock().map_err(|_| "storageError")?.status()?.exists {
            return Err("vaultExists".into());
        }
        let file = cloud.download(id)?;
        vault
            .0
            .lock()
            .map_err(|_| "storageError")?
            .restore_cloud_snapshot(file.path(), &password)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pending() -> Pending {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join("snapshot"), [7; 64]).unwrap();
        Pending { id: Uuid::new_v4(), directory, revision: 1, size: 64 }
    }

    fn upload_server(status: u16, delay: Duration) -> (Url, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = Url::parse(&format!("http://{}/upload", listener.local_addr().unwrap())).unwrap();
        let thread = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(3);
            let (mut stream, _) = loop {
                match listener.accept() {
                    Ok(connection) => break connection,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock && Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
                    _ => return,
                }
            };
            stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
            let mut request = Vec::new(); let mut buffer = [0; 4096];
            loop {
                let read = stream.read(&mut buffer).unwrap();
                if read == 0 { break; }
                request.extend_from_slice(&buffer[..read]);
                if let Some(end) = request.windows(4).position(|part| part == b"\r\n\r\n") {
                    if request.len() >= end + 4 + 64 { break; }
                }
            }
            thread::sleep(delay);
            let _ = write!(stream, "HTTP/1.1 {status} Test\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        });
        (url, thread)
    }

    #[test]
    fn failed_uploads_are_reported_instead_of_ignored() {
        let client = client().unwrap();
        for (status, expected) in [(201, Ok(())), (403, Err("cloudUploadFailed".into())), (500, Err("cloudUploadFailed".into())), (409, Ok(()))] {
            let (url, server) = upload_server(status, Duration::ZERO);
            assert_eq!(put_snapshot(&client, url, &pending(), Instant::now() + Duration::from_secs(2)), expected);
            server.join().unwrap();
        }
    }

    #[test]
    fn an_unresponsive_upload_stops_at_the_request_deadline() {
        let client = client().unwrap();
        let (url, server) = upload_server(201, Duration::from_millis(500));
        let started = Instant::now();
        assert_eq!(put_snapshot(&client, url, &pending(), started + Duration::from_millis(150)).unwrap_err(), "cloudTimeout");
        assert!(started.elapsed() < Duration::from_secs(2));
        assert_eq!(remaining(Instant::now() - Duration::from_secs(1), API_TIMEOUT).unwrap_err(), "cloudTimeout");
        server.join().unwrap();
    }

    #[test]
    fn password_retries_reuse_the_intact_encrypted_download() {
        let directory = tempfile::tempdir().unwrap();
        let cloud = Cloud::open(directory.path().join("cloud.device"));
        let mut original = crate::vault::Vault::open(directory.path().join("original.db")).unwrap();
        original.create("fictional original cloud password").unwrap();
        let file = NamedTempFile::new_in(directory.path()).unwrap();
        fs::remove_file(file.path()).unwrap();
        original.cloud_snapshot(file.path()).unwrap();
        let encrypted = fs::read(file.path()).unwrap();
        let id = Uuid::new_v4();
        cloud.0.runtime.lock().unwrap().downloaded = Some(CachedDownload { id, file, expires: Instant::now() + DOWNLOAD_CACHE_TTL });
        let mut local = crate::vault::Vault::open(directory.path().join("local.db")).unwrap();
        local.create("fictional local cloud password").unwrap();
        for (password, expected) in [(None, Err("cloudBackupPasswordRequired".into())), (Some("wrong password"), Err("invalidPassword".into())), (Some("fictional original cloud password"), Ok(0))] {
            // No account/token exists. A network request here would fail.
            let attempt = cloud.cached_snapshot(id, Instant::now() + API_TIMEOUT).unwrap();
            assert_eq!(local.merge_cloud_snapshot(attempt.path(), password), expected);
            assert_eq!(fs::read(cloud.0.runtime.lock().unwrap().downloaded.as_ref().unwrap().file.path()).unwrap(), encrypted);
        }
    }

    #[test]
    fn sync_retries_keep_the_existing_upload_reservation() {
        let directory = tempfile::tempdir().unwrap();
        let cloud = Cloud::open(directory.path().join("cloud.device"));
        let mut local = crate::vault::Vault::open(directory.path().join("local.db")).unwrap();
        local.create("fictional local upload password").unwrap();
        let mut upload = pending();
        upload.revision = local.cloud_revision().unwrap();
        let id = upload.id;
        cloud.0.runtime.lock().unwrap().pending = Some(upload);
        let vault = VaultState(Arc::new(Mutex::new(local)));
        // A failed connection must leave the retry's ID and encrypted file intact.
        assert_eq!(cloud.sync(&vault, None, None, &|_| {}).unwrap_err(), "cloudSignInRequired");
        assert_eq!(cloud.0.runtime.lock().unwrap().pending.as_ref().unwrap().id, id);
    }

    #[test]
    #[ignore = "Read-only diagnosis of the connected account; run explicitly"]
    fn live_read_only_connection() {
        let path = PathBuf::from(std::env::var_os("APPDATA").expect("Windows app data")).join("com.parag.nook").join("cloud-backup.device");
        let cloud = Cloud::open(path);
        let started = Instant::now();
        let snapshots = cloud.snapshots().expect("List connected account backups");
        println!("List: {:?}; backup count: {}", started.elapsed(), snapshots.len());
        if let Some(snapshot) = snapshots.first() {
            let started = Instant::now();
            let file = cloud.download(snapshot.id).expect("Download latest encrypted backup");
            println!("Encrypted download: {:?}; bytes: {}", started.elapsed(), file.as_file().metadata().unwrap().len());
        }
    }
}
