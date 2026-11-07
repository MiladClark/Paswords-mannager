fn main() {
    println!("cargo:rerun-if-env-changed=PASSWARDS_UPDATE_PUBKEY");
    println!("cargo:rerun-if-env-changed=PASSWARDS_INSTALLER_BUILD");
    tauri_build::build()
}
