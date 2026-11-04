use crate::vault::Result;
use std::ops::Deref;
use zeroize::{Zeroize, Zeroizing};

// A dedicated aligned page avoids sharing a VirtualLock region with unrelated
// heap allocations. The address stays stable when the owning Session moves.
#[repr(align(4096))]
struct Page([u8; 4096]);

pub struct LockedKey {
    page: Box<Page>,
}
impl LockedKey {
    pub fn new(key: Zeroizing<[u8; 32]>) -> Result<Self> {
        let mut page = Box::new(Page([0; 4096]));
        #[cfg(windows)]
        // SAFETY: the box owns this complete, initialized page until Drop.
        if unsafe {
            windows_sys::Win32::System::Memory::VirtualLock(page.0.as_mut_ptr().cast(), 4096)
        } == 0
        {
            return Err("secureMemoryUnavailable".into());
        }
        page.0[..32].copy_from_slice(key.as_ref());
        Ok(Self { page })
    }
}
impl Deref for LockedKey {
    type Target = [u8; 32];
    fn deref(&self) -> &Self::Target {
        self.page.0[..32].try_into().expect("fixed key length")
    }
}
impl AsRef<[u8]> for LockedKey {
    fn as_ref(&self) -> &[u8] {
        &self.page.0[..32]
    }
}
impl Drop for LockedKey {
    fn drop(&mut self) {
        // Clear while the page is still locked, before returning it to the heap.
        self.page.0.zeroize();
        #[cfg(windows)]
        // SAFETY: this is the same live allocation successfully locked in new.
        unsafe {
            windows_sys::Win32::System::Memory::VirtualUnlock(
                self.page.0.as_mut_ptr().cast(),
                4096,
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn protected_key_has_stable_page_aligned_storage() {
        let key = LockedKey::new(Zeroizing::new([83; 32])).unwrap();
        let address = key.as_ref().as_ptr() as usize;
        assert_eq!(address % 4096, 0);
        fn move_key(key: LockedKey) -> LockedKey {
            key
        }
        let moved = move_key(key);
        assert_eq!(address, moved.as_ref().as_ptr() as usize);
        assert_eq!(*moved, [83; 32]);
    }
}
