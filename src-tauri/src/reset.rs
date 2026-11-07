use crate::vault::Result;
use std::{
    fs,
    path::{Path, PathBuf},
};

fn is_redirect(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0 // FILE_ATTRIBUTE_REPARSE_POINT
    }
    #[cfg(not(windows))]
    metadata.file_type().is_symlink()
}

pub(crate) fn checked_directory(path: &Path) -> Result<PathBuf> {
    let invalid = "resetCleanupFailed";
    let metadata = fs::symlink_metadata(path).map_err(|_| invalid)?;
    if !path.is_absolute() || !metadata.is_dir() || is_redirect(&metadata) {
        return Err(invalid.into());
    }
    let parent = path
        .parent()
        .ok_or(invalid)?
        .canonicalize()
        .map_err(|_| invalid)?;
    let resolved = path.canonicalize().map_err(|_| invalid)?;
    if resolved != parent.join(path.file_name().ok_or(invalid)?) {
        return Err(invalid.into());
    }
    Ok(resolved)
}

pub(crate) fn purge_auxiliary(directory: &Path) -> Result<()> {
    let directory = checked_directory(directory)?;
    let failed = "resetCleanupFailed";
    for entry in fs::read_dir(&directory).map_err(|_| failed)? {
        let entry = entry.map_err(|_| failed)?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let owned = matches!(
            name,
            "automatic-backups"
                | "automatic-backups.json"
                | "browser"
                | "browsers.device"
                | "cloud-backup.device"
                | "vault.device-pin"
        ) || [".backup-settings-", ".browser-", ".pin-"]
            .iter()
            .any(|prefix| {
                name.strip_prefix(prefix)
                    .and_then(|s| s.strip_suffix(".tmp"))
                    .is_some_and(|s| uuid::Uuid::parse_str(s).is_ok())
            })
            || name.strip_prefix(".tmp").is_some_and(|suffix| {
                suffix.len() == 6 && suffix.bytes().all(|c| c.is_ascii_alphanumeric())
            });
        if !owned {
            continue;
        }

        let path = directory.join(entry.file_name());
        let metadata = fs::symlink_metadata(&path).map_err(|_| failed)?;
        if is_redirect(&metadata) {
            // Delete only the link or junction. Never delete its target.
            #[cfg(windows)]
            if metadata.is_dir()
                || std::os::windows::fs::FileTypeExt::is_symlink_dir(&metadata.file_type())
            {
                fs::remove_dir(&path).map_err(|_| failed)?;
                continue;
            }
            fs::remove_file(&path).map_err(|_| failed)?;
        } else if metadata.is_dir() {
            // remove_dir_all does not follow symlinks within the verified directory.
            if path.canonicalize().map_err(|_| failed)? != path {
                return Err(failed.into());
            }
            fs::remove_dir_all(&path).map_err(|_| failed)?;
        } else {
            fs::remove_file(&path).map_err(|_| failed)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::{Entry, Vault};

    #[test]
    fn reset_requires_master_then_clears_persisted_vault_and_local_files() {
        let test = tempfile::tempdir().unwrap();
        let directory = test.path().join("passwards");
        let path = directory.join("vault.sqlite3");
        let master = "The original test master password";
        let mut vault = Vault::open(path.clone()).unwrap();
        vault.create(master).unwrap();
        let entry = vault
            .save_from_ui(Entry {
                id: String::new(),
                title: "Private fixture".into(),
                username: String::new(),
                password: "Fixture credential".into(),
                url: String::new(),
                favicon: String::new(),
                notes: String::new(),
                folder: String::new(),
                tags: vec![],
                favorite: false,
                created_at: 0,
                updated_at: 0,
                fields: vec![],
                history: vec![],
            })
            .unwrap();
        vault.configure_automatic_backups(true).unwrap();
        for name in ["automatic-backups", "browser", ".tmpa2C4e6"] {
            let folder = directory.join(name);
            fs::create_dir_all(&folder).unwrap();
            fs::write(folder.join("data"), b"local test data").unwrap();
        }
        for name in ["browsers.device", "cloud-backup.device", "vault.device-pin"] {
            fs::write(directory.join(name), b"local test data").unwrap();
        }
        let exported = test.path().join("exported.passward");
        fs::write(&exported, b"keep external export").unwrap();

        assert_eq!(
            vault
                .reset_local("incorrect master", purge_auxiliary)
                .unwrap_err(),
            "invalidPassword"
        );
        assert!(vault.status().unwrap().unlocked);
        assert!(directory.join("cloud-backup.device").exists());
        assert_eq!(
            vault
                .reset_local(master, |_| Err("resetCleanupFailed".into()))
                .unwrap_err(),
            "resetCleanupFailed"
        );
        assert!(vault.status().unwrap().exists);
        assert!(vault.view_entry(&entry.entry.id).is_ok());

        vault
            .reset_local(master, purge_auxiliary)
            .unwrap();
        assert!(!vault.status().unwrap().exists);
        assert!(!vault.status().unwrap().unlocked);
        assert!(!vault.automatic_backup_info().enabled);
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
        assert_eq!(fs::read(exported).unwrap(), b"keep external export");
        drop(vault);

        let mut fresh = Vault::open(path).unwrap();
        assert!(!fresh.status().unwrap().exists);
        assert!(fresh.unlock(master).is_err());
        fresh.create("A different test master password").unwrap();
        assert!(fresh.view_entry(&entry.entry.id).is_err());
    }
}
