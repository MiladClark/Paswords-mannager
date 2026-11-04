#[cfg(windows)]
mod windows {
    use std::sync::Arc;
    use tauri::WebviewWindow;
    use windows_sys::Win32::{
        Foundation::{HWND, LPARAM, LRESULT, WPARAM},
        System::RemoteDesktop::{
            NOTIFY_FOR_THIS_SESSION, WTSRegisterSessionNotification,
            WTSUnRegisterSessionNotification,
        },
        UI::{
            Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
            WindowsAndMessaging::{WM_NCDESTROY, WM_POWERBROADCAST, WM_WTSSESSION_CHANGE},
        },
    };
    const SUBCLASS: usize = 0x505753;
    type Lock = Arc<dyn Fn() + Send + Sync>;

    fn should_lock(message: u32, event: usize) -> bool {
        message == WM_WTSSESSION_CHANGE
            || (message == WM_POWERBROADCAST && matches!(event, 4 | 6 | 7 | 18))
    }
    unsafe extern "system" fn window_proc(
        hwnd: HWND,
        message: u32,
        event: WPARAM,
        data: LPARAM,
        _: usize,
        reference: usize,
    ) -> LRESULT {
        if message == WM_NCDESTROY {
            // SAFETY: the unique box was installed once and is released once,
            // after removing the subclass so no later invocation can borrow it.
            unsafe {
                WTSUnRegisterSessionNotification(hwnd);
                RemoveWindowSubclass(hwnd, Some(window_proc), SUBCLASS);
                drop(Box::from_raw(reference as *mut Lock));
            }
        } else if should_lock(message, event) {
            // Never allow a Rust panic to unwind through a Win32 callback.
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                // SAFETY: reference remains owned until WM_NCDESTROY above.
                let lock = unsafe { &*(reference as *const Lock) };
                lock();
            }));
        }
        // SAFETY: preserve the original Tauri window procedure for every message.
        unsafe { DefSubclassProc(hwnd, message, event, data) }
    }
    pub fn install(window: &WebviewWindow, lock: Lock) -> crate::vault::Result<()> {
        let hwnd = window.hwnd().map_err(|_| "sessionGuardUnavailable")?.0 as HWND;
        install_hwnd(hwnd, lock)
    }
    fn install_hwnd(hwnd: HWND, lock: Lock) -> crate::vault::Result<()> {
        let reference = Box::into_raw(Box::new(lock));
        // Called from Tauri's setup on the window's UI thread, as required by
        // SetWindowSubclass. The callback owns reference after successful setup.
        unsafe {
            if SetWindowSubclass(hwnd, Some(window_proc), SUBCLASS, reference as usize) == 0 {
                drop(Box::from_raw(reference));
                return Err("sessionGuardUnavailable".into());
            }
            if WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION) == 0 {
                RemoveWindowSubclass(hwnd, Some(window_proc), SUBCLASS);
                drop(Box::from_raw(reference));
                return Err("sessionGuardUnavailable".into());
            }
        }
        Ok(())
    }
    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn locks_on_user_session_changes_and_suspend_resume_without_unlocking() {
            for session_event in 1..=11 {
                assert!(should_lock(WM_WTSSESSION_CHANGE, session_event));
            }
            for power_event in [4, 6, 7, 18] {
                assert!(should_lock(WM_POWERBROADCAST, power_event));
            }
            assert!(!should_lock(WM_POWERBROADCAST, 10)); // battery status
            assert!(!should_lock(0, 7));
        }
        #[test]
        fn native_subclass_receives_notifications_and_releases_its_callback() {
            use std::sync::atomic::{AtomicUsize, Ordering};
            use windows_sys::Win32::UI::WindowsAndMessaging::{
                CreateWindowExW, DestroyWindow, SendMessageW,
            };
            let class: Vec<u16> = "STATIC\0".encode_utf16().collect();
            let title: Vec<u16> = "PassWards security regression\0".encode_utf16().collect();
            // An unshown test-owned window; no user's window/session is altered.
            let hwnd = unsafe {
                CreateWindowExW(
                    0,
                    class.as_ptr(),
                    title.as_ptr(),
                    0,
                    0,
                    0,
                    32,
                    32,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null(),
                )
            };
            assert!(!hwnd.is_null());
            let calls = Arc::new(AtomicUsize::new(0));
            let recorded = calls.clone();
            install_hwnd(
                hwnd,
                Arc::new(move || {
                    recorded.fetch_add(1, Ordering::SeqCst);
                }),
            )
            .unwrap();
            unsafe {
                SendMessageW(hwnd, WM_WTSSESSION_CHANGE, 7, 0);
                SendMessageW(hwnd, WM_POWERBROADCAST, 18, 0);
                SendMessageW(hwnd, 0, 0, 0);
                assert_ne!(DestroyWindow(hwnd), 0);
            }
            assert_eq!(calls.load(Ordering::SeqCst), 2);
            assert_eq!(Arc::strong_count(&calls), 1);
        }
    }
}
#[cfg(windows)]
pub use windows::install;
