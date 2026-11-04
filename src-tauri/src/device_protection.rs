use crate::vault::Result;
use zeroize::{Zeroize, Zeroizing};
#[cfg(windows)]
fn dpapi(input: &[u8], protect: bool) -> Result<Zeroizing<Vec<u8>>> {
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData,
        },
    };
    if input.len() > 65536 {
        return Err("browserUnavailable".into());
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
        return Err("browserUnavailable".into());
    }
    if result.pbData.is_null() {
        return Err("browserUnavailable".into());
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
    Err("browserUnavailable".into())
}
#[cfg(not(windows))]
pub(crate) fn platform_unprotect(_: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    Err("browserUnavailable".into())
}
