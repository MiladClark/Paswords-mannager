use crate::vault::Result;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};

const KEEP: usize = 7;
const INTERVAL: u64 = 15 * 60;
#[derive(Serialize, Deserialize, Default)]
struct Config {
    enabled: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    pub enabled: bool,
    pub last_created: u64,
    pub retained: usize,
}
pub struct Backups {
    pub enabled: bool,
    pub dirty: bool,
    directory: PathBuf,
    config: PathBuf,
    last_created: u64,
    next_attempt: u64,
}
impl Backups {
    pub fn open(vault: &Path) -> Self {
        let parent = vault.parent().unwrap_or(Path::new("."));
        let config = parent.join("automatic-backups.json");
        let enabled = fs::metadata(&config)
            .ok()
            .filter(|m| m.len() <= 4096)
            .and_then(|_| fs::read(&config).ok())
            .and_then(|b| serde_json::from_slice::<Config>(&b).ok())
            .is_some_and(|c| c.enabled);
        let mut value = Self {
            enabled,
            dirty: true,
            directory: parent.join("automatic-backups"),
            config,
            last_created: 0,
            next_attempt: 0,
        };
        value.last_created = value.files().last().map(|(time, _)| *time).unwrap_or(0);
        value
    }
    fn files(&self) -> Vec<(u64, PathBuf)> {
        let mut files = Vec::new();
        if let Ok(entries) = fs::read_dir(&self.directory) {
            for entry in entries.flatten() {
                if !entry.file_type().is_ok_and(|t| t.is_file()) {
                    continue;
                }
                let name = entry.file_name();
                let name = name.to_string_lossy();
                let Some(name) = name
                    .strip_prefix("passwards-")
                    .and_then(|s| s.strip_suffix(".passward"))
                else {
                    continue;
                };
                let Some((time, id)) = name.split_once('-') else {
                    continue;
                };
                if let (Ok(time), Ok(_)) = (time.parse::<u64>(), uuid::Uuid::parse_str(id)) {
                    files.push((time, entry.path()));
                }
            }
        }
        files.sort_by_key(|(_, p)| {
            fs::metadata(p)
                .and_then(|m| m.modified())
                .unwrap_or(std::time::UNIX_EPOCH)
        });
        files
    }
    pub fn info(&self) -> Info {
        Info {
            enabled: self.enabled,
            last_created: self.last_created,
            retained: self.files().len(),
        }
    }
    pub fn configure(&mut self, enabled: bool) -> Result<()> {
        let temporary = self
            .config
            .with_file_name(format!(".backup-settings-{}.tmp", uuid::Uuid::new_v4()));
        let bytes = serde_json::to_vec(&Config { enabled }).map_err(|_| "storageError")?;
        fs::write(&temporary, bytes).map_err(|_| "storageError")?;
        let result = fs::rename(&temporary, &self.config).map_err(|_| "storageError");
        if result.is_err() {
            let _ = fs::remove_file(temporary);
        }
        result?;
        self.enabled = enabled;
        self.next_attempt = 0;
        Ok(())
    }
    pub fn due(&self, now: u64) -> bool {
        self.enabled
            && self.dirty
            && now >= self.next_attempt
            && now.saturating_sub(self.last_created) >= INTERVAL
    }
    pub fn begin(&mut self, now: u64) -> Result<PathBuf> {
        self.next_attempt = now.saturating_add(60);
        fs::create_dir_all(&self.directory).map_err(|_| "storageError")?;
        Ok(self
            .directory
            .join(format!("passwards-{now}-{}.passward", uuid::Uuid::new_v4())))
    }
    pub fn finish(&mut self, now: u64) {
        self.last_created = now;
        self.dirty = false;
        let files = self.files();
        // Only app-generated, regular files in this fixed directory are pruned.
        for (_, path) in files.iter().take(files.len().saturating_sub(KEEP)) {
            let _ = fs::remove_file(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn backup_retention_is_opt_in_and_never_removes_unrelated_files() {
        let temp = tempfile::tempdir().unwrap();
        let mut backups = Backups::open(&temp.path().join("vault.db"));
        assert!(!backups.due(2000));
        backups.configure(true).unwrap();
        assert!(backups.due(2000));
        for time in 2000..2010 {
            let file = backups.begin(time).unwrap();
            fs::write(file, b"fixture").unwrap();
            backups.finish(time);
        }
        let unrelated = backups.directory.join("my-backup.passward");
        fs::write(&unrelated, b"keep").unwrap();
        backups.finish(2011);
        assert!(unrelated.exists());
        assert_eq!(backups.info().retained, 7);
        assert!(!backups.due(4000));
        backups.dirty = true;
        assert!(backups.due(4000));
        assert!(Backups::open(&temp.path().join("vault.db")).enabled);
    }
}
