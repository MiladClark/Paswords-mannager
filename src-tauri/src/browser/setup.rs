//! Bundled, fixed-path extension resources. Does not modify browser profiles or policies.
use std::path::{Path, PathBuf};

pub enum Browser { Chrome, Edge }
impl Browser {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value { "chrome" => Ok(Self::Chrome), "edge" => Ok(Self::Edge), _ => Err("invalidEntry".into()) }
    }
    pub fn page(&self) -> &'static str {
        match self { Self::Chrome => "chrome://extensions", Self::Edge => "edge://extensions" }
    }
    pub fn installed(&self) -> bool {
        let relative = match self {
            Self::Chrome => "Google/Chrome/Application/chrome.exe",
            Self::Edge => "Microsoft/Edge/Application/msedge.exe",
        };
        ["PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"].iter()
            .filter_map(std::env::var_os).any(|root| PathBuf::from(root).join(relative).is_file())
    }
}

const FILES: &[(&str, &[u8])] = &[
    ("manifest.json", include_bytes!("../../../browser-extension/manifest.json")),
    ("capture.js", include_bytes!("../../../browser-extension/capture.js")),
    ("background.js", include_bytes!("../../../browser-extension/background.js")),
    ("content.js", include_bytes!("../../../browser-extension/content.js")),
    ("popup.js", include_bytes!("../../../browser-extension/popup.js")),
    ("popup.html", include_bytes!("../../../browser-extension/popup.html")),
    ("popup.css", include_bytes!("../../../browser-extension/popup.css")),
    ("icons/16.png", include_bytes!("../../../browser-extension/icons/16.png")),
    ("icons/32.png", include_bytes!("../../../browser-extension/icons/32.png")),
    ("icons/48.png", include_bytes!("../../../browser-extension/icons/48.png")),
    ("icons/128.png", include_bytes!("../../../browser-extension/icons/128.png")),
];

pub fn extract(directory: &Path) -> Result<(), String> {
    std::fs::create_dir_all(directory.join("icons")).map_err(|_| "storageError")?;
    for (name, bytes) in FILES {
        std::fs::write(directory.join(name), bytes).map_err(|_| "storageError")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn browser_input_is_allowlisted() {
        assert!(Browser::parse("chrome").is_ok());
        assert_eq!(Browser::parse("edge").unwrap_or_else(|_| panic!()).page(), "edge://extensions");
        assert!(Browser::parse("../../outside").is_err());
    }
    #[test]
    fn bundled_extension_has_all_runtime_resources() {
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let base = std::env::temp_dir();
        let directory = base.join(format!("passward-extension-resources-{}-{stamp}", std::process::id()));
        extract(&directory).unwrap();
        for (name, bytes) in FILES { assert_eq!(std::fs::read(directory.join(name)).unwrap(), *bytes); }
        let manifest = std::fs::read_to_string(directory.join("manifest.json")).unwrap();
        assert!(manifest.contains("nativeMessaging"));
        assert!(manifest.contains("background.js"));
        assert!(directory.starts_with(&base) && directory.file_name().unwrap().to_string_lossy().starts_with("passward-extension-resources-"));
        std::fs::remove_dir_all(&directory).unwrap();
    }
}
