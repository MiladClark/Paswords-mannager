pub mod transport;

use crate::{
    pin,
    vault::{self, Result, Vault},
};
use rand::{Rng, RngCore, rngs::OsRng};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::PathBuf};
use subtle::ConstantTimeEq;
use zeroize::Zeroizing;

pub const HOST: &str = "com.passward.bridge";
pub const MAX_MESSAGE: usize = 64 * 1024;
pub fn extension_origin() -> String {
    let identity: Value =
        serde_json::from_str(include_str!("../../../browser-extension/identity.json"))
            .expect("extension identity");
    format!(
        "chrome-extension://{}/",
        identity["id"].as_str().expect("extension id")
    )
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    fn message(op: &str, token: Option<&str>, extra: Value) -> Request {
        let mut data =
            json!({"v":1,"requestId":uuid::Uuid::new_v4().to_string(),"op":op,"token":token});
        for (k, v) in extra.as_object().unwrap() {
            data[k] = v.clone();
        }
        serde_json::from_value(data).unwrap()
    }
    fn entry(url: &str) -> crate::vault::Entry {
        serde_json::from_value(json!({"id":"","title":"Fixture","username":"fictional@example.test","password":"Fictional-secret-only!","url":url,"notes":"","folder":"","tags":[],"favorite":false,"deleted":false,"createdAt":0,"updatedAt":0,"fields":[],"history":[]})).unwrap()
    }
    #[test]
    fn browser_pairing_origin_grants_replay_and_revocation() {
        let temp = tempfile::tempdir().unwrap();
        let mut vault = Vault::open(temp.path().join("vault")).unwrap();
        vault.create("A fictional browser test master").unwrap();
        let a = vault.save(entry("https://example.test/login")).unwrap();
        vault.save(entry("https://example.test.evil.test")).unwrap();
        vault.save(entry("http://example.test")).unwrap();
        let mut bridge = BrowserState::open(temp.path().join("browsers"));
        let caller = extension_origin();
        assert!(
            bridge
                .handle(
                    &mut vault,
                    "chrome-extension://wrong/",
                    message("focus", None, json!({}))
                )
                .is_err()
        );
        assert!(
            bridge
                .handle(
                    &mut vault,
                    &caller,
                    message("matches", None, json!({"origin":"https://example.test"}))
                )
                .is_err()
        );
        let code = bridge.begin_pairing().unwrap()["code"]
            .as_str()
            .unwrap()
            .to_string();
        let paired = bridge
            .handle(
                &mut vault,
                &caller,
                message("pair", None, json!({"code":code,"browser":"Chrome"})),
            )
            .unwrap();
        let token = paired["token"].as_str().unwrap();
        assert!(
            bridge
                .handle(
                    &mut vault,
                    &caller,
                    message("pair", None, json!({"code":code,"browser":"Chrome"}))
                )
                .is_err()
        );
        let accounts = bridge
            .handle(
                &mut vault,
                &caller,
                message(
                    "matches",
                    Some(token),
                    json!({"origin":"https://example.test:443/path"}),
                ),
            )
            .unwrap();
        assert_eq!(accounts["accounts"].as_array().unwrap().len(), 1);
        assert!(!accounts.to_string().contains("Fictional-secret"));
        assert!(
            bridge
                .handle(
                    &mut vault,
                    &caller,
                    message(
                        "requestFill",
                        Some(token),
                        json!({"id":a.id,"origin":"https://other.test"})
                    )
                )
                .is_err()
        );
        let id = bridge
            .handle(
                &mut vault,
                &caller,
                message(
                    "requestFill",
                    Some(token),
                    json!({"id":a.id,"origin":"https://example.test"}),
                ),
            )
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_string();
        assert_eq!(
            bridge
                .handle(
                    &mut vault,
                    &caller,
                    message("takeFill", Some(token), json!({"id":id}))
                )
                .unwrap()["pending"],
            true
        );
        assert!(
            bridge
                .decide(&mut vault, &id, true, "wrong password", "master")
                .is_err()
        );
        bridge
            .decide(
                &mut vault,
                &id,
                true,
                "A fictional browser test master",
                "master",
            )
            .unwrap();
        let data = bridge
            .handle(
                &mut vault,
                &caller,
                message("takeFill", Some(token), json!({"id":id})),
            )
            .unwrap();
        assert_eq!(data["password"], "Fictional-secret-only!");
        assert!(
            bridge
                .handle(
                    &mut vault,
                    &caller,
                    message("takeFill", Some(token), json!({"id":id}))
                )
                .is_err()
        );
        let request = message(
            "matches",
            Some(token),
            json!({"origin":"https://example.test"}),
        );
        let duplicate:Request=serde_json::from_value(json!({"v":1,"requestId":request.request_id,"op":"matches","token":token,"origin":"https://example.test"})).unwrap();
        bridge.handle(&mut vault, &caller, request).unwrap();
        assert!(bridge.handle(&mut vault, &caller, duplicate).is_err());
        let reopened = BrowserState::open(temp.path().join("browsers"));
        assert_eq!(reopened.connections.len(), 1);
        let raw = std::fs::read(temp.path().join("browsers")).unwrap();
        assert!(!raw.windows(token.len()).any(|b| b == token.as_bytes()));
        vault.lock();
        assert!(
            bridge
                .handle(
                    &mut vault,
                    &caller,
                    message(
                        "matches",
                        Some(token),
                        json!({"origin":"https://example.test"})
                    )
                )
                .is_err()
        );
        vault.unlock("A fictional browser test master").unwrap();
        let connection = bridge.connections[0].id.clone();
        bridge.revoke(&connection).unwrap();
        assert!(
            bridge
                .handle(
                    &mut vault,
                    &caller,
                    message(
                        "matches",
                        Some(token),
                        json!({"origin":"https://example.test"})
                    )
                )
                .is_err()
        );
    }
    #[test]
    fn pairing_attempts_expiry_and_transport_bounds() {
        let temp = tempfile::tempdir().unwrap();
        let mut vault = Vault::open(temp.path().join("vault")).unwrap();
        vault.create("Another fictional test master").unwrap();
        let mut bridge = BrowserState::open(temp.path().join("browsers"));
        let code = bridge.begin_pairing().unwrap()["code"]
            .as_str()
            .unwrap()
            .to_string();
        for _ in 0..10 {
            assert!(
                bridge
                    .handle(
                        &mut vault,
                        &extension_origin(),
                        message("pair", None, json!({"code":"invalid","browser":"Edge"}))
                    )
                    .is_err()
            );
        }
        assert!(
            bridge
                .handle(
                    &mut vault,
                    &extension_origin(),
                    message("pair", None, json!({"code":code,"browser":"Edge"}))
                )
                .is_err()
        );
        bridge.begin_pairing().unwrap();
        bridge.pairing.as_mut().unwrap().expires = 0;
        assert!(
            bridge
                .handle(
                    &mut vault,
                    &extension_origin(),
                    message("pair", None, json!({"code":"000000","browser":"Edge"}))
                )
                .is_err()
        );
        let mut bytes = Vec::new();
        transport::write_native(&mut bytes, b"{\"value\":\"hello\"}").unwrap();
        assert_eq!(
            transport::read_native(&mut bytes.as_slice()).unwrap(),
            b"{\"value\":\"hello\"}"
        );
        assert!(transport::read_native(&mut [255u8; 4].as_slice()).is_err());
        assert!(transport::read_native(&mut [0u8; 4].as_slice()).is_err());
        assert!(canonical_origin("https://user:password@example.test").is_err());
        assert!(canonical_origin("file:///tmp").is_err());
    }
}
pub fn canonical_origin(input: &str) -> Result<String> {
    if input.len() > 4096 {
        return Err("invalidUrl".into());
    }
    let url = url::Url::parse(input).map_err(|_| "invalidUrl")?;
    if !matches!(url.scheme(), "https" | "http")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("invalidUrl".into());
    }
    Ok(url.origin().ascii_serialization())
}
fn random_token() -> Result<String> {
    let mut raw = [0u8; 32];
    OsRng.try_fill_bytes(&mut raw).map_err(|_| "randomError")?;
    Ok(raw.iter().map(|v| format!("{v:02x}")).collect())
}
fn digest(value: &str) -> Vec<u8> {
    Sha256::digest(value.as_bytes()).to_vec()
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub title: String,
    pub username: String,
}
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub id: String,
    pub name: String,
    pub created_at: u64,
    #[serde(skip_serializing)]
    pub token_hash: Vec<u8>,
}
// Separate disk shape: token hashes must be persisted, but never returned to the webview.
#[derive(Serialize, Deserialize)]
struct SavedConnection {
    id: String,
    name: String,
    created_at: u64,
    token_hash: Vec<u8>,
}
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FillRequest {
    pub id: String,
    pub origin: String,
    pub title: String,
    pub username: String,
    pub expires_at: u64,
}
struct Pending {
    info: FillRequest,
    client: String,
    entry: String,
    decision: Option<bool>,
}
struct Pairing {
    code: String,
    expires: u64,
    failures: u8,
}
#[derive(Default)]
pub struct BrowserState {
    path: Option<PathBuf>,
    connections: Vec<Connection>,
    pairing: Option<Pairing>,
    pending: Option<Pending>,
    seen: BTreeMap<String, u64>,
    pub error: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Request {
    pub v: u8,
    pub request_id: String,
    pub op: String,
    pub token: Option<String>,
    pub origin: Option<String>,
    pub id: Option<String>,
    pub code: Option<String>,
    pub browser: Option<String>,
}
impl BrowserState {
    pub fn open(path: PathBuf) -> Self {
        let mut state = Self {
            path: Some(path.clone()),
            ..Self::default()
        };
        if path.exists() {
            let data = std::fs::read(path)
                .ok()
                .filter(|b| b.len() <= MAX_MESSAGE)
                .and_then(|b| pin::platform_unprotect(&b).ok())
                .and_then(|b| serde_json::from_slice::<Vec<SavedConnection>>(&b).ok());
            if let Some(saved) =
                data.filter(|v| v.len() <= 16 && v.iter().all(|c| c.token_hash.len() == 32))
            {
                state.connections = saved
                    .into_iter()
                    .map(|c| Connection {
                        id: c.id,
                        name: c.name,
                        created_at: c.created_at,
                        token_hash: c.token_hash,
                    })
                    .collect();
            } else {
                state.error = true;
            }
        }
        state
    }
    fn persist(&self) -> Result<()> {
        let path = self.path.as_ref().ok_or("browserUnavailable")?;
        let saved: Vec<_> = self
            .connections
            .iter()
            .map(|c| SavedConnection {
                id: c.id.clone(),
                name: c.name.clone(),
                created_at: c.created_at,
                token_hash: c.token_hash.clone(),
            })
            .collect();
        let plain = Zeroizing::new(serde_json::to_vec(&saved).map_err(|_| "storageError")?);
        let protected = pin::platform_protect(&plain)?;
        let temp = path.with_file_name(format!(".browser-{}.tmp", uuid::Uuid::new_v4()));
        let result = (|| {
            use std::io::Write;
            let mut f = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temp)
                .map_err(|_| "storageError")?;
            f.write_all(&protected).map_err(|_| "storageError")?;
            f.sync_all().map_err(|_| "storageError")?;
            drop(f);
            std::fs::rename(&temp, path).map_err(|_| "storageError")?;
            Ok(())
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(temp);
        }
        result
    }
    pub fn connections(&self) -> Vec<Connection> {
        self.connections.clone()
    }
    pub fn begin_pairing(&mut self) -> Result<Value> {
        if self.error || self.connections.len() >= 16 {
            return Err("browserUnavailable".into());
        }
        let code = format!("{:06}", OsRng.gen_range(0..1_000_000u32));
        let expires = vault::now() + 120;
        self.pairing = Some(Pairing {
            code: code.clone(),
            expires,
            failures: 0,
        });
        Ok(json!({"code":code,"expiresAt":expires}))
    }
    pub fn revoke(&mut self, id: &str) -> Result<()> {
        let before = self.connections.clone();
        self.connections.retain(|c| c.id != id);
        if let Err(e) = self.persist() {
            self.connections = before;
            return Err(e);
        }
        if self.pending.as_ref().is_some_and(|p| p.client == id) {
            self.pending = None;
        }
        Ok(())
    }
    pub fn clear_transient(&mut self) {
        self.pending = None;
        self.pairing = None;
    }
    pub fn pending(&mut self) -> Option<FillRequest> {
        if self
            .pending
            .as_ref()
            .is_some_and(|p| p.info.expires_at <= vault::now())
        {
            self.pending = None;
        }
        self.pending
            .as_ref()
            .filter(|p| p.decision.is_none())
            .map(|p| p.info.clone())
    }
    pub fn decide(
        &mut self,
        vault: &mut Vault,
        id: &str,
        allow: bool,
        secret: &str,
        method: &str,
    ) -> Result<()> {
        let p = self
            .pending
            .as_mut()
            .filter(|p| p.info.id == id && p.info.expires_at > vault::now() && p.decision.is_none())
            .ok_or("browserExpired")?;
        if allow {
            vault.authorize_entry(&p.entry, secret, method)?;
        }
        p.decision = Some(allow);
        Ok(())
    }
    pub fn handle(&mut self, vault: &mut Vault, caller: &str, r: Request) -> Result<Value> {
        if caller != extension_origin() || r.v != 1 || uuid::Uuid::parse_str(&r.request_id).is_err()
        {
            return Err("browserDenied".into());
        }
        let now = vault::now();
        self.seen.retain(|_, until| *until > now);
        if self.seen.len() >= 4096 || self.seen.insert(r.request_id.clone(), now + 120).is_some() {
            return Err("browserDenied".into());
        }
        if r.op == "pair" {
            vault.touch()?;
            let pairing = self
                .pairing
                .as_mut()
                .filter(|p| p.expires > now && p.failures < 10)
                .ok_or("browserPairExpired")?;
            pairing.failures += 1;
            if !bool::from(
                pairing
                    .code
                    .as_bytes()
                    .ct_eq(r.code.as_deref().unwrap_or("").as_bytes()),
            ) {
                return Err("browserPairCode".into());
            }
            let name = match r.browser.as_deref() {
                Some("Chrome") => "Chrome",
                Some("Edge") => "Edge",
                _ => return Err("browserDenied".into()),
            };
            let token = Zeroizing::new(random_token()?);
            self.connections.push(Connection {
                id: uuid::Uuid::new_v4().to_string(),
                name: name.into(),
                created_at: now,
                token_hash: digest(&token),
            });
            if let Err(e) = self.persist() {
                self.connections.pop();
                return Err(e);
            }
            self.pairing = None;
            return Ok(json!({"token":*token}));
        }
        // Focusing the local app is safe before pairing and returns no vault data.
        if r.op == "focus" {
            return Ok(json!({"focused":true}));
        }
        let token = r
            .token
            .as_deref()
            .filter(|s| s.len() == 64)
            .ok_or("browserUnpaired")?;
        let hash = digest(token);
        let client = self
            .connections
            .iter()
            .find(|c| bool::from(c.token_hash.ct_eq(&hash)))
            .ok_or("browserUnpaired")?
            .id
            .clone();
        if r.op == "focus" {
            return Ok(json!({"focused":true}));
        }
        let status = vault.status()?;
        if !status.unlocked {
            self.clear_transient();
            return Err("locked".into());
        }
        match r.op.as_str() {
            "status" => Ok(json!({"unlocked":true})),
            "matches" => {
                let origin = canonical_origin(r.origin.as_deref().ok_or("invalidUrl")?)?;
                Ok(json!({"accounts":vault.browser_matches(&origin)?}))
            }
            "requestFill" => {
                if self
                    .pending
                    .as_ref()
                    .is_some_and(|p| p.info.expires_at > now)
                {
                    return Err("browserBusy".into());
                }
                let origin = canonical_origin(r.origin.as_deref().ok_or("invalidUrl")?)?;
                let entry = r.id.as_deref().ok_or("notFound")?;
                let account = vault
                    .browser_matches(&origin)?
                    .into_iter()
                    .find(|c| c.id == entry)
                    .ok_or("browserOrigin")?;
                let id = uuid::Uuid::new_v4().to_string();
                self.pending = Some(Pending {
                    info: FillRequest {
                        id: id.clone(),
                        origin,
                        title: account.title,
                        username: account.username,
                        expires_at: now + 90,
                    },
                    client,
                    entry: entry.into(),
                    decision: None,
                });
                Ok(json!({"id":id}))
            }
            "takeFill" => {
                let p = self
                    .pending
                    .as_ref()
                    .filter(|p| {
                        p.client == client
                            && Some(p.info.id.as_str()) == r.id.as_deref()
                            && p.info.expires_at > now
                    })
                    .ok_or("browserExpired")?;
                if p.decision.is_none() {
                    return Ok(json!({"pending":true}));
                }
                let p = self.pending.take().ok_or("browserExpired")?;
                if p.decision != Some(true) {
                    return Err("browserDenied".into());
                }
                let e = vault.sensitive_entry(&p.entry)?;
                if e.deleted || canonical_origin(&e.url)? != p.info.origin {
                    return Err("browserOrigin".into());
                }
                Ok(json!({"username":e.username,"password":e.password,"origin":p.info.origin}))
            }
            "cancelFill" => {
                if self.pending.as_ref().is_some_and(|p| {
                    p.client == client && Some(p.info.id.as_str()) == r.id.as_deref()
                }) {
                    self.pending = None;
                }
                Ok(json!({}))
            }
            _ => Err("browserDenied".into()),
        }
    }
}
