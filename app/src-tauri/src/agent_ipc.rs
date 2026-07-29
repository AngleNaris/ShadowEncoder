use shadowencoder_agent_core::AgentService;
use shadowencoder_agent_protocol::{
    error_code, local_endpoint_name, AgentRequest, AgentResponse, AgentStateChanged,
    AGENT_EVENT_NAME, MAX_MESSAGE_BYTES,
};
use std::io::{BufRead, BufReader, Read, Write};
use tauri::Emitter;

pub fn start(service: AgentService, app: tauri::AppHandle) -> Result<(), String> {
    std::thread::Builder::new()
        .name("shadowencoder-agent-ipc".into())
        .spawn(move || {
            if let Err(error) = serve(service, app) {
                eprintln!("[shadowencoder-agent] IPC 服务停止: {error}");
            }
        })
        .map(|_| ())
        .map_err(|error| format!("无法启动 Agent IPC 线程: {error}"))
}

#[cfg(target_os = "windows")]
fn serve(service: AgentService, app: tauri::AppHandle) -> Result<(), String> {
    use std::fs::File;
    use std::os::windows::io::FromRawHandle;
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, ERROR_PIPE_CONNECTED, INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::Storage::FileSystem::PIPE_ACCESS_DUPLEX;
    use windows_sys::Win32::System::Pipes::{
        ConnectNamedPipe, CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS,
        PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
    };

    let endpoint = local_endpoint_name();
    let endpoint_wide: Vec<u16> = endpoint.encode_utf16().chain(std::iter::once(0)).collect();
    let security = current_user_pipe_security()?;
    loop {
        let handle = unsafe {
            CreateNamedPipeW(
                endpoint_wide.as_ptr(),
                PIPE_ACCESS_DUPLEX,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                PIPE_UNLIMITED_INSTANCES,
                MAX_MESSAGE_BYTES as u32,
                MAX_MESSAGE_BYTES as u32,
                0,
                &security.attributes,
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(format!(
                "无法创建 Named Pipe {endpoint}: Windows error {}",
                unsafe { GetLastError() }
            ));
        }
        let connected = unsafe { ConnectNamedPipe(handle, std::ptr::null_mut()) } != 0
            || unsafe { GetLastError() } == ERROR_PIPE_CONNECTED;
        if !connected {
            unsafe {
                CloseHandle(handle);
            }
            continue;
        }
        let mut file = unsafe { File::from_raw_handle(handle as _) };
        if let Err(error) = serve_connection(&mut file, &service, &app) {
            eprintln!("[shadowencoder-agent] IPC 请求失败: {error}");
        }
    }
}

#[cfg(target_os = "windows")]
struct PipeSecurity {
    descriptor: windows_sys::Win32::Security::PSECURITY_DESCRIPTOR,
    attributes: windows_sys::Win32::Security::SECURITY_ATTRIBUTES,
}

#[cfg(target_os = "windows")]
impl Drop for PipeSecurity {
    fn drop(&mut self) {
        if !self.descriptor.is_null() {
            unsafe {
                windows_sys::Win32::Foundation::LocalFree(self.descriptor);
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn current_user_pipe_security() -> Result<PipeSecurity, String> {
    use windows_sys::core::PWSTR;
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError};
    use windows_sys::Win32::Security::Authorization::{
        ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
        SDDL_REVISION_1,
    };
    use windows_sys::Win32::Security::{
        GetTokenInformation, TokenUser, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, TOKEN_QUERY,
        TOKEN_USER,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    let mut token = std::ptr::null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(format!(
            "无法读取当前用户令牌: Windows error {}",
            unsafe { GetLastError() }
        ));
    }

    let result = (|| {
        let mut required = 0_u32;
        unsafe {
            GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut required);
        }
        if required == 0 {
            return Err(format!(
                "无法读取当前用户 SID 长度: Windows error {}",
                unsafe { GetLastError() }
            ));
        }
        let word_size = std::mem::size_of::<usize>();
        let mut buffer = vec![0_usize; (required as usize).div_ceil(word_size)];
        if unsafe {
            GetTokenInformation(
                token,
                TokenUser,
                buffer.as_mut_ptr().cast(),
                required,
                &mut required,
            )
        } == 0
        {
            return Err(format!("无法读取当前用户 SID: Windows error {}", unsafe {
                GetLastError()
            }));
        }
        let token_user = unsafe { std::ptr::read_unaligned(buffer.as_ptr().cast::<TOKEN_USER>()) };
        let mut sid_text_ptr: PWSTR = std::ptr::null_mut();
        if unsafe { ConvertSidToStringSidW(token_user.User.Sid, &mut sid_text_ptr) } == 0 {
            return Err(format!(
                "无法格式化当前用户 SID: Windows error {}",
                unsafe { GetLastError() }
            ));
        }
        let sid_text = unsafe {
            let mut length = 0;
            while *sid_text_ptr.add(length) != 0 {
                length += 1;
            }
            let value = String::from_utf16_lossy(std::slice::from_raw_parts(sid_text_ptr, length));
            windows_sys::Win32::Foundation::LocalFree(sid_text_ptr.cast());
            value
        };

        let sddl = format!("D:P(A;;GA;;;SY)(A;;GA;;;{sid_text})");
        let sddl_wide: Vec<u16> = sddl.encode_utf16().chain(std::iter::once(0)).collect();
        let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl_wide.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                std::ptr::null_mut(),
            )
        } == 0
        {
            return Err(format!(
                "无法创建 Agent IPC 安全描述符: Windows error {}",
                unsafe { GetLastError() }
            ));
        }
        Ok(PipeSecurity {
            descriptor,
            attributes: SECURITY_ATTRIBUTES {
                nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: descriptor,
                bInheritHandle: 0,
            },
        })
    })();
    unsafe {
        CloseHandle(token);
    }
    result
}

#[cfg(unix)]
fn serve(service: AgentService, app: tauri::AppHandle) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::UnixListener;
    use std::path::Path;

    let endpoint = local_endpoint_name();
    let path = Path::new(&endpoint);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("无法创建 IPC 目录 {}: {error}", parent.display()))?;
        std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("无法限制 IPC 目录权限: {error}"))?;
    }
    if path.exists() {
        std::fs::remove_file(path)
            .map_err(|error| format!("无法移除旧 IPC socket {}: {error}", path.display()))?;
    }
    let listener = UnixListener::bind(path)
        .map_err(|error| format!("无法监听 Unix socket {}: {error}", path.display()))?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("无法限制 IPC socket 权限: {error}"))?;
    for connection in listener.incoming() {
        match connection {
            Ok(mut stream) => {
                if let Err(error) = serve_connection(&mut stream, &service, &app) {
                    eprintln!("[shadowencoder-agent] IPC 请求失败: {error}");
                }
            }
            Err(error) => eprintln!("[shadowencoder-agent] IPC 连接失败: {error}"),
        }
    }
    Ok(())
}

fn serve_connection<S: Read + Write>(
    stream: &mut S,
    service: &AgentService,
    app: &tauri::AppHandle,
) -> Result<(), String> {
    let mut reader = BufReader::new(stream);
    let mut payload = Vec::new();
    reader
        .by_ref()
        .take((MAX_MESSAGE_BYTES + 1) as u64)
        .read_until(b'\n', &mut payload)
        .map_err(|error| format!("读取请求失败: {error}"))?;
    if payload.len() > MAX_MESSAGE_BYTES {
        let response = AgentResponse::failure(
            "unknown",
            error_code::VALIDATION_ERROR,
            "IPC 请求超过 1 MiB 限制",
        );
        write_response(reader.get_mut(), &response)?;
        return Ok(());
    }
    while payload.last() == Some(&b'\n') || payload.last() == Some(&b'\r') {
        payload.pop();
    }
    let request = match serde_json::from_slice::<AgentRequest>(&payload) {
        Ok(request) => request,
        Err(error) => {
            let request_id = serde_json::from_slice::<serde_json::Value>(&payload)
                .ok()
                .and_then(|value| {
                    value
                        .get("requestId")
                        .and_then(|value| value.as_str())
                        .map(str::to_string)
                })
                .unwrap_or_else(|| "unknown".into());
            let response = AgentResponse::failure(
                request_id,
                error_code::VALIDATION_ERROR,
                format!("请求 JSON 无效: {error}"),
            );
            write_response(reader.get_mut(), &response)?;
            return Ok(());
        }
    };
    let actor = request.actor.clone();
    let response = service.handle(request);
    if let Some(receipt) = &response.receipt {
        let event = AgentStateChanged {
            actor,
            receipt: receipt.clone(),
        };
        if let Err(error) = app.emit(AGENT_EVENT_NAME, event) {
            eprintln!("[shadowencoder-agent] GUI 事件发送失败: {error}");
        }
    }
    write_response(reader.get_mut(), &response)
}

fn write_response<W: Write>(writer: &mut W, response: &AgentResponse) -> Result<(), String> {
    let mut payload =
        serde_json::to_vec(response).map_err(|error| format!("序列化响应失败: {error}"))?;
    if payload.len() > MAX_MESSAGE_BYTES {
        payload = serde_json::to_vec(&AgentResponse::failure(
            &response.request_id,
            error_code::VALIDATION_ERROR,
            "IPC 响应超过 1 MiB 限制，请缩小查询范围",
        ))
        .map_err(|error| format!("序列化超限响应失败: {error}"))?;
    }
    writer
        .write_all(&payload)
        .and_then(|_| writer.write_all(b"\n"))
        .and_then(|_| writer.flush())
        .map_err(|error| format!("写入响应失败: {error}"))
}
