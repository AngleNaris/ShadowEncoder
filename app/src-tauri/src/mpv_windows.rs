//! Windows native GPU presentation for libmpv.
//!
//! Each player owns a child HWND layered over the WebView. libmpv renders
//! directly into that window through its D3D11 video output, avoiding the
//! screenshot/Base64 bridge entirely.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::ptr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{Emitter, WebviewWindow};
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::{
    BeginPaint, CreateSolidBrush, DeleteObject, EndPaint, FillRect, PAINTSTRUCT,
};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{ReleaseCapture, SetCapture};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, GetClientRect, LoadCursorW, RegisterClassW,
    SendMessageW, SetCursor, SetWindowPos, ShowWindow, CS_HREDRAW, CS_VREDRAW, HTTRANSPARENT,
    HWND_TOP, IDC_ARROW, IDC_CROSS, SWP_NOACTIVATE, SWP_NOOWNERZORDER, SW_HIDE, SW_SHOWNA,
    WM_ERASEBKGND, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEMOVE, WM_NCHITTEST, WM_PAINT,
    WM_SETCURSOR, WNDCLASSW, WS_CHILD, WS_CLIPCHILDREN, WS_CLIPSIBLINGS, WS_EX_NOACTIVATE,
};

const SURFACE_CLASS_NAME: &str = "ShadowEncoderMpvSurface";
const OVERLAY_CLASS_NAME: &str = "ShadowEncoderMpvOverlay";
const MAIN_THREAD_TIMEOUT: Duration = Duration::from_secs(5);
const OVERLAY_ACCENT: u32 = 0x00c88aff;
const OVERLAY_PART_COUNT: usize = 8;
const SELECTION_EVENT_NAME: &str = "mpv-selection-committed";
const MOUSE_LEFT_BUTTON: usize = 0x0001;
const MIN_SELECTION_SIZE: i32 = 4;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeSelectionEvent {
    player_id: String,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    surface_width: i32,
    surface_height: i32,
}

static SURFACE_TARGETS: OnceLock<Mutex<HashMap<isize, Arc<Mutex<NativeInteraction>>>>> =
    OnceLock::new();
static SELECTION_EVENT_TX: OnceLock<mpsc::Sender<NativeSelectionEvent>> = OnceLock::new();
static EVENT_WINDOW: OnceLock<Mutex<Option<WebviewWindow>>> = OnceLock::new();
static OVERLAY_PAINT_COUNT: AtomicUsize = AtomicUsize::new(0);

fn surface_targets() -> &'static Mutex<HashMap<isize, Arc<Mutex<NativeInteraction>>>> {
    SURFACE_TARGETS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn signed_low_word(value: LPARAM) -> i32 {
    (value as u32 & 0xffff) as u16 as i16 as i32
}

fn signed_high_word(value: LPARAM) -> i32 {
    ((value as u32 >> 16) & 0xffff) as u16 as i16 as i32
}

fn mouse_lparam(x: i16, y: i16) -> LPARAM {
    ((y as u16 as u32) << 16 | x as u16 as u32) as LPARAM
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceConfig {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    #[serde(default)]
    pub visible: bool,
    #[serde(default)]
    pub crop: Option<SurfaceCrop>,
    #[serde(default)]
    pub selection_enabled: bool,
    #[serde(default)]
    pub selection_locked: bool,
    #[serde(default)]
    pub aspect_ratio: Option<f64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceCrop {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Debug)]
struct NativeSurface {
    video: isize,
    overlays: [isize; OVERLAY_PART_COUNT],
    interaction: Arc<Mutex<NativeInteraction>>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct SelectionRect {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct SelectionOverlayUpdate {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub surface_width: i32,
    pub surface_height: i32,
    pub locked: bool,
}

#[derive(Clone, Copy, Debug)]
enum Handle {
    Nw,
    Ne,
    Sw,
    Se,
}

#[derive(Clone, Copy, Debug)]
enum DragMode {
    New,
    Move,
    Resize(Handle),
}

#[derive(Clone, Copy, Debug)]
struct DragState {
    mode: DragMode,
    start_x: i32,
    start_y: i32,
    original: Option<SelectionRect>,
}

#[derive(Debug)]
struct NativeInteraction {
    player_id: String,
    overlays: [isize; OVERLAY_PART_COUNT],
    surface_width: i32,
    surface_height: i32,
    stroke: i32,
    handle: i32,
    enabled: bool,
    locked: bool,
    aspect_ratio: Option<f64>,
    rect: Option<SelectionRect>,
    drag: Option<DragState>,
    overlay_tx: Option<mpsc::Sender<SelectionOverlayUpdate>>,
}

impl NativeInteraction {
    fn new(player_id: String, overlays: [isize; OVERLAY_PART_COUNT]) -> Self {
        Self {
            player_id,
            overlays,
            surface_width: 1,
            surface_height: 1,
            stroke: 2,
            handle: 8,
            enabled: false,
            locked: false,
            aspect_ratio: None,
            rect: None,
            drag: None,
            overlay_tx: None,
        }
    }

    fn overlay_update(&self) -> SelectionOverlayUpdate {
        let rect = self
            .rect
            .filter(|rect| self.enabled && rect.width > 0 && rect.height > 0)
            .unwrap_or_default();
        SelectionOverlayUpdate {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            surface_width: self.surface_width,
            surface_height: self.surface_height,
            locked: self.locked,
        }
    }

    fn publish_overlay(&self) {
        if let Some(sender) = &self.overlay_tx {
            let _ = sender.send(self.overlay_update());
        }
    }

    fn clamp_point(&self, x: i32, y: i32) -> (i32, i32) {
        (
            x.clamp(0, self.surface_width),
            y.clamp(0, self.surface_height),
        )
    }

    fn hit_test(&self, x: i32, y: i32) -> DragMode {
        let Some(rect) = self.rect else {
            return DragMode::New;
        };
        let right = rect.x + rect.width;
        let bottom = rect.y + rect.height;
        let tolerance = self.handle.max(12);
        let near = |px: i32, py: i32| (x - px).abs() <= tolerance && (y - py).abs() <= tolerance;
        if near(rect.x, rect.y) {
            DragMode::Resize(Handle::Nw)
        } else if near(right, rect.y) {
            DragMode::Resize(Handle::Ne)
        } else if near(rect.x, bottom) {
            DragMode::Resize(Handle::Sw)
        } else if near(right, bottom) {
            DragMode::Resize(Handle::Se)
        } else if x >= rect.x && x <= right && y >= rect.y && y <= bottom {
            DragMode::Move
        } else {
            DragMode::New
        }
    }

    fn begin(&mut self, x: i32, y: i32) -> bool {
        if !self.enabled || self.locked {
            return false;
        }
        let (x, y) = self.clamp_point(x, y);
        let mode = self.hit_test(x, y);
        self.drag = Some(DragState {
            mode,
            start_x: x,
            start_y: y,
            original: self.rect,
        });
        if matches!(mode, DragMode::New) {
            self.rect = Some(SelectionRect {
                x,
                y,
                width: 0,
                height: 0,
            });
        }
        true
    }

    fn update(&mut self, x: i32, y: i32) -> bool {
        let Some(drag) = self.drag else { return false };
        let (x, y) = self.clamp_point(x, y);
        self.rect = match drag.mode {
            DragMode::New => Some(rect_from_drag(
                drag.start_x,
                drag.start_y,
                x,
                y,
                self.surface_width,
                self.surface_height,
                self.aspect_ratio,
            )),
            DragMode::Move => drag.original.map(|rect| {
                let x = (rect.x + x - drag.start_x).clamp(0, self.surface_width - rect.width);
                let y = (rect.y + y - drag.start_y).clamp(0, self.surface_height - rect.height);
                SelectionRect { x, y, ..rect }
            }),
            DragMode::Resize(handle) => drag.original.map(|rect| {
                resize_rect(
                    rect,
                    handle,
                    x,
                    y,
                    self.surface_width,
                    self.surface_height,
                    self.aspect_ratio,
                )
            }),
        };
        true
    }

    fn finish(&mut self, x: i32, y: i32) -> Option<SelectionRect> {
        if self.drag.is_none() {
            return None;
        }
        self.update(x, y);
        self.drag = None;
        if self
            .rect
            .is_some_and(|rect| rect.width < MIN_SELECTION_SIZE || rect.height < MIN_SELECTION_SIZE)
        {
            self.rect = None;
        }
        self.rect
    }
}

fn rect_from_drag(
    start_x: i32,
    start_y: i32,
    end_x: i32,
    end_y: i32,
    max_width: i32,
    max_height: i32,
    aspect_ratio: Option<f64>,
) -> SelectionRect {
    let mut dx = end_x - start_x;
    let mut dy = end_y - start_y;
    if let Some(aspect) = aspect_ratio.filter(|value| value.is_finite() && *value > 0.0) {
        let x_sign = if dx < 0 { -1 } else { 1 };
        let y_sign = if dy < 0 { -1 } else { 1 };
        if (dx.abs() as f64) / (dy.abs().max(1) as f64) > aspect {
            dy = ((dx.abs() as f64 / aspect).round() as i32) * y_sign;
        } else {
            dx = ((dy.abs() as f64 * aspect).round() as i32) * x_sign;
        }
        let available_width = if dx < 0 { start_x } else { max_width - start_x };
        let available_height = if dy < 0 {
            start_y
        } else {
            max_height - start_y
        };
        let scale = (available_width as f64 / dx.abs().max(1) as f64)
            .min(available_height as f64 / dy.abs().max(1) as f64)
            .min(1.0);
        dx = (dx as f64 * scale).round() as i32;
        dy = (dy as f64 * scale).round() as i32;
    }
    let left = start_x.min(start_x + dx).clamp(0, max_width);
    let top = start_y.min(start_y + dy).clamp(0, max_height);
    let right = start_x.max(start_x + dx).clamp(0, max_width);
    let bottom = start_y.max(start_y + dy).clamp(0, max_height);
    SelectionRect {
        x: left,
        y: top,
        width: right - left,
        height: bottom - top,
    }
}

fn resize_rect(
    original: SelectionRect,
    handle: Handle,
    x: i32,
    y: i32,
    max_width: i32,
    max_height: i32,
    aspect_ratio: Option<f64>,
) -> SelectionRect {
    let (anchor_x, anchor_y) = match handle {
        Handle::Nw => (original.x + original.width, original.y + original.height),
        Handle::Ne => (original.x, original.y + original.height),
        Handle::Sw => (original.x + original.width, original.y),
        Handle::Se => (original.x, original.y),
    };
    rect_from_drag(
        anchor_x,
        anchor_y,
        x,
        y,
        max_width,
        max_height,
        aspect_ratio,
    )
}

#[derive(Clone, Default)]
pub struct NativeGpuState {
    window: Arc<Mutex<Option<WebviewWindow>>>,
    // Keep native handles as integers in shared state. Raw HWND pointers are
    // converted only inside main-thread Win32 closures.
    surfaces: Arc<Mutex<HashMap<String, NativeSurface>>>,
}

unsafe fn position_selection(interaction: &NativeInteraction) -> Result<(), String> {
    // A libmpv D3D swapchain can present over GDI child windows. Keep the
    // native HWNDs hidden and render the selection through mpv's GPU OSD.
    for overlay in interaction.overlays {
        unsafe { ShowWindow(overlay as HWND, SW_HIDE) };
    }
    interaction.publish_overlay();
    Ok(())
}

fn interaction_for(hwnd: HWND) -> Option<Arc<Mutex<NativeInteraction>>> {
    surface_targets()
        .lock()
        .ok()
        .and_then(|targets| targets.get(&(hwnd as isize)).cloned())
}

unsafe extern "system" fn surface_window_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match message {
        WM_SETCURSOR => {
            let selection_enabled = interaction_for(hwnd)
                .and_then(|interaction| {
                    interaction
                        .lock()
                        .ok()
                        .map(|state| state.enabled && !state.locked)
                })
                .unwrap_or(false);
            let cursor = unsafe {
                LoadCursorW(
                    ptr::null_mut(),
                    if selection_enabled {
                        IDC_CROSS
                    } else {
                        IDC_ARROW
                    },
                )
            };
            if !cursor.is_null() {
                unsafe { SetCursor(cursor) };
                return 1;
            }
            unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
        }
        WM_LBUTTONDOWN => {
            let Some(interaction) = interaction_for(hwnd) else {
                return unsafe { DefWindowProcW(hwnd, message, wparam, lparam) };
            };
            let started = interaction
                .lock()
                .map(|mut state| state.begin(signed_low_word(lparam), signed_high_word(lparam)))
                .unwrap_or(false);
            if started {
                unsafe { SetCapture(hwnd) };
            }
            0
        }
        WM_MOUSEMOVE if wparam & MOUSE_LEFT_BUTTON != 0 => {
            if let Some(interaction) = interaction_for(hwnd) {
                if let Ok(mut state) = interaction.lock() {
                    if state.update(signed_low_word(lparam), signed_high_word(lparam)) {
                        let _ = unsafe { position_selection(&state) };
                    }
                }
            }
            0
        }
        WM_LBUTTONUP => {
            let event = interaction_for(hwnd).and_then(|interaction| {
                let mut state = interaction.lock().ok()?;
                if state.drag.is_none() {
                    return None;
                }
                let rect = state.finish(signed_low_word(lparam), signed_high_word(lparam));
                let _ = unsafe { position_selection(&state) };
                let rect = rect.unwrap_or_default();
                Some(NativeSelectionEvent {
                    player_id: state.player_id.clone(),
                    x: rect.x,
                    y: rect.y,
                    width: rect.width,
                    height: rect.height,
                    surface_width: state.surface_width,
                    surface_height: state.surface_height,
                })
            });
            unsafe { ReleaseCapture() };
            if let (Some(event), Some(sender)) = (event, SELECTION_EVENT_TX.get()) {
                let _ = sender.send(event);
            }
            0
        }
        _ => unsafe { DefWindowProcW(hwnd, message, wparam, lparam) },
    }
}

unsafe fn fill_rect(hdc: *mut std::ffi::c_void, rect: RECT, color: u32) {
    let brush = unsafe { CreateSolidBrush(color) };
    if !brush.is_null() {
        unsafe {
            FillRect(hdc, &rect, brush);
            DeleteObject(brush);
        }
    }
}

unsafe fn draw_overlay(hwnd: HWND) {
    let mut paint: PAINTSTRUCT = unsafe { std::mem::zeroed() };
    let hdc = unsafe { BeginPaint(hwnd, &mut paint) };
    if hdc.is_null() {
        return;
    }

    let mut client: RECT = unsafe { std::mem::zeroed() };
    unsafe {
        GetClientRect(hwnd, &mut client);
        fill_rect(hdc, client, OVERLAY_ACCENT);
    }
    unsafe { EndPaint(hwnd, &paint) };
    OVERLAY_PAINT_COUNT.fetch_add(1, Ordering::SeqCst);
}

unsafe extern "system" fn overlay_window_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match message {
        WM_NCHITTEST => HTTRANSPARENT as LRESULT,
        WM_ERASEBKGND => 1,
        WM_PAINT => {
            unsafe { draw_overlay(hwnd) };
            0
        }
        _ => unsafe { DefWindowProcW(hwnd, message, wparam, lparam) },
    }
}

fn wide_null(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn ensure_window_class() -> Result<(), String> {
    static REGISTERED: OnceLock<Result<(), String>> = OnceLock::new();
    REGISTERED
        .get_or_init(|| unsafe {
            let instance = GetModuleHandleW(ptr::null());
            if instance.is_null() {
                return Err("无法取得 ShadowEncoder 模块句柄".into());
            }
            let class_name = wide_null(SURFACE_CLASS_NAME);
            let class = WNDCLASSW {
                style: CS_HREDRAW | CS_VREDRAW,
                lpfnWndProc: Some(surface_window_proc),
                cbClsExtra: 0,
                cbWndExtra: 0,
                hInstance: instance,
                hIcon: ptr::null_mut(),
                hCursor: ptr::null_mut(),
                hbrBackground: ptr::null_mut(),
                lpszMenuName: ptr::null(),
                lpszClassName: class_name.as_ptr(),
            };
            if RegisterClassW(&class) == 0 {
                return Err(format!(
                    "注册 Windows GPU 播放窗口失败: {}",
                    std::io::Error::last_os_error()
                ));
            }
            Ok(())
        })
        .clone()
}

fn ensure_overlay_class() -> Result<(), String> {
    static REGISTERED: OnceLock<Result<(), String>> = OnceLock::new();
    REGISTERED
        .get_or_init(|| unsafe {
            let instance = GetModuleHandleW(ptr::null());
            if instance.is_null() {
                return Err("无法取得 ShadowEncoder 模块句柄".into());
            }
            let class_name = wide_null(OVERLAY_CLASS_NAME);
            let class = WNDCLASSW {
                style: CS_HREDRAW | CS_VREDRAW,
                lpfnWndProc: Some(overlay_window_proc),
                cbClsExtra: 0,
                cbWndExtra: 0,
                hInstance: instance,
                hIcon: ptr::null_mut(),
                hCursor: ptr::null_mut(),
                hbrBackground: ptr::null_mut(),
                lpszMenuName: ptr::null(),
                lpszClassName: class_name.as_ptr(),
            };
            if RegisterClassW(&class) == 0 {
                return Err(format!(
                    "注册 Windows GPU 选区窗口失败: {}",
                    std::io::Error::last_os_error()
                ));
            }
            Ok(())
        })
        .clone()
}

fn wait_main_thread<T>(receiver: mpsc::Receiver<Result<T, String>>) -> Result<T, String> {
    receiver
        .recv_timeout(MAIN_THREAD_TIMEOUT)
        .map_err(|_| "等待 Windows 主线程操作超时".to_string())?
}

impl NativeGpuState {
    pub fn install(&self, window: WebviewWindow) -> Result<(), String> {
        ensure_window_class()?;
        ensure_overlay_class()?;
        *EVENT_WINDOW
            .get_or_init(|| Mutex::new(None))
            .lock()
            .map_err(|error| error.to_string())? = Some(window.clone());
        if SELECTION_EVENT_TX.get().is_none() {
            let (sender, receiver) = mpsc::channel();
            if SELECTION_EVENT_TX.set(sender).is_ok() {
                std::thread::spawn(move || {
                    while let Ok(event) = receiver.recv() {
                        let event_window = EVENT_WINDOW
                            .get()
                            .and_then(|slot| slot.lock().ok())
                            .and_then(|window| window.clone());
                        if let Some(event_window) = event_window {
                            let _ = event_window.emit(SELECTION_EVENT_NAME, event);
                        }
                    }
                });
            }
        }
        *self.window.lock().map_err(|error| error.to_string())? = Some(window);
        Ok(())
    }

    pub fn init(&self, player_id: String) -> Result<isize, String> {
        self.destroy(&player_id)?;
        let window = self
            .window
            .lock()
            .map_err(|error| error.to_string())?
            .clone()
            .ok_or("Windows GPU 播放表面尚未安装")?;
        let (reply_tx, reply_rx) = mpsc::sync_channel(1);
        let main_window = window.clone();
        let surface_player_id = player_id.clone();
        window
            .run_on_main_thread(move || {
                let result = (|| unsafe {
                    ensure_window_class()?;
                    let parent = main_window.hwnd().map_err(|error| error.to_string())?.0 as HWND;
                    let instance = GetModuleHandleW(ptr::null());
                    let class_name = wide_null(SURFACE_CLASS_NAME);
                    let video = CreateWindowExW(
                        WS_EX_NOACTIVATE,
                        class_name.as_ptr(),
                        ptr::null(),
                        WS_CHILD | WS_CLIPSIBLINGS | WS_CLIPCHILDREN,
                        0,
                        0,
                        1,
                        1,
                        parent,
                        ptr::null_mut(),
                        instance,
                        ptr::null(),
                    );
                    if video.is_null() {
                        return Err(format!(
                            "创建 Windows GPU 播放窗口失败: {}",
                            std::io::Error::last_os_error()
                        ));
                    }
                    let overlay_class_name = wide_null(OVERLAY_CLASS_NAME);
                    let mut overlays = [0_isize; OVERLAY_PART_COUNT];
                    for overlay_handle in &mut overlays {
                        let overlay = CreateWindowExW(
                            WS_EX_NOACTIVATE,
                            overlay_class_name.as_ptr(),
                            ptr::null(),
                            WS_CHILD | WS_CLIPSIBLINGS,
                            0,
                            0,
                            1,
                            1,
                            video,
                            ptr::null_mut(),
                            instance,
                            ptr::null(),
                        );
                        if overlay.is_null() {
                            let error = std::io::Error::last_os_error();
                            for created in overlays.iter().copied().filter(|handle| *handle != 0) {
                                DestroyWindow(created as HWND);
                            }
                            DestroyWindow(video);
                            return Err(format!("创建 Windows GPU 选区部件失败: {}", error));
                        }
                        ShowWindow(overlay, SW_HIDE);
                        *overlay_handle = overlay as isize;
                    }
                    ShowWindow(video, SW_HIDE);
                    let interaction = Arc::new(Mutex::new(NativeInteraction::new(
                        surface_player_id,
                        overlays,
                    )));
                    surface_targets()
                        .lock()
                        .map_err(|error| error.to_string())?
                        .insert(video as isize, interaction.clone());
                    Ok(NativeSurface {
                        video: video as isize,
                        overlays,
                        interaction,
                    })
                })();
                let _ = reply_tx.send(result);
            })
            .map_err(|error| error.to_string())?;
        let surface = wait_main_thread(reply_rx)?;
        let video = surface.video;
        self.surfaces
            .lock()
            .map_err(|error| error.to_string())?
            .insert(player_id, surface);
        Ok(video)
    }

    pub fn destroy(&self, player_id: &str) -> Result<(), String> {
        let surface = self
            .surfaces
            .lock()
            .map_err(|error| error.to_string())?
            .remove(player_id);
        let Some(surface) = surface else {
            return Ok(());
        };
        let window = self
            .window
            .lock()
            .map_err(|error| error.to_string())?
            .clone()
            .ok_or("Windows GPU 播放表面尚未安装")?;
        let (reply_tx, reply_rx) = mpsc::sync_channel(1);
        window
            .run_on_main_thread(move || {
                let video = surface.video as HWND;
                let result = unsafe {
                    if let Ok(mut targets) = surface_targets().lock() {
                        targets.remove(&(video as isize));
                    }
                    ReleaseCapture();
                    let mut overlays_destroyed = true;
                    for overlay in surface.overlays {
                        overlays_destroyed &= DestroyWindow(overlay as HWND) != 0;
                    }
                    let video_destroyed = DestroyWindow(video) != 0;
                    if !overlays_destroyed || !video_destroyed {
                        Err(format!(
                            "销毁 Windows GPU 播放窗口失败: {}",
                            std::io::Error::last_os_error()
                        ))
                    } else {
                        Ok(())
                    }
                };
                let _ = reply_tx.send(result);
            })
            .map_err(|error| error.to_string())?;
        wait_main_thread(reply_rx)
    }

    pub fn is_active(&self, player_id: &str) -> bool {
        self.surfaces
            .lock()
            .map(|surfaces| surfaces.contains_key(player_id))
            .unwrap_or(false)
    }

    pub(crate) fn attach_selection_overlay(
        &self,
        player_id: &str,
        sender: mpsc::Sender<SelectionOverlayUpdate>,
    ) -> Result<(), String> {
        let surface = self
            .surfaces
            .lock()
            .map_err(|error| error.to_string())?
            .get(player_id)
            .cloned()
            .ok_or("Windows GPU 播放表面不存在")?;
        let mut interaction = surface
            .interaction
            .lock()
            .map_err(|error| error.to_string())?;
        interaction.overlay_tx = Some(sender);
        interaction.publish_overlay();
        Ok(())
    }

    pub fn smoke_selection(&self, player_id: &str) -> Result<(i32, i32, i32, i32), String> {
        let surface = self
            .surfaces
            .lock()
            .map_err(|error| error.to_string())?
            .get(player_id)
            .cloned()
            .ok_or("Windows GPU 播放表面不存在")?;
        let video = surface.video as HWND;
        unsafe {
            SendMessageW(video, WM_LBUTTONDOWN, MOUSE_LEFT_BUTTON, mouse_lparam(8, 8));
            SendMessageW(video, WM_MOUSEMOVE, MOUSE_LEFT_BUTTON, mouse_lparam(32, 32));
            SendMessageW(video, WM_LBUTTONUP, 0, mouse_lparam(32, 32));
        }
        let rect = surface
            .interaction
            .lock()
            .map_err(|error| error.to_string())?
            .rect
            .ok_or("Windows GPU 原生选区未生成")?;
        if rect
            != (SelectionRect {
                x: 8,
                y: 8,
                width: 24,
                height: 24,
            })
        {
            return Err(format!("Windows GPU 原生选区异常: {rect:?}"));
        }
        Ok((rect.x, rect.y, rect.width, rect.height))
    }

    pub fn set_surface(&self, player_id: String, config: SurfaceConfig) -> Result<bool, String> {
        let surface = self
            .surfaces
            .lock()
            .map_err(|error| error.to_string())?
            .get(&player_id)
            .cloned()
            .ok_or("Windows GPU 播放表面不存在")?;
        let window = self
            .window
            .lock()
            .map_err(|error| error.to_string())?
            .clone()
            .ok_or("Windows GPU 播放表面尚未安装")?;
        let scale = window.scale_factor().map_err(|error| error.to_string())?;
        let visible = config.visible && config.width > 0.0 && config.height > 0.0;
        let x = (config.x * scale).round() as i32;
        let y = (config.y * scale).round() as i32;
        let width = (config.width * scale).round().max(1.0) as i32;
        let height = (config.height * scale).round().max(1.0) as i32;
        let crop = config.crop.as_ref().and_then(|crop| {
            if crop.width <= 0.0
                || crop.height <= 0.0
                || config.width <= 0.0
                || config.height <= 0.0
            {
                return None;
            }
            let scale_x = width as f64 / config.width;
            let scale_y = height as f64 / config.height;
            let x = (crop.x * scale_x).round().clamp(0.0, width as f64) as i32;
            let y = (crop.y * scale_y).round().clamp(0.0, height as f64) as i32;
            let right = ((crop.x + crop.width) * scale_x)
                .round()
                .clamp(x as f64, width as f64) as i32;
            let bottom = ((crop.y + crop.height) * scale_y)
                .round()
                .clamp(y as f64, height as f64) as i32;
            (right > x && bottom > y).then_some(SelectionRect {
                x,
                y,
                width: right - x,
                height: bottom - y,
            })
        });
        let selection_enabled = config.selection_enabled;
        let selection_locked = config.selection_locked;
        let aspect_ratio = config
            .aspect_ratio
            .filter(|value| value.is_finite() && *value > 0.0);
        let stroke = (2.0 * scale).round().max(1.0) as i32;
        let handle = (8.0 * scale).round().max(6.0) as i32;
        let (reply_tx, reply_rx) = mpsc::sync_channel(1);
        window
            .run_on_main_thread(move || {
                let video = surface.video as HWND;
                let result = (|| unsafe {
                    if !visible {
                        for overlay in surface.overlays {
                            ShowWindow(overlay as HWND, SW_HIDE);
                        }
                        ShowWindow(video, SW_HIDE);
                        Ok(false)
                    } else if SetWindowPos(
                        video,
                        HWND_TOP,
                        x,
                        y,
                        width,
                        height,
                        SWP_NOACTIVATE | SWP_NOOWNERZORDER,
                    ) == 0
                    {
                        Err(format!(
                            "定位 Windows GPU 播放窗口失败: {}",
                            std::io::Error::last_os_error()
                        ))
                    } else {
                        ShowWindow(video, SW_SHOWNA);
                        let mut interaction = surface
                            .interaction
                            .lock()
                            .map_err(|error| error.to_string())?;
                        interaction.surface_width = width;
                        interaction.surface_height = height;
                        interaction.stroke = stroke;
                        interaction.handle = handle;
                        interaction.enabled = selection_enabled;
                        interaction.locked = selection_locked;
                        interaction.aspect_ratio = aspect_ratio;
                        if interaction.drag.is_none() {
                            interaction.rect = crop;
                        }
                        position_selection(&interaction)?;
                        Ok(true)
                    }
                })();
                let _ = reply_tx.send(result);
            })
            .map_err(|error| error.to_string())?;
        wait_main_thread(reply_rx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn interaction() -> NativeInteraction {
        let mut interaction = NativeInteraction::new("test".into(), [0; OVERLAY_PART_COUNT]);
        interaction.enabled = true;
        interaction.surface_width = 320;
        interaction.surface_height = 180;
        interaction
    }

    #[test]
    fn native_selection_creates_moves_and_resizes() {
        let mut state = interaction();
        assert!(state.begin(20, 20));
        assert_eq!(
            state.finish(120, 100),
            Some(SelectionRect {
                x: 20,
                y: 20,
                width: 100,
                height: 80
            })
        );

        assert!(state.begin(70, 60));
        assert_eq!(
            state.finish(90, 75),
            Some(SelectionRect {
                x: 40,
                y: 35,
                width: 100,
                height: 80
            })
        );

        assert!(state.begin(140, 115));
        assert_eq!(
            state.finish(180, 145),
            Some(SelectionRect {
                x: 40,
                y: 35,
                width: 140,
                height: 110
            })
        );
    }

    #[test]
    fn native_selection_respects_aspect_bounds_and_lock() {
        let mut state = interaction();
        state.aspect_ratio = Some(16.0 / 9.0);
        assert!(state.begin(300, 160));
        let rect = state.finish(100, 20).expect("selection");
        assert!(rect.x >= 0 && rect.y >= 0);
        assert!(rect.x + rect.width <= state.surface_width);
        assert!(rect.y + rect.height <= state.surface_height);
        assert!((rect.width as f64 / rect.height as f64 - 16.0 / 9.0).abs() < 0.03);

        state.locked = true;
        assert!(!state.begin(10, 10));
        assert_eq!(state.rect, Some(rect));
    }

    #[test]
    fn tiny_native_selection_is_cleared() {
        let mut state = interaction();
        assert!(state.begin(10, 10));
        assert_eq!(state.finish(12, 12), None);
        assert_eq!(state.rect, None);
    }
}
