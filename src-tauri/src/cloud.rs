use std::{
    fs::{self, File},
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    sync::{Arc, Mutex},
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

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Config {
    token: Zeroizing<String>,
    email: String,
    enabled: bool,
    last_backup: Option<u64>,
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
}

impl Default for Runtime {
    fn default() -> Self {
        Self {
            last_revision: None,
            pending: None,
            next_try: Instant::now(),
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
            let result = upload(&config.token, pending);
            match result {
                Ok(()) => {
                    runtime.last_revision = Some(pending.revision);
                    runtime.pending = None;
                    runtime.next_try = Instant::now() + INTERVAL;
                    config.last_backup = Some(now());
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

    pub(crate) fn start_worker(self, vault: VaultState, app: AppHandle) {
        thread::spawn(move || {
            loop {
                thread::sleep(Duration::from_secs(5));
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
    client_with_timeout(Duration::from_secs(180))
}

fn client_with_timeout(timeout: Duration) -> Result<Client> {
    Client::builder()
        .connect_timeout(Duration::from_secs(12))
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "cloudUnavailable".into())
}

fn revoke_session(token: &str) {
    if !token.is_empty()
        && let Ok(client) = client_with_timeout(Duration::from_secs(5))
    {
        let _: Result<Value> = api(
            &client,
            "/api/passwards/backup",
            token,
            json!({ "action": "disconnect" }),
        );
    }
}

fn api<T: DeserializeOwned>(
    client: &Client,
    endpoint: &str,
    token: &str,
    body: Value,
) -> Result<T> {
    let url = base_url()?.join(endpoint).map_err(|_| "cloudUnavailable")?;
    let mut request = client.post(url).json(&body);
    if !token.is_empty() {
        request = request.bearer_auth(token);
    }
    decode(request.send().map_err(|_| "cloudNetwork")?)
}

fn decode<T: DeserializeOwned>(response: Response) -> Result<T> {
    let status = response.status();
    let mut data = Zeroizing::new(Vec::new());
    response
        .take(32_768)
        .read_to_end(&mut data)
        .map_err(|_| "cloudNetwork")?;
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

fn upload(token: &str, pending: &Pending) -> Result<()> {
    #[derive(Deserialize)]
    struct Start {
        url: Option<String>,
        ready: Option<bool>,
    }
    let client = client()?;
    let start: Start = api(
        &client,
        "/api/passwards/backup",
        token,
        json!({
            "action": "start", "id": pending.id, "size": pending.size,
        }),
    )?;
    if start.ready == Some(true) {
        return Ok(());
    }
    let url = signed_url(&start.url.ok_or("cloudUnavailable")?, true)?;
    let file = File::open(pending.path()).map_err(|_| "storageError")?;
    let _sent = client
        .put(url)
        .header("content-type", OCTETS)
        .header("x-content-type", OCTETS)
        .body(Body::sized(file, pending.size))
        .send();
    // A retry may get an upload conflict after a successful earlier transfer.
    let _: Value = api(
        &client,
        "/api/passwards/backup",
        token,
        json!({ "action": "complete", "id": pending.id }),
    )?;
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
    confirmation: String,
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
            vault.reset_local(&confirmation, &master, |directory| {
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
    #[derive(Deserialize)]
    struct List {
        snapshots: Vec<Snapshot>,
    }
    let cloud = cloud.inner().clone();
    run(move || {
        let config = cloud.connected()?;
        let list: List = api(
            &client()?,
            "/api/passwards/backup",
            &config.token,
            json!({ "action": "list" }),
        )?;
        Ok(list.snapshots)
    })
    .await
}

#[tauri::command]
pub(crate) async fn cloud_restore(
    cloud: State<'_, Cloud>,
    vault: State<'_, VaultState>,
    id: Uuid,
    password: String,
) -> Result<()> {
    #[derive(Deserialize)]
    struct Download {
        url: String,
        size: u64,
    }
    let cloud = cloud.inner().clone();
    let vault = vault.inner().clone();
    let password = Zeroizing::new(password);
    run(move || {
        let _operation = cloud.0.operation.try_lock().map_err(|_| "cloudBusy")?;
        if vault.0.lock().map_err(|_| "storageError")?.status()?.exists {
            return Err("vaultExists".into());
        }
        let config = cloud.connected()?;
        let client = client()?;
        let download: Download = api(
            &client,
            "/api/passwards/backup",
            &config.token,
            json!({ "action": "download", "id": id }),
        )?;
        if !(512..=MAX_SIZE).contains(&download.size) {
            return Err("backupValidationFailed".into());
        }
        let response = client
            .get(signed_url(&download.url, false)?)
            .send()
            .map_err(|_| "cloudNetwork")?;
        if !response.status().is_success() {
            return Err("cloudMissing".into());
        }
        let mut response = response.take(download.size + 1);
        let mut file = NamedTempFile::new_in(cloud.directory()?).map_err(|_| "storageError")?;
        let bytes = std::io::copy(&mut response, &mut file).map_err(|_| "cloudNetwork")?;
        if bytes != download.size {
            return Err("backupValidationFailed".into());
        }
        vault
            .0
            .lock()
            .map_err(|_| "storageError")?
            .restore_cloud_snapshot(file.path(), &password)
    })
    .await
}
