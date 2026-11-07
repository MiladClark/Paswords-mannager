mod browser;
mod device_protection;
mod memory;
mod reset;
mod host_security;
mod backups;
mod cloud;
mod updates;
mod vault;
pub use browser::transport::native_host;

use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, Manager, State};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;
use vault::{Entry, EntryView, ListQuery, Page, Status, Vault};
use zeroize::Zeroizing;

#[derive(Clone)]
struct VaultState(Arc<Mutex<Vault>>);
#[derive(Clone)]
struct BrowserIntegration(Arc<Mutex<browser::BrowserState>>);

fn extension_directory(app: &tauri::AppHandle) -> vault::Result<std::path::PathBuf> {
    Ok(app.path().app_data_dir().map_err(|_| "storageError")?.join("browser").join("extension"))
}
#[tauri::command]
async fn prepare_browser_extension(app: tauri::AppHandle, browser: String) -> vault::Result<serde_json::Value> {
    let selected = browser::setup::Browser::parse(&browser)?;
    let directory = extension_directory(&app)?;
    let host_directory = directory.parent().ok_or("storageError")?.to_path_buf();
    let executable = std::env::current_exe().map_err(|_| "browserUnavailable")?;
    tauri::async_runtime::spawn_blocking(move || {
        let selected_exe = selected.executable();
        if let Some(url) = selected.store_url() {
            if let Some(selected_exe) = &selected_exe {
                browser::transport::register(&executable, &host_directory)?;
                std::process::Command::new(selected_exe)
                    .arg(url)
                    .spawn()
                    .map_err(|_| "browserUnavailable")?;
            }
            return Ok(serde_json::json!({
                "store": true,
                "browserInstalled": selected_exe.is_some(),
                "preview": false,
            }));
        }
        browser::setup::extract(&directory)?;
        browser::transport::register(&executable, &host_directory)?;
        Ok(serde_json::json!({"directory":directory,"browserInstalled":selected_exe.is_some(),"preview":false}))
    }).await.map_err(|_| "browserUnavailable")?
}
#[tauri::command]
fn open_extension_folder(app: tauri::AppHandle) -> vault::Result<()> {
    let directory = extension_directory(&app)?;
    if !directory.join("manifest.json").is_file() { return Err("browserUnavailable".into()); }
    app.opener().open_path(directory.to_string_lossy().to_string(), None::<&str>).map_err(|_| "browserUnavailable".into())
}
#[tauri::command]
fn copy_extension_setup_value(app: tauri::AppHandle, browser: String, which: String) -> vault::Result<()> {
    let selected = browser::setup::Browser::parse(&browser)?;
    let value = match which.as_str() {
        "page" => selected.page().to_owned(),
        "directory" => extension_directory(&app)?.to_string_lossy().to_string(),
        _ => return Err("invalidEntry".into()),
    };
    app.clipboard().write_text(value).map_err(|_| "clipboardError".into())
}

#[tauri::command]
async fn browser_connections(
    app: tauri::AppHandle,
    state: State<'_, VaultState>,
    integration: State<'_, BrowserIntegration>,
) -> vault::Result<serde_json::Value> {
    access(state, |v| {
        if v.status()?.unlocked {
            Ok(())
        } else {
            Err("locked".into())
        }
    })
    .await?;
    let b = integration.0.lock().map_err(|_| "storageError")?;
    let manifest = app
        .path()
        .app_data_dir()
        .map_err(|_| "storageError")?
        .join("browser")
        .join(format!("{}.json", browser::HOST));
    Ok(
        serde_json::json!({"connections":b.connections(),"installed":manifest.exists(),"available":!b.error}),
    )
}
#[tauri::command]
async fn install_browser_bridge(
    app: tauri::AppHandle,
    state: State<'_, VaultState>,
) -> vault::Result<()> {
    access(state, |v| v.touch()).await?;
    let exe = std::env::current_exe().map_err(|_| "browserUnavailable")?;
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|_| "storageError")?
        .join("browser");
    tauri::async_runtime::spawn_blocking(move || browser::transport::register(&exe, &directory))
        .await
        .map_err(|_| "browserUnavailable")?
}
#[tauri::command]
async fn begin_browser_pairing(
    state: State<'_, VaultState>,
    integration: State<'_, BrowserIntegration>,
) -> vault::Result<serde_json::Value> {
    access(state, |v| v.touch()).await?;
    integration
        .0
        .lock()
        .map_err(|_| "storageError")?
        .begin_pairing()
}
#[tauri::command]
async fn revoke_browser(
    state: State<'_, VaultState>,
    integration: State<'_, BrowserIntegration>,
    id: String,
) -> vault::Result<()> {
    access(state, |v| v.touch()).await?;
    integration
        .0
        .lock()
        .map_err(|_| "storageError")?
        .revoke(&id)
}
#[tauri::command]
fn pending_browser_fill(
    integration: State<'_, BrowserIntegration>,
) -> vault::Result<Option<browser::FillRequest>> {
    Ok(integration.0.lock().map_err(|_| "storageError")?.pending())
}
#[tauri::command]
async fn decide_browser_fill(
    state: State<'_, VaultState>,
    integration: State<'_, BrowserIntegration>,
    id: String,
    allow: bool,
    secret: String,
) -> vault::Result<()> {
    let secret = Zeroizing::new(secret);
    let shared = integration.0.clone();
    access(state, move |v| {
        shared
            .lock()
            .map_err(|_| "storageError")?
            .decide(v, &id, allow, &secret)
    })
    .await
}
#[tauri::command]
fn pending_browser_save(integration: State<'_, BrowserIntegration>) -> vault::Result<Option<browser::SaveRequest>> {
    Ok(integration.0.lock().map_err(|_| "storageError")?.pending_save())
}
#[tauri::command]
async fn decide_browser_save(state: State<'_, VaultState>, integration: State<'_, BrowserIntegration>, decision: browser::SaveDecision) -> vault::Result<Option<String>> {
    let shared = integration.0.clone();
    access(state, move |v| shared.lock().map_err(|_| "storageError")?.decide_save(v, &decision)).await
}
struct ClipboardLease {
    expires: u64,
    text: Zeroizing<String>,
}
#[derive(Default)]
struct ClipboardState {
    lease: Mutex<Option<ClipboardLease>>,
}

fn write_clipboard(_app: &tauri::AppHandle, text: &str) -> vault::Result<()> {
    #[cfg(windows)]
    {
        use arboard::SetExtWindows;
        arboard::Clipboard::new()
            .map_err(|_| "clipboardError")?
            .set()
            .exclude_from_monitoring()
            .text(text)
            .map_err(|_| "clipboardError".into())
    }
    #[cfg(not(windows))]
    {
        _app.clipboard()
            .write_text(text.to_owned())
            .map_err(|_| "clipboardError".into())
    }
}

fn clear_clipboard(app: &tauri::AppHandle, expired_only: bool) {
    let state = app.state::<ClipboardState>();
    if let Ok(mut lease) = state.lease.lock() {
        let Some(owned) = lease.as_mut() else {
            return;
        };
        if !expired_only {
            owned.expires = 0;
        }
        if vault::now() < owned.expires {
            return;
        }
        // If another process temporarily owns the clipboard, retry on the next tick.
        let Ok(text) = app.clipboard().read_text() else {
            return;
        };
        let text = Zeroizing::new(text);
        if *text != *owned.text || write_clipboard(app, "").is_ok() {
            *lease = None;
        }
    }
}
async fn access<T: Send + 'static>(
    state: State<'_, VaultState>,
    f: impl FnOnce(&mut Vault) -> vault::Result<T> + Send + 'static,
) -> vault::Result<T> {
    access_shared(state.0.clone(), f).await
}
async fn access_shared<T: Send + 'static>(
    shared: Arc<Mutex<Vault>>,
    f: impl FnOnce(&mut Vault) -> vault::Result<T> + Send + 'static,
) -> vault::Result<T> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut vault = shared.lock().map_err(|_| "storageError")?;
        f(&mut vault)
    })
    .await
    .map_err(|_| "storageError".to_string())?
}
#[tauri::command]
async fn vault_status(state: State<'_, VaultState>) -> vault::Result<Status> {
    access(state, |v| v.status()).await
}
#[tauri::command]
async fn automatic_backup_info(state: State<'_, VaultState>) -> vault::Result<backups::Info> {
    access(state, |v| { v.touch()?; Ok(v.automatic_backup_info()) }).await
}
#[tauri::command]
async fn configure_automatic_backups(state: State<'_, VaultState>, enabled: bool) -> vault::Result<backups::Info> {
    access(state, move |v| v.configure_automatic_backups(enabled)).await
}
#[tauri::command]
async fn create_vault(state: State<'_, VaultState>, password: String) -> vault::Result<()> {
    let password = Zeroizing::new(password);
    access(state, move |v| v.create(&password)).await
}
#[tauri::command]
async fn unlock_vault(state: State<'_, VaultState>, password: String) -> vault::Result<()> {
    let password = Zeroizing::new(password);
    access(state, move |v| v.unlock(&password)).await
}
#[tauri::command]
async fn lock_vault(app: tauri::AppHandle, state: State<'_, VaultState>) -> vault::Result<()> {
    access(state, |v| {
        v.lock();
        Ok(())
    })
    .await?;
    app.state::<BrowserIntegration>()
        .0
        .lock()
        .map_err(|_| "storageError")?
        .clear_transient();
    clear_clipboard(&app, false);
    app.emit("vault-locked", ())
        .map_err(|_| "storageError".to_string())?;
    Ok(())
}
#[tauri::command]
async fn touch_session(state: State<'_, VaultState>) -> vault::Result<()> {
    access(state, |v| v.touch()).await
}
#[tauri::command]
async fn list_entries(state: State<'_, VaultState>, query: ListQuery) -> vault::Result<Page> {
    access(state, move |v| v.list(query)).await
}
#[tauri::command]
async fn get_entry(state: State<'_, VaultState>, id: String) -> vault::Result<EntryView> {
    access(state, move |v| v.view_entry(&id)).await
}
#[tauri::command]
async fn save_entry(state: State<'_, VaultState>, entry: Entry) -> vault::Result<EntryView> {
    access(state, move |v| v.save_from_ui(entry)).await
}
#[tauri::command]
async fn set_favorite(
    state: State<'_, VaultState>,
    id: String,
    favorite: bool,
) -> vault::Result<EntryView> {
    access(state, move |v| v.set_favorite(&id, favorite)).await
}
#[tauri::command]
async fn authorize_entry(
    state: State<'_, VaultState>,
    id: String,
    secret: String,
) -> vault::Result<EntryView> {
    let secret = Zeroizing::new(secret);
    access(state, move |v| v.authorize_entry(&id, &secret)).await
}
#[tauri::command]
async fn delete_entry(
    state: State<'_, VaultState>,
    id: String,
    master: Option<String>,
    skip_confirmation: bool,
) -> vault::Result<bool> {
    let master = master.map(Zeroizing::new);
    access(state, move |v| {
        v.delete_forever(&id, master.as_ref().map(|value| value.as_str()), skip_confirmation)
    }).await
}
#[tauri::command]
async fn change_master(
    state: State<'_, VaultState>,
    current: String,
    password: String,
) -> vault::Result<()> {
    let current = Zeroizing::new(current);
    let password = Zeroizing::new(password);
    access(state, move |v| v.change_password(&current, &password)).await
}
#[tauri::command]
async fn generate_password(
    state: State<'_, VaultState>,
    length: usize,
    symbols: bool,
) -> vault::Result<String> {
    access(state, move |v| {
        v.touch()?;
        vault::generate_password(length, symbols)
    })
    .await
}
#[tauri::command]
async fn copy_field(
    app: tauri::AppHandle,
    state: State<'_, VaultState>,
    id: String,
    field: String,
) -> vault::Result<()> {
    let shared = state.0.clone();
    let protected_id = id.clone();
    let sensitive = !matches!(field.as_str(), "username" | "url");
    let text = access(state, move |v| {
        let entry = if sensitive {
            v.sensitive_entry(&id)?
        } else {
            v.get(&id)?
        };
        let text = match field.as_str() {
            "username" => entry.username.clone(),
            "password" => entry.password.clone(),
            "url" => entry.url.clone(),
            _ => {
                let (kind, index) = field.split_once(':').ok_or("invalidEntry")?;
                let index: usize = index.parse().map_err(|_| "invalidEntry")?;
                match kind {
                    "extra" => entry.fields.get(index).ok_or("invalidEntry")?.value.clone(),
                    "history" => entry.history.get(index).ok_or("invalidEntry")?.clone(),
                    _ => return Err("invalidEntry".into()),
                }
            }
        };
        Ok(Zeroizing::new(text))
    })
    .await?;
    // Serialize the final authorization check and write with vault locking.
    let mut vault = shared.lock().map_err(|_| "storageError")?;
    vault.touch()?;
    if sensitive {
        vault.require_item_access(&protected_id)?;
    }
    let clipboard = app.state::<ClipboardState>();
    let mut lease = clipboard.lease.lock().map_err(|_| "clipboardError")?;
    write_clipboard(&app, &text)?;
    *lease = Some(ClipboardLease {
        expires: vault::now() + 30,
        text,
    });
    drop(lease);
    drop(vault);
    Ok(())
}
#[tauri::command]
async fn open_website(
    app: tauri::AppHandle,
    state: State<'_, VaultState>,
    id: String,
) -> vault::Result<()> {
    let url = access(state, move |v| Ok(v.get(&id)?.url.clone())).await?;
    let parsed = url::Url::parse(&url).map_err(|_| "invalidUrl")?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err("invalidUrl".into());
    }
    app.opener()
        .open_url(parsed.as_str(), None::<&str>)
        .map_err(|_| "openError".into())
}
#[tauri::command]
async fn export_backup(
    app: tauri::AppHandle,
    state: State<'_, VaultState>,
    language: String,
) -> vault::Result<bool> {
    let shared = state.0.clone();
    access(state, |v| v.touch()).await?;
    let file = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title(if language == "fa" {
                "ذخیرهٔ بکاپ رمز‌شدهٔ پس‌وارد"
            } else {
                "Save encrypted PassWards backup"
            })
            .add_filter("PassWards encrypted vault", &["passward", "nook"])
            .set_file_name("PassWards-backup.passward")
            .blocking_save_file()
    })
    .await
    .map_err(|_| "storageError")?;
    let Some(file) = file else {
        return Ok(false);
    };
    let path = file.into_path().map_err(|_| "storageError")?;
    access_shared(shared, move |v| {
        v.backup(&path)?;
        Ok(true)
    })
    .await
}
#[tauri::command]
async fn import_backup(
    app: tauri::AppHandle,
    state: State<'_, VaultState>,
    password: String,
    language: String,
) -> vault::Result<Option<usize>> {
    let shared = state.0.clone();
    let password = Zeroizing::new(password);
    access(state, |v| v.touch()).await?;
    let file = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title(if language == "fa" {
                "وارد کردن بکاپ رمز‌شدهٔ پس‌وارد"
            } else {
                "Import encrypted PassWards backup"
            })
            .add_filter("PassWards encrypted vault", &["passward", "nook"])
            .blocking_pick_file()
    })
    .await
    .map_err(|_| "storageError")?;
    let Some(file) = file else {
        return Ok(None);
    };
    let path = file.into_path().map_err(|_| "storageError")?;
    access_shared(shared, move |v| v.import_backup(&path, &password).map(Some)).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(updates::UpdaterState::default())
        .manage(ClipboardState::default())
        .setup(|app| {
            let path = app.path().app_data_dir()?.join("vault.sqlite3");
            let vault = Vault::open(path).map_err(std::io::Error::other)?;
            let state = VaultState(Arc::new(Mutex::new(vault)));
            app.manage(state.clone());
            let cloud = cloud::Cloud::open(app.path().app_data_dir()?.join("cloud-backup.device"));
            app.manage(cloud.clone());
            cloud.start_worker(state.clone(), app.handle().clone());
            let integration = BrowserIntegration(Arc::new(Mutex::new(
                browser::BrowserState::open(app.path().app_data_dir()?.join("browsers.device")),
            )));
            app.manage(integration.clone());
            #[cfg(windows)]
            {
                let handle = app.handle().clone();
                let shared = state.0.clone();
                let bridge = integration.0.clone();
                let window = app.get_webview_window("main").ok_or_else(|| std::io::Error::other("main window unavailable"))?;
                host_security::install(&window, Arc::new(move || {
                    if let Ok(mut vault) = shared.lock() { vault.lock(); }
                    if let Ok(mut browser) = bridge.lock() { browser.clear_transient(); }
                    clear_clipboard(&handle, false);
                    let _ = handle.emit("vault-locked", ());
                })).map_err(std::io::Error::other)?;
            }
            #[cfg(windows)]
            {
                let handle = app.handle().clone();
                let shared = state.0.clone();
                let browser_state = integration.0.clone();
                let handler: browser::transport::Handler = Arc::new(move |caller, request| {
                    let focus = matches!(request.op.as_str(), "focus" | "requestFill" | "requestSave");
                    let result = {
                        let mut vault = shared.lock().map_err(|_| "storageError")?;
                        let mut bridge = browser_state.lock().map_err(|_| "storageError")?;
                        bridge.handle(&mut vault, caller, request)
                    };
                    // status()/touch() may expire the vault before the idle worker
                    // observes it. Always clear the webview and clipboard then.
                    if result.as_ref().is_err_and(|error| error == "locked") {
                        clear_clipboard(&handle, false);
                        let _ = handle.emit("vault-locked", ());
                    }
                    if focus
                        && result.is_ok()
                        && let Some(w) = handle.get_webview_window("main")
                    {
                        let _ = w.unminimize();
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                    result
                });
                let bridge_state = integration.0.clone();
                tauri::async_runtime::spawn(async move {
                    let result = match browser::transport::endpoint() {
                        Ok(name) => browser::transport::serve_at(name, handler).await,
                        Err(e) => Err(e),
                    };
                    if result.is_err()
                        && let Ok(mut b) = bridge_state.lock()
                    {
                        b.error = true;
                    }
                });
            }
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                loop {
                    std::thread::sleep(Duration::from_secs(1));
                    let minimized = handle
                        .get_webview_window("main")
                        .and_then(|w| w.is_minimized().ok())
                        .unwrap_or(false);
                    let expired = state
                        .0
                        .lock()
                        .map(|mut v| {
                            let locked = if minimized { v.lock() } else { v.expire() };
                            // Backups never touch the idle clock or keep a vault open.
                            let _ = v.automatic_backup_tick(false);
                            locked
                        })
                        .unwrap_or(false);
                    if expired {
                        if let Ok(mut b) = integration.0.lock() {
                            b.clear_transient();
                        }
                        clear_clipboard(&handle, false);
                        let _ = handle.emit("vault-locked", ());
                    }
                    if let Ok(mut bridge) = integration.0.lock() { bridge.expire_requests(); }
                    clear_clipboard(&handle, true);
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            vault_status,
            automatic_backup_info,
            configure_automatic_backups,
            cloud::cloud_info,
            cloud::cloud_connect,
            cloud::reset_local,
            cloud::cloud_enable,
            cloud::cloud_backup_now,
            cloud::cloud_list,
            cloud::cloud_restore,
            updates::update_check,
            updates::update_download,
            updates::update_cancel,
            updates::update_install,
            updates::update_open_downloads,
            create_vault,
            unlock_vault,
            lock_vault,
            touch_session,
            list_entries,
            get_entry,
            save_entry,
            delete_entry,
            change_master,
            generate_password,
            copy_field,
            open_website,
            export_backup,
            import_backup,
            set_favorite,
            authorize_entry,
            browser_connections,
            install_browser_bridge,
            prepare_browser_extension,
            open_extension_folder,
            copy_extension_setup_value,
            begin_browser_pairing,
            revoke_browser,
            pending_browser_fill,
            decide_browser_fill,
            pending_browser_save,
            decide_browser_save
        ])
        .build(tauri::generate_context!())
        .expect("Could not start PassWards");
    app.run(|handle, event| {
        if matches!(
            event,
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
        ) {
            if let Some(state) = handle.try_state::<VaultState>()
                && let Ok(mut v) = state.0.lock()
            {
                v.lock();
            }
            clear_clipboard(handle, false);
        }
    });
}
