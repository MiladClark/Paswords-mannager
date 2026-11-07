use std::{sync::Mutex, time::Duration};

use serde::Serialize;
use tauri::{AppHandle, State, ipc::Channel};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::oneshot;

const FEED: &str = "https://devtune.app/api/updates/passwards";
const DOWNLOADS: &str = "https://devtune.app/download/passwards";
const REPO_RELEASES: &str = "https://github.com/MiladClark/Paswords-mannager/releases/download";
const PUBLIC_KEY: Option<&str> = option_env!("PASSWARDS_UPDATE_PUBKEY");
const INSTALLER_BUILD: Option<&str> = option_env!("PASSWARDS_INSTALLER_BUILD");

#[derive(Default)]
pub(crate) struct UpdaterState(Mutex<Pending>);

#[derive(Default)]
struct Pending {
    update: Option<Update>,
    verified: Option<Vec<u8>>,
    download: Option<Download>,
    installing: bool,
}

struct Download {
    cancel: Option<oneshot::Sender<()>>,
}

#[derive(Serialize)]
pub(crate) struct Availability {
    version: Option<String>,
    mode: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Progress {
    received: u64,
    total: Option<u64>,
    verifying: bool,
}

fn installed() -> bool {
    cfg!(all(windows, target_arch = "x86_64")) && INSTALLER_BUILD == Some("1")
}

#[tauri::command]
pub(crate) async fn update_check(
    app: AppHandle,
    state: State<'_, UpdaterState>,
) -> Result<Availability, &'static str> {
    let Some(key) =
        PUBLIC_KEY.filter(|key| !key.is_empty() && cfg!(all(windows, target_arch = "x86_64")))
    else {
        return Ok(Availability {
            version: None,
            mode: "manual",
        });
    };
    let mut update = app
        .updater_builder()
        .pubkey(key)
        .endpoints(vec![FEED.parse().map_err(|_| "updateCheck")?])
        .and_then(|builder| builder.timeout(Duration::from_secs(15)).build())
        .map_err(|_| "updateCheck")?
        .check()
        .await
        .map_err(|_| "updateCheck")?;
    if let Some(update) = update.as_mut() {
        let version = &update.version;
        let expected =
            format!("{REPO_RELEASES}/v{version}/PassWards-{version}-windows-x64-setup.exe");
        if update.download_url.as_str() != expected || version.contains(['-', '+']) {
            return Err("updateCheck");
        }
        update.timeout = Some(Duration::from_secs(300));
    }
    let version = update.as_ref().map(|u| u.version.clone());
    let mut pending = state.0.lock().map_err(|_| "updateCheck")?;
    if !pending.installing
        && pending.download.is_none()
        && pending.update.as_ref().map(|u| &u.version) != update.as_ref().map(|u| &u.version)
    {
        pending.verified = None;
        pending.update = update;
    }
    Ok(Availability {
        version,
        mode: if installed() { "installed" } else { "portable" },
    })
}

#[tauri::command]
pub(crate) async fn update_download(
    state: State<'_, UpdaterState>,
    version: String,
    progress: Channel<Progress>,
) -> Result<bool, &'static str> {
    if !installed() {
        return Err("updateDownload");
    }
    let (update, cancelled) = {
        let mut pending = state.0.lock().map_err(|_| "updateDownload")?;
        if pending.download.is_some() || pending.installing {
            return Err("updateDownload");
        }
        let update = pending
            .update
            .clone()
            .filter(|u| u.version == version)
            .ok_or("updateDownload")?;
        let (cancel, cancelled) = oneshot::channel();
        pending.download = Some(Download {
            cancel: Some(cancel),
        });
        pending.verified = None;
        (update, cancelled)
    };
    let mut received = 0u64;
    let result = tokio::select! {
        biased;
        _ = cancelled => None,
        result = update.download(
            |len, total| {
                received += len as u64;
                let _ = progress.send(Progress { received, total, verifying: false });
            },
            || {
                let _ = progress.send(Progress { received: 0, total: None, verifying: true });
            },
        ) => Some(result),
    };
    let mut pending = state.0.lock().map_err(|_| "updateDownload")?;
    if pending.download.take().is_some_and(|d| d.cancel.is_none()) {
        return Ok(false);
    }
    match result {
        Some(Ok(bytes)) => {
            pending.verified = Some(bytes);
            Ok(true)
        }
        Some(Err(_)) => Err("updateDownload"),
        None => Ok(false),
    }
}

#[tauri::command]
pub(crate) fn update_cancel(
    state: State<'_, UpdaterState>,
    discard: bool,
) -> Result<(), &'static str> {
    let mut pending = state.0.lock().map_err(|_| "updateDownload")?;
    // Leave the in-flight slot occupied until its download future returns.
    if let Some(cancel) = pending.download.as_mut().and_then(|d| d.cancel.take()) {
        let _ = cancel.send(());
    }
    if discard {
        pending.verified = None;
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn update_install(
    app: AppHandle,
    state: State<'_, UpdaterState>,
    vault: State<'_, super::VaultState>,
) -> Result<(), &'static str> {
    if !installed() {
        return Err("updateInstall");
    }
    let (update, bytes) = {
        let mut pending = state.0.lock().map_err(|_| "updateInstall")?;
        if pending.download.is_some() || pending.installing {
            return Err("updateInstall");
        }
        let update = pending.update.clone().ok_or("updateInstall")?;
        let bytes = pending.verified.take().ok_or("updateInstall")?;
        pending.installing = true;
        (update, bytes)
    };
    // The Windows updater exits the process directly. Lock and clear sensitive
    // state before handing off to it, rather than relying on an exit event.
    let result = if super::lock_vault(app, vault).await.is_ok() {
        tauri::async_runtime::spawn_blocking(move || update.install(&bytes).is_ok()).await
    } else {
        Ok(false)
    };
    state.0.lock().map_err(|_| "updateInstall")?.installing = false;
    if result.is_ok_and(|installed| installed) {
        Ok(())
    } else {
        Err("updateInstall")
    }
}

#[tauri::command]
pub(crate) fn update_open_downloads(app: AppHandle) -> Result<(), &'static str> {
    app.opener()
        .open_url(DOWNLOADS, None::<&str>)
        .map_err(|_| "updateOpen")
}
