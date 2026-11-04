use crate::vault::{Result, derive, now, seal, unseal};
use rand::{RngCore, rngs::OsRng};
use serde::{Deserialize, Serialize};
use std::{fs, io::Write, path::PathBuf};
use zeroize::{Zeroize, Zeroizing};

const MAX_FAILURES: u8 = 10;
#[derive(Serialize, Deserialize)]
struct Record {
    version: u32,
    stamp: Vec<u8>,
    salt: Vec<u8>,
    wrapped_key: Vec<u8>,
    failures: u8,
    cooldown_until: u64,
}
#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PinInfo {
    pub enabled: bool,
    pub available: bool,
    pub blocked: bool,
    pub attempts_remaining: u8,
    pub cooldown_seconds: u64,
}

pub struct PinStore {
    path: Option<PathBuf>,
    expected: bool,
}
impl PinStore {
    pub fn new(path: Option<PathBuf>) -> Self {
        let expected = path.as_ref().is_some_and(|p| p.exists());
        Self { path, expected }
    }
    pub fn enabled(&self) -> bool {
        self.expected
    }
    fn read(&self) -> Result<Record> {
        let path = self.path.as_ref().ok_or("pinUnavailable")?;
        if fs::metadata(path).map_err(|_| "pinUnavailable")?.len() > 65536 {
            return Err("pinUnavailable".into());
        }
        let bytes = fs::read(path).map_err(|_| "pinUnavailable")?;
        let plain = platform_unprotect(&bytes)?;
        let record: Record = serde_json::from_slice(&plain).map_err(|_| "pinUnavailable")?;
        if record.version != 1
            || record.stamp.len() != 32
            || record.salt.len() != 16
            || record.wrapped_key.len() != 72
            || record.failures > MAX_FAILURES
        {
            return Err("pinUnavailable".into());
        }
        Ok(record)
    }
    fn write(&self, record: &Record) -> Result<()> {
        let path = self.path.as_ref().ok_or("pinUnavailable")?;
        let plain = Zeroizing::new(serde_json::to_vec(record).map_err(|_| "pinUnavailable")?);
        let protected = platform_protect(&plain)?;
        let temporary = path.with_file_name(format!(".pin-{}.tmp", uuid::Uuid::new_v4()));
        let result = (|| {
            let mut file = fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&temporary)
                .map_err(|_| "pinUnavailable")?;
            file.write_all(&protected).map_err(|_| "pinUnavailable")?;
            file.sync_all().map_err(|_| "pinUnavailable")?;
            drop(file);
            fs::rename(&temporary, path).map_err(|_| "pinUnavailable")?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }
    pub fn info(&self, stamp: &[u8]) -> PinInfo {
        if !self.expected {
            return PinInfo {
                available: cfg!(windows),
                attempts_remaining: MAX_FAILURES,
                ..Default::default()
            };
        }
        match self.read() {
            Ok(r) if r.stamp == stamp => PinInfo {
                enabled: true,
                available: cfg!(windows),
                blocked: r.failures >= MAX_FAILURES,
                attempts_remaining: MAX_FAILURES.saturating_sub(r.failures),
                cooldown_seconds: r.cooldown_until.saturating_sub(now()),
            },
            _ => PinInfo {
                enabled: true,
                available: false,
                blocked: true,
                ..Default::default()
            },
        }
    }
    pub fn configure(&mut self, pin: &str, stamp: &[u8], key: &[u8; 32]) -> Result<()> {
        Self::validate_candidate(pin)?;
        let mut salt = vec![0; 16];
        OsRng.try_fill_bytes(&mut salt).map_err(|_| "randomError")?;
        let wrapping = derive(pin, &salt)?;
        let record = Record {
            version: 1,
            stamp: stamp.to_vec(),
            salt,
            wrapped_key: seal(&wrapping, key, stamp)?,
            failures: 0,
            cooldown_until: 0,
        };
        self.write(&record)?;
        self.expected = true;
        Ok(())
    }
    pub fn validate_candidate(pin: &str) -> Result<()> {
        validate_pin(pin)?;
        // Reject repeated and simple ascending/descending numeric sequences.
        let bytes = pin.as_bytes();
        if bytes.iter().all(|c| *c == bytes[0])
            || bytes.windows(2).all(|w| w[1] == w[0] + 1)
            || bytes.windows(2).all(|w| w[0] == w[1] + 1)
        {
            return Err("weakPin".into());
        }
        Ok(())
    }
    pub fn verify(&mut self, pin: &str, stamp: &[u8]) -> Result<Zeroizing<[u8; 32]>> {
        validate_pin(pin)?;
        if !self.expected {
            return Err("pinUnavailable".into());
        }
        let mut record = self.read()?;
        if record.stamp != stamp {
            return Err("pinUnavailable".into());
        }
        if record.failures >= MAX_FAILURES {
            return Err("pinBlocked".into());
        }
        if record.cooldown_until > now() {
            return Err("pinCooldown".into());
        }
        // Persist before testing a guess, so an interrupted process consumes the attempt.
        record.failures += 1;
        if record.failures >= 5 {
            record.cooldown_until = now() + 30;
        }
        self.write(&record)?;
        let wrapping = derive(pin, &record.salt)?;
        let raw = unseal(&wrapping, &record.wrapped_key, stamp).map_err(|_| {
            if record.failures >= MAX_FAILURES {
                "pinBlocked"
            } else {
                "invalidPin"
            }
        })?;
        if raw.len() != 32 {
            return Err("pinUnavailable".into());
        }
        let mut key = Zeroizing::new([0; 32]);
        key.copy_from_slice(&raw);
        record.failures = 0;
        record.cooldown_until = 0;
        self.write(&record)?;
        Ok(key)
    }
    pub fn rearm(&mut self, stamp: &[u8]) -> Result<()> {
        if !self.expected {
            return Ok(());
        }
        let mut r = self.read()?;
        if r.stamp != stamp {
            return Err("pinUnavailable".into());
        }
        r.failures = 0;
        r.cooldown_until = 0;
        self.write(&r)
    }
    pub fn remove(&mut self) -> Result<()> {
        if let Some(path) = &self.path {
            match fs::remove_file(path) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err("pinUnavailable".into()),
            }
        }
        self.expected = false;
        Ok(())
    }
}
fn validate_pin(pin: &str) -> Result<()> {
    if pin.len() != 4 || !pin.bytes().all(|c| c.is_ascii_digit()) {
        Err("pinLength".into())
    } else {
        Ok(())
    }
}

#[cfg(windows)]
fn dpapi(input: &[u8], protect: bool) -> Result<Zeroizing<Vec<u8>>> {
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData,
        },
    };
    if input.len() > 65536 {
        return Err("pinUnavailable".into());
    }
    let source = CRYPT_INTEGER_BLOB {
        cbData: input.len() as u32,
        pbData: input.as_ptr().cast_mut(),
    };
    let mut result = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    // SAFETY: input lives throughout the call, all optional pointers are null,
    // UI is forbidden and machine-wide protection is deliberately not selected.
    let ok = unsafe {
        if protect {
            CryptProtectData(
                &source,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut result,
            )
        } else {
            CryptUnprotectData(
                &source,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut result,
            )
        }
    };
    if ok == 0 {
        return Err("pinUnavailable".into());
    }
    if result.pbData.is_null() {
        return Err("pinUnavailable".into());
    }
    // SAFETY: DPAPI returns cbData bytes allocated with LocalAlloc. Copy them,
    // zero the allocation and release it with the matching LocalFree API.
    let output = unsafe {
        let data = std::slice::from_raw_parts_mut(result.pbData, result.cbData as usize);
        let copy = Zeroizing::new(data.to_vec());
        data.zeroize();
        LocalFree(result.pbData.cast());
        copy
    };
    Ok(output)
}
#[cfg(windows)]
pub(crate) fn platform_protect(input: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    dpapi(input, true)
}
#[cfg(windows)]
pub(crate) fn platform_unprotect(input: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    dpapi(input, false)
}
#[cfg(not(windows))]
pub(crate) fn platform_protect(_: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    Err("pinUnavailable".into())
}
#[cfg(not(windows))]
pub(crate) fn platform_unprotect(_: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    Err("pinUnavailable".into())
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    #[test]
    fn dpapi_pin_is_bound_authenticated_rate_limited_and_persistent() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("pin");
        let stamp = [3; 32];
        let key = [7; 32];
        let mut store = PinStore::new(Some(path.clone()));
        assert!(store.configure("1111", &stamp, &key).is_err());
        assert!(store.configure("1234", &stamp, &key).is_err());
        assert!(store.configure("729461", &stamp, &key).is_err());
        store.configure("7294", &stamp, &key).unwrap();
        assert_eq!(*store.verify("7294", &stamp).unwrap(), key);
        assert!(store.verify("0000", &stamp).is_err());
        drop(store);
        let mut store = PinStore::new(Some(path.clone()));
        assert_eq!(store.info(&stamp).attempts_remaining, 9);
        let mut record = store.read().unwrap();
        record.failures = 9;
        record.cooldown_until = 0;
        store.write(&record).unwrap();
        assert_eq!(store.verify("0000", &stamp).unwrap_err(), "pinBlocked");
        assert_eq!(store.verify("7294", &stamp).unwrap_err(), "pinBlocked");
        store.rearm(&stamp).unwrap();
        assert_eq!(*store.verify("7294", &stamp).unwrap(), key);
        assert!(store.verify("7294", &[9; 32]).is_err());
        let bytes = fs::read(&path).unwrap();
        assert!(!bytes.windows(4).any(|w| w == b"7294"));
        assert!(!bytes.windows(32).any(|w| w == key));
        fs::write(&path, b"corrupt").unwrap();
        assert!(!store.info(&stamp).available);
        assert!(store.verify("7294", &stamp).is_err());
        store.remove().unwrap();
        assert!(!store.enabled());
    }
}
