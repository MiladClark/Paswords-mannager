// Test-only executable: never bundled, registered as com.passward.fixture only.
#![allow(dead_code)]
#[path = "../src/browser/mod.rs"]
mod browser;
#[path = "../src/device_protection.rs"]
mod device_protection;
#[path = "../src/memory.rs"]
mod memory;
#[path = "../src/backups.rs"]
mod backups;
#[path = "../src/vault.rs"]
mod vault;
use serde_json::{Value, json};
use browser::SaveDecision;
use std::{
    io::{BufRead, Write},
    sync::{Arc, Mutex},
};
const MASTER: &str = "Fictional integration test master";
fn main() {
    if std::env::args().nth(1).as_deref() == Some("--endpoint") {
        println!("{}", browser::transport::endpoint().unwrap());
        return;
    }
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let name = std::env::var("PASSWARD_FIXTURE_PIPE").expect("test pipe");
    if let Some(caller) = std::env::args()
        .nth(1)
        .filter(|s| s.starts_with("chrome-extension://"))
    {
        if caller != browser::extension_origin() {
            return;
        }
        let mut input = std::io::stdin().lock();
        let mut output = std::io::stdout().lock();
        while let Ok(bytes) = browser::transport::read_native(&mut input) {
            let value: Value = serde_json::from_slice(&bytes).unwrap();
            let data = runtime
                .block_on(browser::transport::exchange_at(&name, &caller, value))
                .unwrap_or_else(|_| {
                    zeroize::Zeroizing::new(br#"{"ok":false,"error":"browserOffline"}"#.to_vec())
                });
            if browser::transport::write_native(&mut output, &data).is_err() {
                break;
            }
        }
        return;
    }
    let directory = std::path::PathBuf::from(std::env::args().nth(1).expect("fixture directory"));
    let site = std::env::args().nth(2).expect("fixture origin");
    std::fs::create_dir_all(&directory).unwrap();
    let mut vault = vault::Vault::open(directory.join("vault.sqlite3")).unwrap();
    vault.create(MASTER).unwrap();
    let entry:vault::Entry=serde_json::from_value(json!({"id":"","title":"Fictional login","username":"fixture@example.test","password":"Fictional-Autofill-Secret-7294!","url":format!("{site}/login"),"notes":"","folder":"","tags":[],"favorite":false,"deleted":false,"createdAt":0,"updatedAt":0,"fields":[],"history":[]})).unwrap();
    let entry = vault.save(entry).unwrap();
    let mut bridge = browser::BrowserState::open(directory.join("browser.device"));
    let pairing = bridge.begin_pairing().unwrap();
    let state = Arc::new(Mutex::new((vault, bridge)));
    let server_state = state.clone();
    let handler: browser::transport::Handler = Arc::new(move |caller, request| {
        let mut state = server_state.lock().unwrap();
        let (vault, bridge) = &mut *state;
        bridge.handle(vault, caller, request)
    });
    let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(1);
    let started = ready_tx.clone();
    let server = std::thread::spawn(move || {
        let result = runtime.block_on(browser::transport::serve_at_ready(
            name,
            handler,
            move || {
                let _ = started.send(Ok(()));
            },
        ));
        if let Err(e) = result {
            let _ = ready_tx.send(Err(e));
        }
    });
    ready_rx
        .recv()
        .unwrap()
        .expect("exclusive test pipe ownership");
    println!(
        "{}",
        json!({"ready":true,"code":pairing["code"],"entry":entry.id})
    );
    std::io::stdout().flush().unwrap();
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else {
            break;
        };
        let command: Value = serde_json::from_str(&line).unwrap();
        let mut state = state.lock().unwrap();
        let (vault, bridge) = &mut *state;
        let result = match command["op"].as_str().unwrap_or("") {
            "pending" => json!({"pending":bridge.pending()}),
            "pendingSave" => json!({"pending":bridge.pending_save()}),
            "approveSave" | "denySave" => {
                let p = bridge.pending_save().expect("pending save");
                let target = p.accounts.first().map(|a| a.id.as_str()).unwrap_or("");
                let id = bridge.decide_save(vault, &SaveDecision { id: p.id.to_string(), allow: command["op"] == "approveSave", secret: (MASTER).to_string(), target: (target).to_string(), username: p.username.to_string(), title: p.title.to_string() }).unwrap();
                json!({"done":true,"id":id})
            }
            "savedAccounts" => {
                let accounts = vault.browser_matches(&site).unwrap();
                let items: Vec<_> = accounts.iter().map(|a| {
                    let e = vault.get(&a.id).unwrap();
                    json!({"id":e.id,"username":e.username,"password":e.password,"history":e.history,"favicon":e.favicon})
                }).collect();
                json!({"items":items})
            }
            "approve" | "deny" => {
                let p = bridge.pending().expect("pending request");
                bridge
                    .decide(vault, &p.id, command["op"] == "approve", MASTER)
                    .unwrap();
                json!({"done":true})
            }
            "lock" => {
                vault.lock();
                bridge.clear_transient();
                json!({"done":true})
            }
            "unlock" => {
                vault.unlock(MASTER).unwrap();
                json!({"done":true})
            }
            "pair" => bridge.begin_pairing().unwrap(),
            "revoke" => {
                for c in bridge.connections() {
                    bridge.revoke(&c.id).unwrap();
                }
                json!({"done":true})
            }
            "stop" => break,
            _ => json!({"error":"unknown command"}),
        };
        println!("{result}");
        std::io::stdout().flush().unwrap();
    }
    drop(server);
}
