//! libmpv 播放与帧提取层。
//!
//! Windows and Linux render directly into native GPU surfaces. The legacy
//! screenshot bridge remains available only for platforms without a native
//! presentation implementation.

use base64::{engine::general_purpose::STANDARD, Engine as _};
use libmpv2::Mpv;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::ffi::{CStr, CString};
use std::ptr;
use std::sync::{
    mpsc::{self, Receiver, RecvTimeoutError, Sender, SyncSender},
    Mutex,
};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tauri::State;

#[cfg(target_os = "linux")]
use crate::mpv_gpu::{NativeGpuState, SurfaceConfig};
#[cfg(target_os = "windows")]
use crate::mpv_windows::{NativeGpuState, SelectionOverlayUpdate, SurfaceConfig};

#[cfg(target_os = "windows")]
const SELECTION_OVERLAY_ID: &str = "9173";

const DEFAULT_FRAME_WIDTH: i32 = 960;
const MIN_FRAME_WIDTH: i32 = 320;
const MAX_FRAME_WIDTH: i32 = 1280;
const LOAD_READY_TIMEOUT: Duration = Duration::from_secs(15);
const LOAD_IDLE_GRACE: Duration = Duration::from_millis(500);

/// 每个 VideoPlayer 实例对应一个 worker；mpv 本身仍由各自的 worker 线程独占。
pub struct MpvState {
    inner: Mutex<HashMap<String, PlayerWorker>>,
    #[cfg(any(target_os = "linux", target_os = "windows"))]
    native: NativeGpuState,
}

struct PlayerWorker {
    tx: Sender<WorkerRequest>,
    #[cfg(target_os = "windows")]
    selection_tx: Sender<SelectionOverlayUpdate>,
    join: Option<JoinHandle<()>>,
}

struct WorkerRequest {
    operation: PlayerOperation,
    reply: SyncSender<Result<PlayerReply, String>>,
}

enum PlayerOperation {
    Load(String),
    Play,
    Pause,
    Toggle,
    Seek(f64),
    Step(FrameDirection),
    SetVolume(f64),
    Status,
    Frame(i32),
    Shutdown,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum FrameDirection {
    Backward,
    Forward,
}

impl FrameDirection {
    pub(crate) fn mpv_command(self) -> &'static str {
        match self {
            Self::Backward => "frame-back-step",
            Self::Forward => "frame-step",
        }
    }
}

enum PlayerReply {
    Unit,
    Toggled(bool),
    Status(PlayerStatus),
    Frame(Option<PlayerFrame>),
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerStatus {
    pub available: bool,
    pub ready: bool,
    pub path: String,
    pub pause: bool,
    pub time_pos: f64,
    pub duration: f64,
    pub width: i64,
    pub height: i64,
    /// Encoded frame dimensions before display-matrix rotation.
    pub source_width: i64,
    pub source_height: i64,
    pub eof: bool,
    /// `gpu` means libmpv is rendering directly into the native GTK GL surface.
    pub renderer: String,
    /// Runtime libmpv hardware decoder selection, e.g. `vaapi`.
    pub hwdec: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerFrame {
    width: u32,
    height: u32,
    /// 应用显示旋转后的源视频尺寸；width/height 是 JSON bridge 使用的缩放帧尺寸。
    source_width: u32,
    source_height: u32,
    /// Packed RGBA bytes, encoded to keep the Tauri JSON bridge compact.
    data: String,
}

impl Default for MpvState {
    fn default() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
            #[cfg(any(target_os = "linux", target_os = "windows"))]
            native: NativeGpuState::default(),
        }
    }
}

impl Drop for MpvState {
    fn drop(&mut self) {
        let workers = self
            .inner
            .get_mut()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .drain()
            .map(|(_, worker)| worker)
            .collect::<Vec<_>>();
        for worker in workers {
            worker.shutdown();
        }
    }
}

impl MpvState {
    #[cfg(target_os = "windows")]
    pub fn install_gpu_surface(&self, window: tauri::WebviewWindow) -> Result<(), String> {
        self.native.install(window)
    }

    #[cfg(target_os = "windows")]
    pub fn run_gpu_smoke(&self, path: String) {
        let native = self.native.clone();
        std::thread::spawn(move || {
            // setup() runs before the Windows message loop is fully pumping.
            // Match real player creation timing instead of racing WebView startup.
            thread::sleep(Duration::from_millis(750));
            let result = run_windows_gpu_smoke(native, path);
            match &result {
                Ok(status) => eprintln!(
                    "[shadowencoder-mpv] GPU_SMOKE_PASS renderer={} hwdec={} size={}x{} time={:.3}",
                    status.renderer, status.hwdec, status.width, status.height, status.time_pos
                ),
                Err(error) => eprintln!("[shadowencoder-mpv] GPU_SMOKE_FAIL {error}"),
            }
            if std::env::var_os("SHADOWENCODER_MPV_GPU_SMOKE_EXIT").is_some() {
                std::process::exit(if result.is_ok() { 0 } else { 1 });
            }
        });
    }

    #[cfg(target_os = "linux")]
    pub fn install_gpu_surface<R: tauri::Runtime>(
        &self,
        window: tauri::WebviewWindow<R>,
    ) -> Result<(), String> {
        self.native.install(window)
    }

    #[cfg(target_os = "linux")]
    pub fn run_gpu_smoke(&self, path: String) {
        let native = self.native.clone();
        std::thread::spawn(move || match native.smoke(path) {
            Ok(status) => eprintln!(
                "[shadowencoder-mpv] GPU smoke passed: renderer={} hwdec={} size={}x{}",
                status.renderer, status.hwdec, status.width, status.height
            ),
            Err(error) => eprintln!("[shadowencoder-mpv] GPU smoke failed: {error}"),
        });
    }
}

#[cfg(target_os = "windows")]
fn run_windows_gpu_smoke(native: NativeGpuState, path: String) -> Result<PlayerStatus, String> {
    let player_id = format!("gpu-smoke-{}", std::process::id());
    let hwnd = native.init(player_id.clone())?;
    if let Err(error) = native.set_surface(
        player_id.clone(),
        SurfaceConfig {
            x: -4096.0,
            y: -4096.0,
            width: 64.0,
            height: 64.0,
            visible: true,
            crop: None,
            selection_enabled: true,
            selection_locked: false,
            aspect_ratio: None,
            accent_color: None,
        },
    ) {
        let _ = native.destroy(&player_id);
        return Err(error);
    }
    let worker = match spawn_player(Some(hwnd)) {
        Ok(worker) => worker,
        Err(error) => {
            let _ = native.destroy(&player_id);
            return Err(error);
        }
    };
    if let Err(error) = native.attach_selection_overlay(&player_id, worker.selection_sender()) {
        worker.shutdown();
        let _ = native.destroy(&player_id);
        return Err(error);
    }
    let selection = match native.smoke_selection(&player_id) {
        Ok(selection) => selection,
        Err(error) => {
            worker.shutdown();
            let _ = native.destroy(&player_id);
            return Err(error);
        }
    };
    eprintln!(
        "[shadowencoder-mpv] GPU_SELECTION_PASS rect={},{},{},{}",
        selection.0, selection.1, selection.2, selection.3
    );
    let result = (|| {
        let loaded = match worker.request(PlayerOperation::Load(path))? {
            PlayerReply::Status(status) => status,
            _ => return Err("GPU smoke load returned an invalid reply".into()),
        };
        if !loaded.ready || loaded.renderer != "gpu" {
            return Err(format!(
                "GPU smoke media was not ready: renderer={} size={}x{}",
                loaded.renderer, loaded.width, loaded.height
            ));
        }
        if !matches!(worker.request(PlayerOperation::Play)?, PlayerReply::Unit) {
            return Err("GPU smoke play returned an invalid reply".into());
        }

        let deadline = Instant::now() + Duration::from_secs(10);
        let playing = loop {
            let status = match worker.request(PlayerOperation::Status)? {
                PlayerReply::Status(status) => status,
                _ => return Err("GPU smoke status returned an invalid reply".into()),
            };
            if status.time_pos >= 0.15 && !status.hwdec.is_empty() {
                break status;
            }
            if Instant::now() >= deadline {
                return Err(format!(
                    "GPU smoke did not advance with hardware decode: time={:.3} hwdec={}",
                    status.time_pos, status.hwdec
                ));
            }
            thread::sleep(Duration::from_millis(50));
        };

        if !matches!(worker.request(PlayerOperation::Pause)?, PlayerReply::Unit) {
            return Err("GPU smoke pause returned an invalid reply".into());
        }
        if !matches!(
            worker.request(PlayerOperation::Seek(1.0))?,
            PlayerReply::Unit
        ) {
            return Err("GPU smoke seek returned an invalid reply".into());
        }
        Ok(playing)
    })();

    worker.shutdown();
    let cleanup = native.destroy(&player_id);
    match (result, cleanup) {
        (Ok(status), Ok(())) => Ok(status),
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error),
    }
}

impl PlayerWorker {
    fn request(&self, operation: PlayerOperation) -> Result<PlayerReply, String> {
        Self::request_on_sender(&self.tx, operation)
    }

    fn request_on_sender(
        sender: &Sender<WorkerRequest>,
        operation: PlayerOperation,
    ) -> Result<PlayerReply, String> {
        let (reply_tx, reply_rx) = mpsc::sync_channel(1);
        sender
            .send(WorkerRequest {
                operation,
                reply: reply_tx,
            })
            .map_err(|_| "libmpv 播放线程已退出".to_string())?;
        reply_rx
            .recv()
            .map_err(|_| "libmpv 播放线程没有返回结果".to_string())?
    }

    fn shutdown(mut self) {
        let _ = self.request(PlayerOperation::Shutdown);
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }

    #[cfg(target_os = "windows")]
    fn selection_sender(&self) -> Sender<SelectionOverlayUpdate> {
        self.selection_tx.clone()
    }
}

fn ensure_c_locale() {
    // libmpv 要求 LC_NUMERIC=C。
    unsafe {
        let locale = std::ffi::CString::new("C").unwrap();
        libc::setlocale(libc::LC_NUMERIC, locale.as_ptr());
    }
}

fn debug_log(message: impl AsRef<str>) {
    if std::env::var_os("SHADOWENCODER_MPV_DEBUG").is_some() {
        eprintln!("[shadowencoder-mpv] {}", message.as_ref());
    }
}

fn create_mpv(#[cfg(target_os = "windows")] window_id: Option<isize>) -> Result<Mpv, String> {
    ensure_c_locale();
    #[cfg(target_os = "windows")]
    let gpu = window_id.is_some();
    Mpv::with_initializer(|init| {
        #[cfg(target_os = "windows")]
        if let Some(window_id) = window_id {
            init.set_property("wid", window_id as i64)?;
            init.set_property("vo", "gpu-next")?;
            init.set_property("gpu-api", "d3d11")?;
            init.set_property("hwdec", "auto-safe")?;
            init.set_property("hwdec-codecs", "all")?;
            init.set_property("video-sync", "display-resample")?;
            init.set_property("interpolation", true)?;
            init.set_property("tscale", "oversample")?;
            init.set_property("scale", "spline36")?;
            init.set_property("cscale", "spline36")?;
            init.set_property("dscale", "mitchell")?;
            init.set_property("correct-downscaling", true)?;
        } else {
            init.set_property("vo", "null")?;
            init.set_property("hwdec", "no")?;
        }
        #[cfg(not(target_os = "windows"))]
        {
            // Platforms without a native surface retain the compatibility bridge.
            init.set_property("vo", "null")?;
            init.set_property("hwdec", "no")?;
        }
        init.set_property("keep-open", "yes")?;
        init.set_property("idle", "yes")?;
        init.set_property("osc", false)?;
        init.set_property("input-default-bindings", false)?;
        init.set_property("input-vo-keyboard", false)?;
        init.set_property("terminal", false)?;
        init.set_property("msg-level", "all=error")?;
        init.set_property("pause", true)?;
        #[cfg(target_os = "windows")]
        debug_log(format!("create mpv gpu={gpu}"));
        Ok(())
    })
    .map_err(|e| format!("创建 libmpv 失败: {e}"))
}

struct RawFrame {
    width: u32,
    height: u32,
    rgba: Vec<u8>,
}

fn screenshot_frame(mpv: &Mpv) -> Result<Option<RawFrame>, String> {
    let command = [
        CString::new("screenshot-raw").unwrap(),
        CString::new("video").unwrap(),
        CString::new("rgba").unwrap(),
    ];
    let mut args = command
        .iter()
        .map(|value| value.as_ptr())
        .collect::<Vec<_>>();
    args.push(ptr::null());
    let mut result = std::mem::MaybeUninit::<libmpv2_sys::mpv_node>::zeroed();
    let code = unsafe {
        libmpv2_sys::mpv_command_ret(mpv.ctx.as_ptr(), args.as_mut_ptr(), result.as_mut_ptr())
    };
    if code != 0 {
        // Media metadata can be visible before the first decoded frame reaches
        // the VO. Treat that transient state as "not ready" instead of a hard
        // preview failure.
        if matches!(
            code,
            libmpv2::mpv_error::PropertyUnavailable | libmpv2::mpv_error::Command
        ) {
            debug_log(format!("screenshot frame not ready: {code}"));
            return Ok(None);
        }
        return Err(format!("libmpv screenshot-raw 失败: {code}"));
    }

    let mut result = unsafe { result.assume_init() };
    let frame = unsafe { parse_screenshot_raw(&result) };
    unsafe {
        libmpv2_sys::mpv_free_node_contents(&mut result);
    }
    frame.map(Some)
}

unsafe fn parse_screenshot_raw(result: &libmpv2_sys::mpv_node) -> Result<RawFrame, String> {
    if result.format != libmpv2_sys::mpv_format_MPV_FORMAT_NODE_MAP {
        return Err("libmpv screenshot-raw 未返回节点映射".into());
    }
    let map = result.u.list;
    if map.is_null() || (*map).num < 0 {
        return Err("libmpv screenshot-raw 返回了无效映射".into());
    }
    let count = (*map).num as usize;
    if count == 0 || (*map).keys.is_null() || (*map).values.is_null() {
        return Err("libmpv screenshot-raw 映射缺少数据".into());
    }
    let keys = std::slice::from_raw_parts((*map).keys, count);
    let values = std::slice::from_raw_parts((*map).values, count);
    let mut width = None;
    let mut height = None;
    let mut stride = None;
    let mut format = None;
    let mut data = None;

    for (key, value) in keys.iter().zip(values.iter()) {
        if key.is_null() {
            continue;
        }
        let Ok(key) = CStr::from_ptr(*key).to_str() else {
            continue;
        };
        match key {
            "w" if value.format == libmpv2_sys::mpv_format_MPV_FORMAT_INT64 => {
                width = u32::try_from(value.u.int64).ok();
            }
            "h" if value.format == libmpv2_sys::mpv_format_MPV_FORMAT_INT64 => {
                height = u32::try_from(value.u.int64).ok();
            }
            "stride" if value.format == libmpv2_sys::mpv_format_MPV_FORMAT_INT64 => {
                stride = usize::try_from(value.u.int64).ok();
            }
            "format" if value.format == libmpv2_sys::mpv_format_MPV_FORMAT_STRING => {
                let value = value.u.string;
                if !value.is_null() {
                    format = CStr::from_ptr(value).to_str().ok().map(str::to_owned);
                }
            }
            "data" if value.format == libmpv2_sys::mpv_format_MPV_FORMAT_BYTE_ARRAY => {
                let bytes = value.u.ba;
                if !bytes.is_null() && !(*bytes).data.is_null() {
                    data = Some(std::slice::from_raw_parts(
                        (*bytes).data.cast::<u8>(),
                        (*bytes).size,
                    ));
                }
            }
            _ => {}
        }
    }

    let width = width
        .filter(|value| *value > 0)
        .ok_or("libmpv 帧宽度无效")?;
    let height = height
        .filter(|value| *value > 0)
        .ok_or("libmpv 帧高度无效")?;
    let packed_stride = (width as usize).checked_mul(4).ok_or("libmpv 帧宽度溢出")?;
    let stride = stride
        .filter(|value| *value >= packed_stride)
        .ok_or("libmpv 帧步长无效")?;
    let required = stride
        .checked_mul(height as usize)
        .ok_or("libmpv 帧缓冲区大小溢出")?;
    let data = data
        .filter(|value| value.len() >= required)
        .ok_or("libmpv 帧数据不完整")?;
    if format.as_deref() != Some("rgba") {
        return Err(format!(
            "libmpv screenshot-raw 返回了不支持的像素格式: {}",
            format.unwrap_or_else(|| "未知".into())
        ));
    }

    let mut rgba = Vec::with_capacity(
        packed_stride
            .checked_mul(height as usize)
            .ok_or("libmpv RGBA 帧大小溢出")?,
    );
    for row in data.chunks_exact(stride).take(height as usize) {
        rgba.extend_from_slice(&row[..packed_stride]);
    }
    Ok(RawFrame {
        width,
        height,
        rgba,
    })
}

fn to_player_frame(raw: RawFrame, max_width: i32) -> Result<PlayerFrame, String> {
    let max_width = max_width.clamp(MIN_FRAME_WIDTH, MAX_FRAME_WIDTH) as u32;
    let target_width = raw.width.min(max_width).max(1);
    let target_height = ((raw.height as u64 * target_width as u64 + raw.width as u64 / 2)
        / raw.width as u64)
        .max(1) as u32;
    let rgba = if raw.width == target_width && raw.height == target_height {
        raw.rgba
    } else {
        scale_rgba_nearest(&raw, target_width, target_height)?
    };
    Ok(PlayerFrame {
        width: target_width,
        height: target_height,
        source_width: raw.width,
        source_height: raw.height,
        data: STANDARD.encode(rgba),
    })
}

fn scale_rgba_nearest(
    raw: &RawFrame,
    target_width: u32,
    target_height: u32,
) -> Result<Vec<u8>, String> {
    let target_len = (target_width as usize)
        .checked_mul(target_height as usize)
        .and_then(|value| value.checked_mul(4))
        .ok_or("缩放后 RGBA 帧大小溢出")?;
    let mut scaled = vec![0; target_len];
    for target_y in 0..target_height as usize {
        let source_y = target_y * raw.height as usize / target_height as usize;
        for target_x in 0..target_width as usize {
            let source_x = target_x * raw.width as usize / target_width as usize;
            let source_offset = (source_y * raw.width as usize + source_x) * 4;
            let target_offset = (target_y * target_width as usize + target_x) * 4;
            scaled[target_offset..target_offset + 4]
                .copy_from_slice(&raw.rgba[source_offset..source_offset + 4]);
        }
    }
    Ok(scaled)
}

fn spawn_player(
    #[cfg(target_os = "windows")] window_id: Option<isize>,
) -> Result<PlayerWorker, String> {
    let (ready_tx, ready_rx) = mpsc::sync_channel(1);
    let (request_tx, request_rx) = mpsc::channel();
    #[cfg(target_os = "windows")]
    let (selection_tx, selection_rx) = mpsc::channel();
    let join = thread::Builder::new()
        .name("shadowencoder-mpv".into())
        .spawn(move || {
            #[cfg(target_os = "windows")]
            let gpu = window_id.is_some();
            #[cfg(not(target_os = "windows"))]
            let gpu = false;
            let mut mpv = match create_mpv(
                #[cfg(target_os = "windows")]
                window_id,
            ) {
                Ok(value) => value,
                Err(error) => {
                    let _ = ready_tx.send(Err(error));
                    return;
                }
            };
            if ready_tx.send(Ok(())).is_err() {
                return;
            }
            run_worker(
                &mut mpv,
                request_rx,
                gpu,
                #[cfg(target_os = "windows")]
                selection_rx,
            );
        })
        .map_err(|e| format!("启动 libmpv 播放线程失败: {e}"))?;

    match ready_rx
        .recv()
        .map_err(|_| "libmpv 播放线程未完成初始化".to_string())?
    {
        Ok(()) => Ok(PlayerWorker {
            tx: request_tx,
            #[cfg(target_os = "windows")]
            selection_tx,
            join: Some(join),
        }),
        Err(error) => {
            let _ = join.join();
            Err(error)
        }
    }
}

fn run_worker(
    mpv: &mut Mpv,
    rx: Receiver<WorkerRequest>,
    gpu: bool,
    #[cfg(target_os = "windows")] selection_rx: Receiver<SelectionOverlayUpdate>,
) {
    let mut path = String::new();
    loop {
        let mut shutdown = false;
        match rx.recv_timeout(Duration::from_millis(8)) {
            Ok(request) => {
                shutdown = matches!(request.operation, PlayerOperation::Shutdown);
                let result = handle_operation(mpv, &mut path, request.operation, gpu);
                let _ = request.reply.send(result);
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
        #[cfg(target_os = "windows")]
        if gpu {
            let mut latest = None;
            while let Ok(update) = selection_rx.try_recv() {
                latest = Some(update);
            }
            if let Some(update) = latest {
                if let Err(error) = render_selection_overlay(mpv, update) {
                    debug_log(format!("selection overlay failed: {error}"));
                }
            }
        }
        if shutdown {
            #[cfg(target_os = "windows")]
            if gpu {
                let _ = clear_selection_overlay(mpv);
            }
            break;
        }
    }
}

#[cfg(target_os = "windows")]
fn selection_to_ass(update: SelectionOverlayUpdate) -> Option<String> {
    if update.width <= 0
        || update.height <= 0
        || update.surface_width <= 0
        || update.surface_height <= 0
    {
        return None;
    }
    let left = update.x.clamp(0, update.surface_width);
    let top = update.y.clamp(0, update.surface_height);
    let right = (update.x + update.width).clamp(left, update.surface_width);
    let bottom = (update.y + update.height).clamp(top, update.surface_height);
    if right <= left || bottom <= top {
        return None;
    }
    let stroke = 2;
    let handle = 10;
    let half = handle / 2;
    let mut parts = vec![
        (left, top, right, (top + stroke).min(bottom)),
        (left, (bottom - stroke).max(top), right, bottom),
        (left, top, (left + stroke).min(right), bottom),
        ((right - stroke).max(left), top, right, bottom),
    ];
    if !update.locked {
        for (x, y) in [(left, top), (right, top), (left, bottom), (right, bottom)] {
            parts.push((
                (x - half).clamp(0, update.surface_width),
                (y - half).clamp(0, update.surface_height),
                (x + half).clamp(0, update.surface_width),
                (y + half).clamp(0, update.surface_height),
            ));
        }
    }
    let drawing = parts
        .into_iter()
        .filter(|(x1, y1, x2, y2)| x2 > x1 && y2 > y1)
        .map(|(x1, y1, x2, y2)| format!("m {x1} {y1} l {x2} {y1} {x2} {y2} {x1} {y2}"))
        .collect::<Vec<_>>()
        .join(" ");
    let fill = format!("m {left} {top} l {right} {top} {right} {bottom} {left} {bottom}");
    let accent_bgr = if update.accent_bgr == 0 {
        0x00cf9ca8
    } else {
        update.accent_bgr & 0x00ffffff
    };
    Some(format!(
        "{{\\an7\\pos(0,0)\\bord0\\shad0\\1c&H{accent_bgr:06X}&\\alpha&HD9&\\p1}}{fill}{{\\p0}}\n{{\\an7\\pos(0,0)\\bord0\\shad0\\1c&H{accent_bgr:06X}&\\alpha&H00&\\p1}}{drawing}{{\\p0}}"
    ))
}

#[cfg(target_os = "windows")]
fn clear_selection_overlay(mpv: &Mpv) -> Result<(), String> {
    mpv.command(
        "osd-overlay",
        &[SELECTION_OVERLAY_ID, "none", "", "0", "0", "0"],
    )
    .map_err(map_mpv_error)
}

#[cfg(target_os = "windows")]
fn render_selection_overlay(mpv: &Mpv, update: SelectionOverlayUpdate) -> Result<(), String> {
    let Some(ass) = selection_to_ass(update) else {
        return clear_selection_overlay(mpv);
    };
    let width = update.surface_width.to_string();
    let height = update.surface_height.to_string();
    mpv.command(
        "osd-overlay",
        &[
            SELECTION_OVERLAY_ID,
            "ass-events",
            &ass,
            &width,
            &height,
            "1000",
        ],
    )
    .map_err(map_mpv_error)
}

fn handle_operation(
    mpv: &mut Mpv,
    path: &mut String,
    operation: PlayerOperation,
    gpu: bool,
) -> Result<PlayerReply, String> {
    match operation {
        PlayerOperation::Load(next_path) => {
            debug_log(format!("load path={next_path}"));
            if !next_path.trim().is_empty() && media_paths_match(path, &next_path) {
                let status = status_of(mpv, path, gpu)?;
                if status.ready {
                    debug_log("load reused current media");
                    return Ok(PlayerReply::Status(status));
                }
            }
            if next_path.trim().is_empty() {
                mpv.command("stop", &[]).map_err(map_mpv_error)?;
                path.clear();
            } else {
                // `loadfile replace` can leave the previous file's dimensions
                // readable for a short interval. Clear that state first so a
                // media switch cannot report the old layout as ready.
                mpv.command("stop", &[]).map_err(map_mpv_error)?;
                let stop_started = Instant::now();
                while stop_started.elapsed() < LOAD_IDLE_GRACE {
                    let stopped_path = status_property(mpv.get_property("path"), String::new())?;
                    let idle = status_property(mpv.get_property("idle-active"), false)?;
                    if stopped_path.is_empty() && idle {
                        break;
                    }
                    thread::sleep(Duration::from_millis(10));
                }
                mpv.command("loadfile", &[&next_path, "replace"])
                    .map_err(map_mpv_error)?;
                mpv.set_property("pause", true).map_err(map_mpv_error)?;
                *path = next_path;
            }
            let started = Instant::now();
            let mut stable_size = None;
            let mut stable_size_samples = 0_u8;
            loop {
                let status = status_of(mpv, path, gpu)?;
                let loaded_path = status_property(mpv.get_property("path"), String::new())?;
                let loaded_target = path.is_empty() || media_paths_match(&loaded_path, path);
                if status.ready && loaded_target {
                    let size = (status.width, status.height);
                    if stable_size == Some(size) {
                        stable_size_samples = stable_size_samples.saturating_add(1);
                    } else {
                        stable_size = Some(size);
                        stable_size_samples = 1;
                    }
                } else {
                    stable_size = None;
                    stable_size_samples = 0;
                }
                if (status.ready && loaded_target && stable_size_samples >= 3) || path.is_empty() {
                    debug_log(format!(
                        "load status ready={} size={}x{} duration={} hwdec={}",
                        status.ready, status.width, status.height, status.duration, status.hwdec
                    ));
                    return Ok(PlayerReply::Status(status));
                }
                let idle = status_property(mpv.get_property("idle-active"), false)?;
                if idle && started.elapsed() >= LOAD_IDLE_GRACE {
                    return Err("mpv 无法打开该媒体或没有可解码的视频轨道".into());
                }
                if started.elapsed() >= LOAD_READY_TIMEOUT {
                    return Err(format!(
                        "mpv 在 {} 秒内未能读取视频元数据",
                        LOAD_READY_TIMEOUT.as_secs()
                    ));
                }
                thread::sleep(Duration::from_millis(20));
            }
        }
        PlayerOperation::Play => {
            mpv.set_property("pause", false).map_err(map_mpv_error)?;
            Ok(PlayerReply::Unit)
        }
        PlayerOperation::Pause => {
            mpv.set_property("pause", true).map_err(map_mpv_error)?;
            Ok(PlayerReply::Unit)
        }
        PlayerOperation::Toggle => {
            let paused: bool = mpv.get_property("pause").map_err(map_mpv_error)?;
            let next = !paused;
            mpv.set_property("pause", next).map_err(map_mpv_error)?;
            Ok(PlayerReply::Toggled(next))
        }
        PlayerOperation::Seek(time_sec) => {
            if !time_sec.is_finite() {
                return Err("seek 时间必须是有限数值".into());
            }
            let time_sec = time_sec.max(0.0);
            mpv.command("seek", &[&format!("{time_sec}"), "absolute"])
                .map_err(map_mpv_error)?;
            Ok(PlayerReply::Unit)
        }
        PlayerOperation::Step(direction) => {
            mpv.set_property("pause", true).map_err(map_mpv_error)?;
            mpv.command(direction.mpv_command(), &[])
                .map_err(map_mpv_error)?;
            Ok(PlayerReply::Unit)
        }
        PlayerOperation::SetVolume(volume) => {
            if !volume.is_finite() {
                return Err("音量必须是有限数值".into());
            }
            mpv.set_property("volume", volume.clamp(0.0, 100.0))
                .map_err(map_mpv_error)?;
            Ok(PlayerReply::Unit)
        }
        PlayerOperation::Status => Ok(PlayerReply::Status(status_of(mpv, path, gpu)?)),
        PlayerOperation::Frame(max_width) => {
            if gpu {
                return Ok(PlayerReply::Frame(None));
            }
            let Some((source_width, source_height)) = source_dimensions(mpv)? else {
                debug_log("frame unavailable: source dimensions are not ready");
                return Ok(PlayerReply::Frame(None));
            };
            debug_log(format!(
                "screenshot request source={}x{} max_width={max_width}",
                source_width, source_height
            ));
            let Some(raw) = screenshot_frame(mpv)? else {
                return Ok(PlayerReply::Frame(None));
            };
            // screenshot-raw 已经应用显示旋转。裁剪层和 ffmpeg 的默认 autorotate
            // 都使用该显示坐标系，不能再传入编码前的 width/height。
            let frame = to_player_frame(raw, max_width)?;
            debug_log(format!(
                "frame size={}x{} data={}",
                frame.width,
                frame.height,
                frame.data.len()
            ));
            Ok(PlayerReply::Frame(Some(frame)))
        }
        PlayerOperation::Shutdown => Ok(PlayerReply::Unit),
    }
}

pub(crate) fn media_paths_match(left: &str, right: &str) -> bool {
    #[cfg(target_os = "windows")]
    {
        left.replace('\\', "/")
            .eq_ignore_ascii_case(&right.replace('\\', "/"))
    }
    #[cfg(not(target_os = "windows"))]
    {
        left == right
    }
}

fn map_mpv_error(error: libmpv2::Error) -> String {
    format!("mpv: {error}")
}

fn status_property<T>(value: libmpv2::Result<T>, fallback: T) -> Result<T, String> {
    match value {
        Ok(value) => Ok(value),
        // These properties are legitimately unavailable before mpv has decoded
        // metadata. Preserve that as a not-ready status, but do not mask other
        // libmpv failures as a valid playback state.
        Err(libmpv2::Error::Raw(code)) if code == libmpv2::mpv_error::PropertyUnavailable => {
            Ok(fallback)
        }
        Err(error) => Err(map_mpv_error(error)),
    }
}

pub(crate) fn rotated_dimensions(width: i64, height: i64, rotation: i64) -> (i64, i64) {
    if rotation.rem_euclid(180) == 90 {
        (height, width)
    } else {
        (width, height)
    }
}

fn normalized_display_dimensions(
    encoded_width: i64,
    encoded_height: i64,
    display_width: i64,
    display_height: i64,
    rotation: i64,
) -> (i64, i64) {
    if display_width <= 0 || display_height <= 0 {
        return rotated_dimensions(encoded_width, encoded_height, rotation);
    }
    if rotation.rem_euclid(180) == 90 {
        // mpv rotates dwidth/dheight for software output, but a Win32 wid can
        // expose the unrotated VO dimensions. Normalize both forms once.
        let encoded_landscape = encoded_width >= encoded_height;
        let display_landscape = display_width >= display_height;
        if encoded_landscape == display_landscape {
            return (display_height, display_width);
        }
    }
    (display_width, display_height)
}

fn display_dimensions(mpv: &Mpv) -> Result<(i64, i64), String> {
    let encoded_width = status_property(mpv.get_property("width"), 0_i64)?;
    let encoded_height = status_property(mpv.get_property("height"), 0_i64)?;
    let width = status_property(mpv.get_property("dwidth"), 0_i64)?;
    let height = status_property(mpv.get_property("dheight"), 0_i64)?;
    let rotation = status_property(mpv.get_property("video-out-params/rotate"), 0_i64)?;
    Ok(normalized_display_dimensions(
        encoded_width,
        encoded_height,
        width,
        height,
        rotation,
    ))
}

fn status_of(mpv: &Mpv, path: &str, gpu: bool) -> Result<PlayerStatus, String> {
    let pause = status_property(mpv.get_property("pause"), true)?;
    let time_pos = status_property(mpv.get_property("time-pos"), 0.0)?;
    let duration = status_property(mpv.get_property("duration"), 0.0)?;
    let source_width = status_property(mpv.get_property("width"), 0_i64)?;
    let source_height = status_property(mpv.get_property("height"), 0_i64)?;
    // The native surface and crop editor use mpv's final display coordinates.
    let (width, height) = display_dimensions(mpv)?;
    let eof = status_property(mpv.get_property("eof-reached"), false)?;
    let hwdec = if gpu {
        status_property(mpv.get_property("hwdec-current"), String::new())?
    } else {
        String::new()
    };
    Ok(PlayerStatus {
        available: true,
        ready: !path.is_empty() && width > 0 && height > 0,
        path: path.to_string(),
        pause,
        time_pos: if time_pos.is_finite() {
            time_pos.max(0.0)
        } else {
            0.0
        },
        duration: if duration.is_finite() {
            duration.max(0.0)
        } else {
            0.0
        },
        width,
        height,
        source_width,
        source_height,
        eof,
        renderer: if gpu { "gpu" } else { "cpu-bridge" }.into(),
        hwdec,
    })
}

fn source_dimensions(mpv: &Mpv) -> Result<Option<(u32, u32)>, String> {
    // This helper runs exclusively on the core worker. In particular, do not
    // move these get_property calls into SoftwareRenderContext::render_frame.
    let (width, height) = display_dimensions(mpv)?;
    if width <= 0 || height <= 0 {
        return Ok(None);
    }
    let width = u32::try_from(width).map_err(|_| format!("libmpv 返回了无效视频宽度: {width}"))?;
    let height =
        u32::try_from(height).map_err(|_| format!("libmpv 返回了无效视频高度: {height}"))?;
    Ok(Some((width, height)))
}

fn empty_status() -> PlayerStatus {
    PlayerStatus {
        available: false,
        ready: false,
        path: String::new(),
        pause: true,
        time_pos: 0.0,
        duration: 0.0,
        width: 0,
        height: 0,
        source_width: 0,
        source_height: 0,
        eof: false,
        renderer: "none".into(),
        hwdec: String::new(),
    }
}

fn request_worker(
    state: State<'_, MpvState>,
    player_id: &str,
    operation: PlayerOperation,
) -> Result<PlayerReply, String> {
    let sender = {
        let guard = state.inner.lock().map_err(|e| e.to_string())?;
        guard
            .get(player_id)
            .ok_or_else(|| "播放器未初始化".to_string())?
            .tx
            .clone()
    };
    PlayerWorker::request_on_sender(&sender, operation)
}

fn status_reply(reply: PlayerReply) -> Result<PlayerStatus, String> {
    match reply {
        PlayerReply::Status(status) => Ok(status),
        _ => Err("libmpv 返回了无效的状态结果".into()),
    }
}

#[tauri::command]
pub async fn player_init(
    state: State<'_, MpvState>,
    player_id: String,
) -> Result<PlayerStatus, String> {
    if player_id.trim().is_empty() {
        return Err("播放器实例 ID 不能为空".into());
    }
    #[cfg(target_os = "linux")]
    {
        let native = state.native.clone();
        let id = player_id.clone();
        if let Some(status) = run_off_main_thread(move || native.init(id)).await? {
            return Ok(status);
        }
        // On Linux the old screenshot/Base64 bridge is deliberately not a
        // fallback: it turns a 4K frame into a multi-megabyte CPU/IPC copy.
        // Let the frontend use its documented WebView/Blob fallback instead.
        return Err("Linux 原生 GPU 播放器不可用，正在切换 WebView 回退".into());
    }
    #[cfg(target_os = "windows")]
    {
        debug_log(format!("init Windows GPU player_id={player_id}"));
        let previous = {
            let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
            guard.remove(&player_id)
        };
        if let Some(worker) = previous {
            worker.shutdown();
        }
        let hwnd = state.native.init(player_id.clone())?;
        let worker = match spawn_player(Some(hwnd)) {
            Ok(worker) => worker,
            Err(error) => {
                let _ = state.native.destroy(&player_id);
                return Err(error);
            }
        };
        if let Err(error) = state
            .native
            .attach_selection_overlay(&player_id, worker.selection_sender())
        {
            worker.shutdown();
            let _ = state.native.destroy(&player_id);
            return Err(error);
        }
        state
            .inner
            .lock()
            .map_err(|e| e.to_string())?
            .insert(player_id, worker);
        debug_log("Windows GPU init complete");
        return Ok(PlayerStatus {
            available: true,
            ready: false,
            path: String::new(),
            pause: true,
            time_pos: 0.0,
            duration: 0.0,
            width: 0,
            height: 0,
            source_width: 0,
            source_height: 0,
            eof: false,
            renderer: "gpu".into(),
            hwdec: String::new(),
        });
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    {
        debug_log(format!("init player_id={player_id}"));
        let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
        if let Some(worker) = guard.remove(&player_id) {
            worker.shutdown();
        }
        let worker = spawn_player()?;
        guard.insert(player_id, worker);
        debug_log("init complete");
        Ok(PlayerStatus {
            available: true,
            ready: false,
            path: String::new(),
            pause: true,
            time_pos: 0.0,
            duration: 0.0,
            width: 0,
            height: 0,
            source_width: 0,
            source_height: 0,
            eof: false,
            renderer: "cpu-bridge".into(),
            hwdec: String::new(),
        })
    }
}

#[tauri::command]
pub async fn player_destroy(state: State<'_, MpvState>, player_id: String) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let native = state.native.clone();
        let id = player_id.clone();
        if run_off_main_thread(move || native.destroy(id))
            .await?
            .is_some()
        {
            return Ok(());
        }
    }
    debug_log(format!("destroy player_id={player_id}"));
    let worker = {
        let mut guard = state.inner.lock().map_err(|e| e.to_string())?;
        guard.remove(&player_id)
    };
    if let Some(worker) = worker {
        worker.shutdown();
    }
    #[cfg(target_os = "windows")]
    state.native.destroy(&player_id)?;
    Ok(())
}

#[tauri::command]
pub async fn player_load(
    state: State<'_, MpvState>,
    player_id: String,
    path: String,
) -> Result<PlayerStatus, String> {
    #[cfg(target_os = "linux")]
    {
        let native = state.native.clone();
        let id = player_id.clone();
        let native_path = path.clone();
        if let Some(status) = run_off_main_thread(move || native.load(id, native_path)).await? {
            return Ok(status);
        }
    }
    status_reply(request_worker(
        state,
        &player_id,
        PlayerOperation::Load(path),
    )?)
}

#[tauri::command]
pub async fn player_play(state: State<'_, MpvState>, player_id: String) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let native = state.native.clone();
        let id = player_id.clone();
        if run_off_main_thread(move || native.play(id))
            .await?
            .is_some()
        {
            return Ok(());
        }
    }
    match request_worker(state, &player_id, PlayerOperation::Play)? {
        PlayerReply::Unit => Ok(()),
        _ => Err("libmpv 返回了无效的播放结果".into()),
    }
}

#[tauri::command]
pub async fn player_pause(state: State<'_, MpvState>, player_id: String) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let native = state.native.clone();
        let id = player_id.clone();
        if run_off_main_thread(move || native.pause(id))
            .await?
            .is_some()
        {
            return Ok(());
        }
    }
    match request_worker(state, &player_id, PlayerOperation::Pause)? {
        PlayerReply::Unit => Ok(()),
        _ => Err("libmpv 返回了无效的暂停结果".into()),
    }
}

#[tauri::command]
pub async fn player_toggle(state: State<'_, MpvState>, player_id: String) -> Result<bool, String> {
    #[cfg(target_os = "linux")]
    {
        let native = state.native.clone();
        let id = player_id.clone();
        if let Some(value) = run_off_main_thread(move || native.toggle(id)).await? {
            return Ok(value);
        }
    }
    match request_worker(state, &player_id, PlayerOperation::Toggle)? {
        PlayerReply::Toggled(value) => Ok(value),
        _ => Err("libmpv 返回了无效的切换结果".into()),
    }
}

#[tauri::command]
pub async fn player_seek(
    state: State<'_, MpvState>,
    player_id: String,
    time_sec: f64,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let native = state.native.clone();
        let id = player_id.clone();
        if run_off_main_thread(move || native.seek(id, time_sec))
            .await?
            .is_some()
        {
            return Ok(());
        }
    }
    match request_worker(state, &player_id, PlayerOperation::Seek(time_sec))? {
        PlayerReply::Unit => Ok(()),
        _ => Err("libmpv 返回了无效的 seek 结果".into()),
    }
}

#[tauri::command]
pub async fn player_step(
    state: State<'_, MpvState>,
    player_id: String,
    direction: FrameDirection,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let native = state.native.clone();
        let id = player_id.clone();
        if run_off_main_thread(move || native.step(id, direction))
            .await?
            .is_some()
        {
            return Ok(());
        }
    }
    match request_worker(state, &player_id, PlayerOperation::Step(direction))? {
        PlayerReply::Unit => Ok(()),
        _ => Err("libmpv 返回了无效的逐帧结果".into()),
    }
}

#[tauri::command]
pub async fn player_set_volume(
    state: State<'_, MpvState>,
    player_id: String,
    volume: f64,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let native = state.native.clone();
        let id = player_id.clone();
        if run_off_main_thread(move || native.set_volume(id, volume))
            .await?
            .is_some()
        {
            return Ok(());
        }
    }
    match request_worker(state, &player_id, PlayerOperation::SetVolume(volume))? {
        PlayerReply::Unit => Ok(()),
        _ => Err("libmpv 返回了无效的音量结果".into()),
    }
}

#[tauri::command]
pub async fn player_status(
    state: State<'_, MpvState>,
    player_id: String,
) -> Result<PlayerStatus, String> {
    #[cfg(target_os = "linux")]
    {
        let native = state.native.clone();
        let id = player_id.clone();
        if let Some(status) = run_off_main_thread(move || native.status(id)).await? {
            return Ok(status);
        }
    }
    match request_worker(state, &player_id, PlayerOperation::Status) {
        Ok(reply) => status_reply(reply),
        Err(error) if error == "播放器未初始化" => Ok(empty_status()),
        Err(error) => Err(error),
    }
}

#[tauri::command]
pub async fn player_frame(
    state: State<'_, MpvState>,
    player_id: String,
    max_width: i32,
) -> Result<Option<PlayerFrame>, String> {
    #[cfg(any(target_os = "linux", target_os = "windows"))]
    if state.native.is_active(&player_id) {
        // The native renderer owns the framebuffer. Never restart the old
        // RGBA screenshot bridge for a GPU player.
        return Ok(None);
    }
    match request_worker(
        state,
        &player_id,
        PlayerOperation::Frame(if max_width > 0 {
            max_width
        } else {
            DEFAULT_FRAME_WIDTH
        }),
    )? {
        PlayerReply::Frame(frame) => Ok(frame),
        _ => Err("libmpv 返回了无效的帧结果".into()),
    }
}

#[tauri::command]
pub async fn player_set_surface(
    state: State<'_, MpvState>,
    player_id: String,
    surface: serde_json::Value,
) -> Result<bool, String> {
    #[cfg(target_os = "linux")]
    {
        let surface: SurfaceConfig = serde_json::from_value(surface)
            .map_err(|error| format!("播放器表面参数无效: {error}"))?;
        let native = state.native.clone();
        if let Some(visible) =
            run_off_main_thread(move || native.set_surface(player_id, surface)).await?
        {
            return Ok(visible);
        }
    }
    #[cfg(target_os = "linux")]
    return Ok(false);
    #[cfg(target_os = "windows")]
    {
        let surface: SurfaceConfig = serde_json::from_value(surface)
            .map_err(|error| format!("播放器表面参数无效: {error}"))?;
        let native = state.native.clone();
        return run_off_main_thread(move || native.set_surface(player_id, surface)).await;
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    {
        let _ = (state, player_id, surface);
        Ok(false)
    }
}

async fn run_off_main_thread<F, T>(task: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| format!("播放器任务线程失败: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[test]
    fn display_dimensions_follow_quarter_turn_rotation() {
        assert_eq!(rotated_dimensions(3840, 2160, -90), (2160, 3840));
        assert_eq!(rotated_dimensions(1280, 720, 90), (720, 1280));
        assert_eq!(rotated_dimensions(1920, 1080, 180), (1920, 1080));
        assert_eq!(
            normalized_display_dimensions(1280, 720, 720, 1280, 90),
            (720, 1280)
        );
        assert_eq!(
            normalized_display_dimensions(1280, 720, 1280, 720, 90),
            (720, 1280)
        );
    }

    #[test]
    fn loaded_media_path_matches_windows_separator_variants() {
        assert!(media_paths_match(r"C:\Media\clip.mp4", "c:/media/clip.mp4"));
        assert!(!media_paths_match(
            r"C:\Media\first.mp4",
            r"C:\Media\second.mp4"
        ));
    }

    #[test]
    fn frame_directions_map_to_native_mpv_commands() {
        assert_eq!(FrameDirection::Backward.mpv_command(), "frame-back-step");
        assert_eq!(FrameDirection::Forward.mpv_command(), "frame-step");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn selection_ass_contains_border_handles_and_surface_coordinates() {
        let ass = selection_to_ass(SelectionOverlayUpdate {
            x: 10,
            y: 20,
            width: 100,
            height: 60,
            surface_width: 320,
            surface_height: 180,
            locked: false,
            accent_bgr: 0,
        })
        .expect("selection overlay");
        assert!(ass.contains("m 10 20 l 110 20 110 22 10 22"));
        assert!(ass.contains("m 5 15 l 15 15 15 25 5 25"));
        assert!(ass.contains("\\1c&HCF9CA8&"));
        assert!(ass.contains("\\alpha&HD9&"));

        let custom = selection_to_ass(SelectionOverlayUpdate {
            accent_bgr: 0x005f7f3f,
            x: 10,
            y: 20,
            width: 100,
            height: 60,
            surface_width: 320,
            surface_height: 180,
            locked: false,
        })
        .expect("custom selection overlay");
        assert!(custom.contains("\\1c&H5F7F3F&"));

        assert!(selection_to_ass(SelectionOverlayUpdate {
            surface_width: 320,
            surface_height: 180,
            ..SelectionOverlayUpdate::default()
        })
        .is_none());
    }

    #[test]
    #[ignore = "requires libmpv and SHADOWENCODER_MPV_SMOKE_FILE"]
    fn smoke_decodes_controls_and_stops_a_local_file() {
        let path = std::env::var("SHADOWENCODER_MPV_SMOKE_FILE")
            .expect("SHADOWENCODER_MPV_SMOKE_FILE must point to a local media file");
        let frame_max_width = std::env::var("SHADOWENCODER_MPV_SMOKE_FRAME_WIDTH")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(DEFAULT_FRAME_WIDTH);
        let interleave_count = std::env::var("SHADOWENCODER_MPV_SMOKE_INTERLEAVE_COUNT")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(64);
        let worker = spawn_player(
            #[cfg(target_os = "windows")]
            None,
        )
        .expect("libmpv worker should initialise");

        let loaded = match worker
            .request(PlayerOperation::Load(path))
            .expect("load request should succeed")
        {
            PlayerReply::Status(status) => status,
            _ => panic!("load should return a status"),
        };
        if let (Ok(width), Ok(height)) = (
            std::env::var("SHADOWENCODER_MPV_EXPECT_WIDTH"),
            std::env::var("SHADOWENCODER_MPV_EXPECT_HEIGHT"),
        ) {
            let width = width
                .parse::<i64>()
                .expect("expected width must be numeric");
            let height = height
                .parse::<i64>()
                .expect("expected height must be numeric");
            assert_eq!((loaded.width, loaded.height), (width, height));
        }

        let deadline = Instant::now() + Duration::from_secs(5);
        let frame = loop {
            match worker
                .request(PlayerOperation::Frame(frame_max_width))
                .expect("frame request should succeed")
            {
                PlayerReply::Frame(Some(frame)) => break frame,
                PlayerReply::Frame(None) if Instant::now() < deadline => {
                    thread::sleep(Duration::from_millis(50));
                }
                PlayerReply::Frame(None) => {
                    panic!("libmpv did not produce a frame within 5 seconds")
                }
                _ => panic!("frame request returned an unexpected reply"),
            }
        };

        let pixels = STANDARD
            .decode(&frame.data)
            .expect("screenshot frame should be valid base64");
        assert!(frame.source_width > 0);
        assert!(frame.source_height > 0);
        assert!(frame.width <= frame_max_width as u32);
        let source_width = frame.source_width;
        let source_height = frame.source_height;
        assert_eq!(
            pixels.len(),
            frame.width as usize * frame.height as usize * 4
        );
        assert!(
            (frame.width as i64 * frame.source_height as i64
                - frame.height as i64 * frame.source_width as i64)
                .abs()
                <= frame.source_width.max(frame.source_height) as i64,
            "preview frame must retain its display aspect ratio"
        );

        // The UI requests status and canvas frames in adjacent animation
        // ticks. Keep that interleaving in the smoke test because this is the
        // same request pattern the Tauri Canvas bridge uses.
        for _ in 0..interleave_count {
            assert!(matches!(
                worker.request(PlayerOperation::Status),
                Ok(PlayerReply::Status(status)) if status.ready
            ));
            assert!(matches!(
                worker.request(PlayerOperation::Frame(frame_max_width)),
                Ok(PlayerReply::Frame(Some(frame)))
                    if frame.source_width == source_width && frame.source_height == source_height
            ));
        }

        assert!(matches!(
            worker.request(PlayerOperation::Play),
            Ok(PlayerReply::Unit)
        ));
        assert!(matches!(
            worker.request(PlayerOperation::Pause),
            Ok(PlayerReply::Unit)
        ));
        assert!(matches!(
            worker.request(PlayerOperation::Seek(2.0)),
            Ok(PlayerReply::Unit)
        ));
        assert!(matches!(
            worker.request(PlayerOperation::Step(FrameDirection::Forward)),
            Ok(PlayerReply::Unit)
        ));
        assert!(matches!(
            worker.request(PlayerOperation::Step(FrameDirection::Backward)),
            Ok(PlayerReply::Unit)
        ));
        assert!(matches!(
            worker.request(PlayerOperation::Load(String::new())),
            Ok(PlayerReply::Status(status)) if status.path.is_empty() && !status.ready
        ));

        worker.shutdown();
    }
}
