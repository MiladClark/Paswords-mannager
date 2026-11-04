mod browser;
mod pin;
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
    method: String,
) -> vault::Result<()> {
    let secret = Zeroizing::new(secret);
    let shared = integration.0.clone();
    access(state, move |v| {
        shared
            .lock()
            .map_err(|_| "storageError")?
            .decide(v, &id, allow, &secret, &method)
    })
    .await
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
async fn unlock_with_pin(state: State<'_, VaultState>, pin: String) -> vault::Result<()> {
    let pin = Zeroizing::new(pin);
    access(state, move |v| v.unlock_pin(&pin)).await
}
#[tauri::command]
async fn lock_entry(state: State<'_, VaultState>, id: String) -> vault::Result<EntryView> {
    access(state, move |v| v.lock_entry(&id)).await
}
#[tauri::command]
async fn configure_pin(
    state: State<'_, VaultState>,
    master: String,
    pin: String,
) -> vault::Result<pin::PinInfo> {
    let master = Zeroizing::new(master);
    let pin = Zeroizing::new(pin);
    access(state, move |v| v.configure_pin(&master, &pin)).await
}
#[tauri::command]
async fn remove_pin(state: State<'_, VaultState>, master: String) -> vault::Result<()> {
    let master = Zeroizing::new(master);
    access(state, move |v| v.remove_pin(&master)).await
}
#[tauri::command]
async fn authorize_entry(
    state: State<'_, VaultState>,
    id: String,
    secret: String,
    method: String,
) -> vault::Result<EntryView> {
    let secret = Zeroizing::new(secret);
    access(state, move |v| v.authorize_entry(&id, &secret, &method)).await
}
#[tauri::command]
async fn trash_entry(state: State<'_, VaultState>, id: String, deleted: bool) -> vault::Result<()> {
    access(state, move |v| v.set_deleted(&id, deleted)).await
}
#[tauri::command]
async fn delete_entry(state: State<'_, VaultState>, id: String) -> vault::Result<()> {
    access(state, move |v| v.delete_forever(&id)).await
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
                "Save encrypted Passward backup"
            })
            .add_filter("Passward encrypted vault", &["passward", "nook"])
            .set_file_name("Passward-backup.passward")
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
                "Import encrypted Passward backup"
            })
            .add_filter("Passward encrypted vault", &["passward", "nook"])
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
        .manage(ClipboardState::default())
        .setup(|app| {
            let path = app.path().app_data_dir()?.join("vault.sqlite3");
            let vault = Vault::open(path).map_err(std::io::Error::other)?;
            let state = VaultState(Arc::new(Mutex::new(vault)));
            app.manage(state.clone());
            let integration = BrowserIntegration(Arc::new(Mutex::new(
                browser::BrowserState::open(app.path().app_data_dir()?.join("browsers.device")),
            )));
            app.manage(integration.clone());
            #[cfg(windows)]
            {
                let handle = app.handle().clone();
                let shared = state.0.clone();
                let browser_state = integration.0.clone();
                let handler: browser::transport::Handler = Arc::new(move |caller, request| {
                    let focus = matches!(request.op.as_str(), "focus" | "requestFill");
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
                        .map(|mut v| if minimized { v.lock() } else { v.expire() })
                        .unwrap_or(false);
                    if expired {
                        if let Ok(mut b) = integration.0.lock() {
                            b.clear_transient();
                        }
                        clear_clipboard(&handle, false);
                        let _ = handle.emit("vault-locked", ());
                    }
                    clear_clipboard(&handle, true);
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            vault_status,
            create_vault,
            unlock_vault,
            lock_vault,
            touch_session,
            list_entries,
            get_entry,
            save_entry,
            trash_entry,
            delete_entry,
            change_master,
            generate_password,
            copy_field,
            open_website,
            export_backup,
            import_backup,
            set_favorite,
            unlock_with_pin,
            configure_pin,
            remove_pin,
            authorize_entry,
            lock_entry,
            browser_connections,
            install_browser_bridge,
            begin_browser_pairing,
            revoke_browser,
            pending_browser_fill,
            decide_browser_fill
        ])
        .build(tauri::generate_context!())
        .expect("Could not start Passward");
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
