use super::{Account, Request, canonical_origin, digest};
use crate::vault::{self, Entry, Result, Vault};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SaveRequest {
    pub id: String,
    pub origin: String,
    pub title: String,
    pub username: String,
    pub kind: String,
    pub accounts: Vec<Account>,
    pub expires_at: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    const MASTER: &str = "Fictional browser save master";
    fn request(op: &str, username: &str, password: &str) -> Request {
        serde_json::from_value(json!({"v":1,"requestId":uuid::Uuid::new_v4().to_string(),"op":op,"origin":"https://example.test","username":username,"password":password})).unwrap()
    }
    fn setup() -> (tempfile::TempDir, Vault, SaveState) {
        let dir = tempfile::tempdir().unwrap();
        let mut vault = Vault::open(dir.path().join("vault")).unwrap();
        vault.create(MASTER).unwrap();
        (dir, vault, SaveState::default())
    }
    #[test]
    fn saves_need_master_approval_and_results_are_client_bound_and_one_use() {
        let (_dir, mut vault, mut state) = setup();
        let r = request("requestSave", "fictional-user", "Fictional-save-secret!");
        state.handle(&mut vault, "client", &r).unwrap();
        let info = state.pending().unwrap();
        assert!(
            !serde_json::to_string(&info)
                .unwrap()
                .contains("Fictional-save-secret!")
        );
        assert!(vault.browser_matches(&info.origin).unwrap().is_empty());
        assert!(
            state
                .decide(
                    &mut vault,
                    &SaveDecision {
                        id: info.id.to_string(),
                        allow: true,
                        secret: ("wrong master").to_string(),
                        target: ("").to_string(),
                        username: info.username.to_string(),
                        title: info.title.to_string()
                    }
                )
                .is_err()
        );
        assert!(vault.browser_matches(&info.origin).unwrap().is_empty());
        let id = state
            .decide(
                &mut vault,
                &SaveDecision {
                    id: info.id.to_string(),
                    allow: true,
                    secret: (MASTER).to_string(),
                    target: ("").to_string(),
                    username: info.username.to_string(),
                    title: info.title.to_string(),
                },
            )
            .unwrap()
            .unwrap();
        assert_eq!(vault.get(&id).unwrap().password, "Fictional-save-secret!");
        let mut take = request("takeSave", "", "");
        take.id = Some(info.id);
        assert!(state.handle(&mut vault, "other-client", &take).is_err());
        assert_eq!(
            state.handle(&mut vault, "client", &take).unwrap()["outcome"],
            "saved"
        );
        assert!(state.handle(&mut vault, "client", &take).is_err());
        let same = state
            .handle(
                &mut vault,
                "client",
                &request("checkLogin", "fictional-user", "Fictional-save-secret!"),
            )
            .unwrap();
        assert_eq!(same["kind"], "unchanged");
    }
    #[test]
    fn updates_preserve_metadata_and_history_and_reject_stale_or_wrong_targets() {
        let (_dir, mut vault, mut state) = setup();
        state
            .handle(
                &mut vault,
                "client",
                &request("requestSave", "user", "Original-fictional-secret!"),
            )
            .unwrap();
        let p = state.pending().unwrap();
        let id = state
            .decide(
                &mut vault,
                &SaveDecision {
                    id: p.id.to_string(),
                    allow: true,
                    secret: (MASTER).to_string(),
                    target: ("").to_string(),
                    username: ("user").to_string(),
                    title: ("My account").to_string(),
                },
            )
            .unwrap()
            .unwrap();
        state.clear();
        let mut entry = vault.get(&id).unwrap();
        entry.notes = "Keep these notes".into();
        entry.favorite = true;
        entry.folder = "Work".into();
        vault.save(entry).unwrap();
        state
            .handle(
                &mut vault,
                "client",
                &request("requestSave", "user", "Updated-fictional-secret!"),
            )
            .unwrap();
        let p = state.pending().unwrap();
        assert_eq!(p.kind, "update");
        assert!(
            state
                .decide(
                    &mut vault,
                    &SaveDecision {
                        id: p.id.to_string(),
                        allow: true,
                        secret: (MASTER).to_string(),
                        target: ("wrong-id").to_string(),
                        username: ("user").to_string(),
                        title: ("ignored").to_string()
                    }
                )
                .is_err()
        );
        state
            .decide(
                &mut vault,
                &SaveDecision {
                    id: p.id.to_string(),
                    allow: true,
                    secret: (MASTER).to_string(),
                    target: id.to_string(),
                    username: ("user").to_string(),
                    title: ("ignored").to_string(),
                },
            )
            .unwrap();
        let entry = vault.get(&id).unwrap();
        assert_eq!(entry.title, "My account");
        assert_eq!(entry.notes, "Keep these notes");
        assert_eq!(entry.folder, "Work");
        assert!(entry.favorite);
        assert_eq!(entry.history, vec!["Original-fictional-secret!"]);
        state.clear();
        state
            .handle(
                &mut vault,
                "client",
                &request("requestSave", "user", "Another-fictional-secret!"),
            )
            .unwrap();
        let p = state.pending().unwrap();
        let mut changed = vault.get(&id).unwrap();
        changed.password = "Changed-elsewhere!".into();
        vault.save(changed).unwrap();
        assert_eq!(
            state.decide(
                &mut vault,
                &SaveDecision {
                    id: p.id.to_string(),
                    allow: true,
                    secret: (MASTER).to_string(),
                    target: id.to_string(),
                    username: ("user").to_string(),
                    title: ("ignored").to_string()
                }
            ),
            Err("browserLoginChanged".into())
        );
        assert_eq!(vault.get(&id).unwrap().password, "Changed-elsewhere!");
    }
    #[test]
    fn decline_expiry_and_revocation_discard_transient_passwords() {
        let (_dir, mut vault, mut state) = setup();
        let r = request("requestSave", "user", "Fictional-secret!");
        state.handle(&mut vault, "client", &r).unwrap();
        let p = state.pending().unwrap();
        state
            .decide(
                &mut vault,
                &SaveDecision {
                    id: p.id.to_string(),
                    allow: false,
                    secret: ("").to_string(),
                    target: ("").to_string(),
                    username: ("").to_string(),
                    title: ("").to_string(),
                },
            )
            .unwrap();
        assert!(state.pending.as_ref().unwrap().password.is_none());
        assert!(vault.browser_matches(&p.origin).unwrap().is_empty());
        state.clear();
        state.handle(&mut vault, "client", &r).unwrap();
        state.pending.as_mut().unwrap().info.expires_at = 0;
        assert!(state.pending().is_none());
        state.handle(&mut vault, "client", &r).unwrap();
        state.revoke("other");
        assert!(state.occupied());
        state.revoke("client");
        assert!(!state.occupied());
    }
}
#[derive(Deserialize, Zeroize, ZeroizeOnDrop)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SaveDecision {
    pub id: String,
    pub allow: bool,
    pub secret: String,
    pub target: String,
    pub username: String,
    pub title: String,
}
struct PendingSave {
    info: SaveRequest,
    client: String,
    password: Option<Zeroizing<String>>,
    favicon: String,
    previous: Vec<(String, Vec<u8>)>,
    outcome: Option<String>,
}
#[derive(Default)]
pub struct SaveState {
    pending: Option<PendingSave>,
}

fn credentials(r: &Request) -> Result<(String, &str, &str)> {
    let origin = canonical_origin(r.origin.as_deref().ok_or("invalidUrl")?)?;
    let username = r.username.as_deref().unwrap_or("");
    let password = r.password.as_deref().ok_or("invalidEntry")?;
    if username.len() > 2048 || password.is_empty() || password.len() > 4096 {
        return Err("invalidEntry".into());
    }
    Ok((origin, username, password))
}
fn matching(
    vault: &mut Vault,
    origin: &str,
    username: &str,
    password: &str,
) -> Result<(Vec<Account>, bool)> {
    let accounts: Vec<_> = vault
        .browser_matches(origin)?
        .into_iter()
        .filter(|a| !username.is_empty() && a.username == username)
        .collect();
    let mut same = false;
    for account in &accounts {
        same |= vault.browser_password_matches(&account.id, password)?;
    }
    Ok((accounts, same))
}
impl SaveState {
    pub fn clear(&mut self) {
        self.pending = None;
    }
    pub fn revoke(&mut self, client: &str) {
        if self.pending.as_ref().is_some_and(|p| p.client == client) {
            self.clear();
        }
    }
    fn expire(&mut self) {
        if self
            .pending
            .as_ref()
            .is_some_and(|p| p.info.expires_at <= vault::now())
        {
            self.clear();
        }
    }
    pub fn pending(&mut self) -> Option<SaveRequest> {
        self.expire();
        self.pending
            .as_ref()
            .filter(|p| p.outcome.is_none())
            .map(|p| p.info.clone())
    }
    pub fn occupied(&mut self) -> bool {
        self.expire();
        self.pending.is_some()
    }
    pub fn handle(&mut self, vault: &mut Vault, client: &str, r: &Request) -> Result<Value> {
        self.expire();
        match r.op.as_str() {
            "checkLogin" | "requestSave" => {
                if r.favicon.as_deref().is_some_and(|icon| !vault::valid_favicon(icon)) {
                    return Err("invalidEntry".into());
                }
                let (origin, username, password) = credentials(r)?;
                let (accounts, same) = matching(vault, &origin, username, password)?;
                let kind = if same {
                    "unchanged"
                } else if accounts.is_empty() {
                    "save"
                } else {
                    "update"
                };
                if r.op == "checkLogin" || same {
                    return Ok(json!({"kind":kind,"accounts":accounts}));
                }
                if self.pending.is_some() {
                    return Err("browserBusy".into());
                }
                let title = url::Url::parse(&origin)
                    .map_err(|_| "invalidUrl")?
                    .host_str()
                    .ok_or("invalidUrl")?
                    .to_string();
                let mut previous = Vec::new();
                for account in &accounts {
                    previous.push((
                        account.id.clone(),
                        vault.browser_password_digest(&account.id)?,
                    ));
                }
                let id = uuid::Uuid::new_v4().to_string();
                self.pending = Some(PendingSave {
                    info: SaveRequest {
                        id: id.clone(),
                        origin,
                        title,
                        username: username.into(),
                        kind: kind.into(),
                        accounts,
                        expires_at: vault::now() + 120,
                    },
                    client: client.into(),
                    favicon: r.favicon.clone().unwrap_or_default(),
                    password: Some(Zeroizing::new(password.into())),
                    previous,
                    outcome: None,
                });
                Ok(json!({"id":id,"kind":kind}))
            }
            "takeSave" => {
                let p = self
                    .pending
                    .as_ref()
                    .filter(|p| p.client == client && Some(p.info.id.as_str()) == r.id.as_deref())
                    .ok_or("browserExpired")?;
                if p.outcome.is_none() {
                    return Ok(json!({"pending":true}));
                }
                let p = self.pending.take().ok_or("browserExpired")?;
                Ok(json!({"outcome":p.outcome}))
            }
            "cancelSave" => {
                if self.pending.as_ref().is_some_and(|p| {
                    p.client == client && Some(p.info.id.as_str()) == r.id.as_deref()
                }) {
                    self.clear();
                }
                Ok(json!({}))
            }
            _ => Err("browserDenied".into()),
        }
    }
    pub fn decide(&mut self, vault: &mut Vault, decision: &SaveDecision) -> Result<Option<String>> {
        let id = decision.id.as_str();
        let allow = decision.allow;
        let master = decision.secret.as_str();
        let target = decision.target.as_str();
        let username = decision.username.as_str();
        let title = decision.title.as_str();
        self.expire();
        let p = self
            .pending
            .as_mut()
            .filter(|p| p.info.id == id && p.outcome.is_none())
            .ok_or("browserExpired")?;
        if !allow {
            p.password = None;
            p.outcome = Some("declined".into());
            return Ok(None);
        }
        vault.authorize_browser_save(master)?;
        let password = p.password.as_ref().ok_or("browserExpired")?;
        let entry = if p.info.kind == "update" {
            let expected = p
                .previous
                .iter()
                .find(|(entry, _)| entry == target)
                .ok_or("browserOrigin")?;
            let mut entry = vault.get(target)?;
            if canonical_origin(&entry.url)? != p.info.origin
                || entry.username != p.info.username
                || digest(&entry.password) != expected.1
            {
                return Err("browserLoginChanged".into());
            }
            entry.password = password.to_string();
            if !p.favicon.is_empty() { entry.favicon = p.favicon.clone(); }
            entry
        } else {
            if username.is_empty()
                || username.len() > 2048
                || title.trim().is_empty()
                || title.len() > 512
            {
                return Err("invalidEntry".into());
            }
            if vault
                .browser_matches(&p.info.origin)?
                .iter()
                .any(|a| a.username == username)
            {
                return Err("browserLoginChanged".into());
            }
            Entry {
                id: String::new(),
                title: title.into(),
                username: username.into(),
                password: password.to_string(),
                url: p.info.origin.clone(),
                favicon: p.favicon.clone(),
                notes: String::new(),
                folder: String::new(),
                tags: Vec::new(),
                favorite: false,
                created_at: 0,
                updated_at: 0,
                fields: Vec::new(),
                history: Vec::new(),
            }
        };
        let saved = vault.save(entry)?;
        let id = saved.id.clone();
        p.password = None;
        p.outcome = Some(
            if p.info.kind == "update" {
                "updated"
            } else {
                "saved"
            }
            .into(),
        );
        Ok(Some(id))
    }
}
