use super::{HOST, MAX_MESSAGE, Request, extension_identity, extension_origin_allowed};
use crate::vault::Result;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    path::Path,
    sync::Arc,
    time::Duration,
};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use zeroize::Zeroizing;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    caller: String,
    message: Value,
}
pub fn read_native(input: &mut impl Read) -> std::io::Result<Vec<u8>> {
    let mut length = [0u8; 4];
    input.read_exact(&mut length)?;
    let length = u32::from_le_bytes(length) as usize;
    if length == 0 || length > MAX_MESSAGE {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "message size",
        ));
    }
    let mut bytes = vec![0; length];
    input.read_exact(&mut bytes)?;
    Ok(bytes)
}
pub fn write_native(output: &mut impl Write, bytes: &[u8]) -> std::io::Result<()> {
    if bytes.is_empty() || bytes.len() > MAX_MESSAGE {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "message size",
        ));
    }
    output.write_all(&(bytes.len() as u32).to_le_bytes())?;
    output.write_all(bytes)?;
    output.flush()
}
async fn read_frame(input: &mut (impl AsyncRead + Unpin)) -> std::io::Result<Zeroizing<Vec<u8>>> {
    let length = input.read_u32_le().await? as usize;
    if length == 0 || length > MAX_MESSAGE {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "message size",
        ));
    }
    let mut bytes = Zeroizing::new(vec![0; length]);
    input.read_exact(&mut bytes).await?;
    Ok(bytes)
}
async fn write_frame(output: &mut (impl AsyncWrite + Unpin), bytes: &[u8]) -> std::io::Result<()> {
    if bytes.is_empty() || bytes.len() > MAX_MESSAGE {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "message size",
        ));
    }
    output.write_u32_le(bytes.len() as u32).await?;
    output.write_all(bytes).await?;
    output.flush().await
}
pub type Handler = Arc<dyn Fn(&str, Request) -> Result<Value> + Send + Sync>;

#[cfg(windows)]
fn user_sid() -> std::io::Result<String> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, LocalFree},
        Security::{
            Authorization::ConvertSidToStringSidW, GetTokenInformation, TOKEN_QUERY, TOKEN_USER,
            TokenUser,
        },
        System::Threading::{GetCurrentProcess, OpenProcessToken},
    };
    // SAFETY: token is owned locally, token-information storage is aligned, and
    // Windows-allocated SID text is read until its NUL and released with LocalFree.
    unsafe {
        let mut token = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return Err(std::io::Error::last_os_error());
        }
        let mut needed = 0;
        GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut needed);
        let mut data = vec![0usize; (needed as usize).div_ceil(std::mem::size_of::<usize>())];
        let ok = GetTokenInformation(
            token,
            TokenUser,
            data.as_mut_ptr().cast(),
            needed,
            &mut needed,
        );
        CloseHandle(token);
        if ok == 0 {
            return Err(std::io::Error::last_os_error());
        }
        let user = &*data.as_ptr().cast::<TOKEN_USER>();
        let mut text = std::ptr::null_mut();
        if ConvertSidToStringSidW(user.User.Sid, &mut text) == 0 {
            return Err(std::io::Error::last_os_error());
        }
        let mut len = 0;
        while *text.add(len) != 0 {
            len += 1;
        }
        let sid = String::from_utf16_lossy(std::slice::from_raw_parts(text, len));
        LocalFree(text.cast());
        Ok(sid)
    }
}
#[cfg(windows)]
pub fn endpoint() -> std::io::Result<String> {
    use sha2::{Digest, Sha256};
    let hash = Sha256::digest(user_sid()?.as_bytes());
    Ok(format!(
        r"\\.\pipe\Passward-{}",
        hash[..16]
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    ))
}
#[cfg(windows)]
fn create_pipe(
    name: &str,
    first: bool,
) -> std::io::Result<tokio::net::windows::named_pipe::NamedPipeServer> {
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::{
            Authorization::{
                ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
            },
            SECURITY_ATTRIBUTES,
        },
    };
    let sddl: Vec<u16> = format!("D:P(A;;GA;;;{})", user_sid()?)
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let mut descriptor = std::ptr::null_mut();
    // SAFETY: SDDL and SECURITY_ATTRIBUTES live until CreateNamedPipe returns;
    // the kernel copies the descriptor. Only the current user's SID is allowed.
    unsafe {
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            std::ptr::null_mut(),
        ) == 0
        {
            return Err(std::io::Error::last_os_error());
        }
        let mut attrs = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor,
            bInheritHandle: 0,
        };
        let result = tokio::net::windows::named_pipe::ServerOptions::new()
            .first_pipe_instance(first)
            .reject_remote_clients(true)
            .max_instances(18)
            .create_with_security_attributes_raw(
                name,
                (&mut attrs as *mut SECURITY_ATTRIBUTES).cast(),
            );
        LocalFree(descriptor);
        result
    }
}
#[cfg(windows)]
pub async fn serve_at(name: String, handler: Handler) -> std::io::Result<()> {
    serve_at_ready(name, handler, || {}).await
}
#[cfg(windows)]
pub async fn serve_at_ready(
    name: String,
    handler: Handler,
    ready: impl FnOnce(),
) -> std::io::Result<()> {
    let mut server = create_pipe(&name, true)?;
    ready();
    let slots = Arc::new(tokio::sync::Semaphore::new(16));
    loop {
        server.connect().await?;
        let mut client = server;
        server = create_pipe(&name, false)?;
        let Ok(permit) = slots.clone().try_acquire_owned() else {
            continue;
        };
        let handler = handler.clone();
        tokio::spawn(async move {
            let _permit = permit;
            let result =
                tokio::time::timeout(Duration::from_secs(3), read_frame(&mut client)).await;
            let Ok(Ok(bytes)) = result else {
                return;
            };
            let Ok(envelope) = serde_json::from_slice::<Envelope>(&bytes) else {
                return;
            };
            let request = serde_json::from_value::<Request>(envelope.message);
            let response = match request {
                Ok(request) => {
                    tokio::task::spawn_blocking(move || match handler(&envelope.caller, request) {
                        Ok(value) => json!({"ok":true,"data":value}),
                        Err(error) => json!({"ok":false,"error":error}),
                    })
                    .await
                    .unwrap_or_else(|_| json!({"ok":false,"error":"browserUnavailable"}))
                }
                Err(_) => json!({"ok":false,"error":"browserDenied"}),
            };
            if let Ok(bytes) = serde_json::to_vec(&response) {
                let bytes = Zeroizing::new(bytes);
                let _ =
                    tokio::time::timeout(Duration::from_secs(3), write_frame(&mut client, &bytes))
                        .await;
            }
        });
    }
}
#[cfg(windows)]
pub async fn exchange_at(
    name: &str,
    caller: &str,
    message: Value,
) -> std::io::Result<Zeroizing<Vec<u8>>> {
    let mut retries = 0;
    let mut pipe = loop {
        match tokio::net::windows::named_pipe::ClientOptions::new().open(name) {
            Ok(pipe) => break pipe,
            Err(error) if error.raw_os_error() == Some(231) && retries < 30 => {
                retries += 1;
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            Err(error) => return Err(error),
        }
    };
    let bytes = Zeroizing::new(serde_json::to_vec(&Envelope {
        caller: caller.into(),
        message,
    })?);
    write_frame(&mut pipe, &bytes).await?;
    read_frame(&mut pipe).await
}
pub fn native_host(caller: &str) {
    if !extension_origin_allowed(caller) {
        return;
    }
    #[cfg(windows)]
    {
        let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        else {
            return;
        };
        let Ok(name) = endpoint() else {
            return;
        };
        let mut input = std::io::stdin().lock();
        let mut output = std::io::stdout().lock();
        while let Ok(bytes) = read_native(&mut input) {
            let bytes = Zeroizing::new(bytes);
            let Ok(message) = serde_json::from_slice::<Value>(&bytes) else {
                break;
            };
            let focus = message["op"] == "focus";
            let response = runtime.block_on(async {
                let first = tokio::time::timeout(
                    Duration::from_secs(8),
                    exchange_at(&name, caller, message.clone()),
                )
                .await;
                if let Ok(Ok(data)) = first {
                    return data;
                }
                if focus {
                    use std::os::windows::process::CommandExt;
                    if let Ok(exe) = std::env::current_exe() {
                        let _ = std::process::Command::new(exe)
                            .creation_flags(0x08000000)
                            .spawn();
                    }
                    for _ in 0..40 {
                        tokio::time::sleep(Duration::from_millis(125)).await;
                        if let Ok(Ok(data)) = tokio::time::timeout(
                            Duration::from_secs(2),
                            exchange_at(&name, caller, message.clone()),
                        )
                        .await
                        {
                            return data;
                        }
                    }
                }
                Zeroizing::new(br#"{"ok":false,"error":"browserOffline"}"#.to_vec())
            });
            if write_native(&mut output, &response).is_err() {
                break;
            }
        }
    }
}
pub fn register(executable: &Path, directory: &Path) -> Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::fs::create_dir_all(directory).map_err(|_| "browserUnavailable")?;
        let path = directory.join(format!("{HOST}.json"));
        let origins: Vec<_> = extension_identity().origins().collect();
        let data = json!({"name":HOST,"description":"PassWards browser connection","path":executable,"type":"stdio","allowed_origins":origins});
        std::fs::write(
            &path,
            serde_json::to_vec_pretty(&data).map_err(|_| "storageError")?,
        )
        .map_err(|_| "storageError")?;
        for browser in ["Google\\Chrome", "Microsoft\\Edge", "BraveSoftware\\Brave-Browser"] {
            let key = format!("HKCU\\Software\\{browser}\\NativeMessagingHosts\\{HOST}");
            let status = std::process::Command::new("reg.exe")
                .args(["ADD", &key, "/ve", "/t", "REG_SZ", "/d"])
                .arg(&path)
                .arg("/f")
                .creation_flags(0x08000000)
                .output()
                .map_err(|_| "browserUnavailable")?;
            if !status.status.success() {
                return Err("browserUnavailable".into());
            }
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (executable, directory);
        Err("browserUnavailable".into())
    }
}
