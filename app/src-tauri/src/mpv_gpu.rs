//! Linux/Wayland GPU presentation for libmpv.
//!
//! Tauri's WebView is a GTK child on Linux. Wayland does not permit embedding
//! a foreign surface into that WebView, so the player owns a GTK GLArea layered
//! over it. libmpv renders directly into the GL framebuffer; no RGBA/Base64 IPC
//! is involved. The overlay is pass-through, keeping WebView crop interactions.

use crate::mpv_player::{rotated_dimensions, PlayerStatus};
use glib::{ControlFlow, MainContext, Priority};
use gtk::prelude::*;
use libmpv2::render::{OpenGLInitParams, RenderContext, RenderParam, RenderParamApiType};
use libmpv2::{mpv_error, Mpv};
use serde::Deserialize;
use std::cell::RefCell;
use std::ffi::{c_char, c_void, CString};
use std::rc::Rc;
use std::sync::{mpsc, Arc, Mutex, Once};
use std::time::{Duration, Instant};

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
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceCrop {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Default)]
struct SurfaceState {
    crop: Option<SurfaceCrop>,
}

enum Request {
    Init {
        player_id: String,
        reply: mpsc::SyncSender<Result<PlayerStatus, String>>,
    },
    Destroy {
        player_id: String,
        reply: mpsc::SyncSender<Result<(), String>>,
    },
    Load {
        player_id: String,
        path: String,
        reply: mpsc::SyncSender<Result<PlayerStatus, String>>,
    },
    Play {
        player_id: String,
        reply: mpsc::SyncSender<Result<(), String>>,
    },
    Pause {
        player_id: String,
        reply: mpsc::SyncSender<Result<(), String>>,
    },
    Toggle {
        player_id: String,
        reply: mpsc::SyncSender<Result<bool, String>>,
    },
    Seek {
        player_id: String,
        time_sec: f64,
        reply: mpsc::SyncSender<Result<(), String>>,
    },
    SetVolume {
        player_id: String,
        volume: f64,
        reply: mpsc::SyncSender<Result<(), String>>,
    },
    Status {
        player_id: String,
        reply: mpsc::SyncSender<Result<PlayerStatus, String>>,
    },
    SetSurface {
        player_id: String,
        surface: SurfaceConfig,
        reply: mpsc::SyncSender<Result<bool, String>>,
    },
}

#[derive(Clone, Default)]
pub struct NativeGpuState {
    sender: Arc<Mutex<Option<glib::Sender<Request>>>>,
    active_player: Arc<Mutex<Option<String>>>,
}

impl NativeGpuState {
    pub fn install<R: tauri::Runtime>(
        &self,
        window: tauri::WebviewWindow<R>,
    ) -> Result<(), String> {
        let display = gdk::Display::default().ok_or("找不到 GDK 显示器")?;
        let backend = display.backend();
        if !backend.is_wayland() {
            return Err(format!(
                "当前 GTK 显示后端不是 Wayland ({backend:?})，原生 GPU 播放器未启用"
            ));
        }

        let (request_sender, request_receiver) = MainContext::channel(Priority::default());
        let (render_sender, render_receiver) = MainContext::channel(Priority::default());
        let vbox = window.default_vbox().map_err(|error| error.to_string())?;
        let webview = vbox
            .children()
            .into_iter()
            .last()
            .ok_or("无法取得 Tauri WebView GTK 子组件")?;
        let overlay = gtk::Overlay::new();
        let area = gtk::GLArea::builder()
            .auto_render(false)
            .has_alpha(true)
            .has_depth_buffer(false)
            .has_stencil_buffer(false)
            .build();
        area.set_halign(gtk::Align::Start);
        area.set_valign(gtk::Align::Start);
        area.set_size_request(1, 1);
        area.set_can_focus(false);
        area.set_sensitive(false);

        vbox.remove(&webview);
        overlay.add(&webview);
        overlay.add_overlay(&area);
        overlay.set_overlay_pass_through(&area, true);
        vbox.pack_start(&overlay, true, true, 0);
        overlay.show_all();

        let player = Rc::new(RefCell::new(None::<NativePlayer>));
        let surface = Rc::new(RefCell::new(SurfaceState::default()));
        let render_area = area.clone();
        render_receiver.attach(None, move |_| {
            render_area.queue_render();
            ControlFlow::Continue
        });

        let render_player = player.clone();
        let render_surface = surface.clone();
        area.connect_render(move |area, _| {
            // GLArea can emit its first render while the application is still
            // starting. Never touch a `gl` function until player_init loaded
            // the dispatch table on this exact GTK GL context.
            if !gl::Viewport::is_loaded() || render_player.borrow().is_none() {
                return glib::Propagation::Stop;
            }
            let scale = area.scale_factor().max(1);
            let width = area.allocated_width().max(1).saturating_mul(scale);
            let height = area.allocated_height().max(1).saturating_mul(scale);
            unsafe {
                gl::Viewport(0, 0, width, height);
                gl::Disable(gl::SCISSOR_TEST);
                gl::ClearColor(0.0, 0.0, 0.0, 0.0);
                gl::Clear(gl::COLOR_BUFFER_BIT);
            }
            if let Some(player) = render_player.borrow().as_ref() {
                if let Err(error) = player.render.render::<()>(0, width, height, true) {
                    eprintln!("[shadowencoder-mpv] GPU render failed: {error}");
                } else {
                    player.render.report_swap();
                    draw_crop(&render_surface.borrow().crop, width, height, scale);
                }
            }
            glib::Propagation::Stop
        });

        let native = Rc::new(RefCell::new(NativeUi {
            area,
            player,
            surface,
            active_id: None,
            render_sender,
        }));
        request_receiver.attach(None, move |request| {
            native.borrow_mut().handle(request);
            ControlFlow::Continue
        });

        *self.sender.lock().map_err(|error| error.to_string())? = Some(request_sender);
        Ok(())
    }

    pub fn is_active(&self, player_id: &str) -> bool {
        self.active_player
            .lock()
            .ok()
            .and_then(|active| active.clone())
            .as_deref()
            == Some(player_id)
    }

    pub fn init(&self, player_id: String) -> Result<Option<PlayerStatus>, String> {
        let Some(sender) = self
            .sender
            .lock()
            .map_err(|error| error.to_string())?
            .clone()
        else {
            return Ok(None);
        };
        let (reply_sender, reply_receiver) = mpsc::sync_channel(1);
        sender
            .send(Request::Init {
                player_id: player_id.clone(),
                reply: reply_sender,
            })
            .map_err(|_| "原生 GPU 播放器主线程已退出".to_string())?;
        let result = reply_receiver
            .recv()
            .map_err(|_| "原生 GPU 播放器未返回初始化结果".to_string())?;
        if result.is_ok() {
            *self
                .active_player
                .lock()
                .map_err(|error| error.to_string())? = Some(player_id);
        }
        result.map(Some)
    }

    pub fn destroy(&self, player_id: String) -> Result<Option<()>, String> {
        if !self.is_active(&player_id) {
            return Ok(None);
        }
        let result = self.request_unit(player_id.clone(), |reply| Request::Destroy {
            player_id,
            reply,
        });
        if result.is_ok() {
            *self
                .active_player
                .lock()
                .map_err(|error| error.to_string())? = None;
        }
        result
    }

    pub fn load(&self, player_id: String, path: String) -> Result<Option<PlayerStatus>, String> {
        self.request_status(player_id.clone(), |reply| Request::Load {
            player_id,
            path,
            reply,
        })
    }

    pub fn play(&self, player_id: String) -> Result<Option<()>, String> {
        self.request_unit(player_id.clone(), |reply| Request::Play {
            player_id,
            reply,
        })
    }

    pub fn pause(&self, player_id: String) -> Result<Option<()>, String> {
        self.request_unit(player_id.clone(), |reply| Request::Pause {
            player_id,
            reply,
        })
    }

    pub fn toggle(&self, player_id: String) -> Result<Option<bool>, String> {
        if !self.is_active(&player_id) {
            return Ok(None);
        }
        let sender = self.sender()?;
        let (reply_sender, reply_receiver) = mpsc::sync_channel(1);
        sender
            .send(Request::Toggle {
                player_id,
                reply: reply_sender,
            })
            .map_err(|_| "原生 GPU 播放器主线程已退出".to_string())?;
        reply_receiver
            .recv()
            .map_err(|_| "原生 GPU 播放器未返回切换结果".to_string())?
            .map(Some)
    }

    pub fn seek(&self, player_id: String, time_sec: f64) -> Result<Option<()>, String> {
        self.request_unit(player_id.clone(), |reply| Request::Seek {
            player_id,
            time_sec,
            reply,
        })
    }

    pub fn set_volume(&self, player_id: String, volume: f64) -> Result<Option<()>, String> {
        self.request_unit(player_id.clone(), |reply| Request::SetVolume {
            player_id,
            volume,
            reply,
        })
    }

    pub fn status(&self, player_id: String) -> Result<Option<PlayerStatus>, String> {
        self.request_status(player_id.clone(), |reply| Request::Status {
            player_id,
            reply,
        })
    }

    pub fn set_surface(
        &self,
        player_id: String,
        surface: SurfaceConfig,
    ) -> Result<Option<bool>, String> {
        if !self.is_active(&player_id) {
            return Ok(None);
        }
        let sender = self.sender()?;
        let (reply_sender, reply_receiver) = mpsc::sync_channel(1);
        sender
            .send(Request::SetSurface {
                player_id,
                surface,
                reply: reply_sender,
            })
            .map_err(|_| "原生 GPU 播放器主线程已退出".to_string())?;
        reply_receiver
            .recv()
            .map_err(|_| "原生 GPU 播放器未返回表面更新结果".to_string())?
            .map(Some)
    }

    /// Debug-only launch smoke: prove that the native GL surface and libmpv's
    /// selected hardware decoder both work before a UI test is attempted.
    pub fn smoke(&self, path: String) -> Result<PlayerStatus, String> {
        const SMOKE_ID: &str = "__shadowencoder_gpu_smoke__";
        self.init(SMOKE_ID.into())?.ok_or("原生 GPU 播放器未安装")?;
        let _ = self.set_surface(
            SMOKE_ID.into(),
            SurfaceConfig {
                x: 0.0,
                y: 0.0,
                width: 64.0,
                height: 64.0,
                visible: true,
                crop: None,
            },
        )?;
        let result = (|| {
            self.load(SMOKE_ID.into(), path)?
                .ok_or("GPU 冒烟加载未路由到原生播放器")?;
            self.play(SMOKE_ID.into())?
                .ok_or("GPU 冒烟播放未路由到原生播放器")?;
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                let status = self
                    .status(SMOKE_ID.into())?
                    .ok_or("GPU 冒烟状态未路由到原生播放器")?;
                if status.ready && !status.hwdec.is_empty() {
                    return Ok(status);
                }
                if Instant::now() >= deadline {
                    return Err(format!(
                        "GPU 冒烟未取得硬解状态（ready={}, hwdec={:?}）",
                        status.ready, status.hwdec
                    ));
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        })();
        let _ = self.destroy(SMOKE_ID.into());
        result
    }

    fn sender(&self) -> Result<glib::Sender<Request>, String> {
        self.sender
            .lock()
            .map_err(|error| error.to_string())?
            .clone()
            .ok_or_else(|| "原生 GPU 播放器尚未初始化".to_string())
    }

    fn request_unit(
        &self,
        player_id: String,
        request: impl FnOnce(mpsc::SyncSender<Result<(), String>>) -> Request,
    ) -> Result<Option<()>, String> {
        if !self.is_active(&player_id) {
            return Ok(None);
        }
        let sender = self.sender()?;
        let (reply_sender, reply_receiver) = mpsc::sync_channel(1);
        sender
            .send(request(reply_sender))
            .map_err(|_| "原生 GPU 播放器主线程已退出".to_string())?;
        reply_receiver
            .recv()
            .map_err(|_| "原生 GPU 播放器未返回控制结果".to_string())?
            .map(Some)
    }

    fn request_status(
        &self,
        player_id: String,
        request: impl FnOnce(mpsc::SyncSender<Result<PlayerStatus, String>>) -> Request,
    ) -> Result<Option<PlayerStatus>, String> {
        if !self.is_active(&player_id) {
            return Ok(None);
        }
        let sender = self.sender()?;
        let (reply_sender, reply_receiver) = mpsc::sync_channel(1);
        sender
            .send(request(reply_sender))
            .map_err(|_| "原生 GPU 播放器主线程已退出".to_string())?;
        reply_receiver
            .recv()
            .map_err(|_| "原生 GPU 播放器未返回状态".to_string())?
            .map(Some)
    }
}

struct NativeUi {
    area: gtk::GLArea,
    player: Rc<RefCell<Option<NativePlayer>>>,
    surface: Rc<RefCell<SurfaceState>>,
    active_id: Option<String>,
    render_sender: glib::Sender<()>,
}

impl NativeUi {
    fn handle(&mut self, request: Request) {
        match request {
            Request::Init { player_id, reply } => {
                let result = self.init(player_id);
                let _ = reply.send(result);
            }
            Request::Destroy { player_id, reply } => {
                let result = self.require(&player_id).map(|_| self.destroy());
                let _ = reply.send(result);
            }
            Request::Load {
                player_id,
                path,
                reply,
            } => {
                let result = self.with_player(&player_id, |player| {
                    if path.trim().is_empty() {
                        player.mpv.command("stop", &[]).map_err(map_mpv_error)?;
                        player.path.clear();
                    } else {
                        player
                            .mpv
                            .command("loadfile", &[&path, "replace"])
                            .map_err(map_mpv_error)?;
                        player
                            .mpv
                            .set_property("pause", true)
                            .map_err(map_mpv_error)?;
                        player.path = path;
                    }
                    status_of(player)
                });
                let _ = reply.send(result);
            }
            Request::Play { player_id, reply } => {
                let result = self.with_player(&player_id, |player| {
                    player
                        .mpv
                        .set_property("pause", false)
                        .map_err(map_mpv_error)
                });
                let _ = reply.send(result);
            }
            Request::Pause { player_id, reply } => {
                let result = self.with_player(&player_id, |player| {
                    player
                        .mpv
                        .set_property("pause", true)
                        .map_err(map_mpv_error)
                });
                let _ = reply.send(result);
            }
            Request::Toggle { player_id, reply } => {
                let result =
                    self.with_player::<bool>(&player_id, |player| -> Result<bool, String> {
                        let pause: bool =
                            player.mpv.get_property("pause").map_err(map_mpv_error)?;
                        player
                            .mpv
                            .set_property("pause", !pause)
                            .map_err(map_mpv_error)?;
                        Ok(!pause)
                    });
                let _ = reply.send(result);
            }
            Request::Seek {
                player_id,
                time_sec,
                reply,
            } => {
                let result = self.with_player(&player_id, |player| {
                    if !time_sec.is_finite() {
                        return Err("seek 时间必须是有限数值".into());
                    }
                    player
                        .mpv
                        .command("seek", &[&time_sec.max(0.0).to_string(), "absolute"])
                        .map_err(map_mpv_error)
                });
                let _ = reply.send(result);
            }
            Request::SetVolume {
                player_id,
                volume,
                reply,
            } => {
                let result = self.with_player(&player_id, |player| {
                    if !volume.is_finite() {
                        return Err("音量必须是有限数值".into());
                    }
                    player
                        .mpv
                        .set_property("volume", volume.clamp(0.0, 100.0))
                        .map_err(map_mpv_error)
                });
                let _ = reply.send(result);
            }
            Request::Status { player_id, reply } => {
                let result = self.with_player(&player_id, |player| status_of(player));
                let _ = reply.send(result);
            }
            Request::SetSurface {
                player_id,
                surface,
                reply,
            } => {
                let result = self
                    .require(&player_id)
                    .and_then(|_| self.set_surface(surface));
                let _ = reply.send(result);
            }
        }
    }

    fn init(&mut self, player_id: String) -> Result<PlayerStatus, String> {
        self.destroy();
        self.area.make_current();
        if let Some(error) = self.area.error() {
            return Err(format!("无法创建 GTK OpenGL 上下文: {error}"));
        }
        ensure_gl_loaded()?;
        let mut mpv = create_mpv()?;
        let wayland_display = wayland_display()?;
        let mut render = RenderContext::new(
            unsafe { mpv.ctx.as_mut() },
            [
                RenderParam::ApiType(RenderParamApiType::OpenGl),
                RenderParam::InitParams(OpenGLInitParams {
                    get_proc_address,
                    ctx: (),
                }),
                RenderParam::WaylandDisplay(wayland_display),
            ],
        )
        .map_err(map_mpv_error)?;
        let render_sender = self.render_sender.clone();
        render.set_update_callback(move || {
            let _ = render_sender.send(());
        });
        *self.player.borrow_mut() = Some(NativePlayer {
            mpv,
            render,
            path: String::new(),
        });
        self.active_id = Some(player_id);
        self.area.queue_render();
        self.with_player(self.active_id.as_deref().unwrap_or_default(), |player| {
            status_of(player)
        })
    }

    fn destroy(&mut self) {
        self.area.make_current();
        self.player.borrow_mut().take();
        self.active_id = None;
        self.surface.borrow_mut().crop = None;
        self.area.set_size_request(1, 1);
        self.area.set_margin_start(0);
        self.area.set_margin_top(0);
        self.area.hide();
    }

    fn require(&self, player_id: &str) -> Result<(), String> {
        if self.active_id.as_deref() == Some(player_id) && self.player.borrow().is_some() {
            Ok(())
        } else {
            Err("播放器未初始化".into())
        }
    }

    fn with_player<T>(
        &self,
        player_id: &str,
        callback: impl FnOnce(&mut NativePlayer) -> Result<T, String>,
    ) -> Result<T, String> {
        self.require(player_id)?;
        let mut player = self.player.borrow_mut();
        callback(player.as_mut().expect("player checked above"))
    }

    fn set_surface(&mut self, config: SurfaceConfig) -> Result<bool, String> {
        if !config.x.is_finite()
            || !config.y.is_finite()
            || !config.width.is_finite()
            || !config.height.is_finite()
        {
            return Err("播放器表面坐标必须是有限数值".into());
        }
        *self.surface.borrow_mut() = SurfaceState { crop: config.crop };
        let width = config.width.max(1.0).round() as i32;
        let height = config.height.max(1.0).round() as i32;
        self.area.set_margin_start(config.x.max(0.0).round() as i32);
        self.area.set_margin_top(config.y.max(0.0).round() as i32);
        self.area.set_size_request(width, height);
        if config.visible && config.width > 1.0 && config.height > 1.0 {
            self.area.show();
            self.area.queue_render();
            Ok(true)
        } else {
            self.area.hide();
            Ok(false)
        }
    }
}

struct NativePlayer {
    // Rust drops struct fields in declaration order. libmpv requires its render
    // context to be freed before the owning mpv handle.
    render: RenderContext,
    mpv: Mpv,
    path: String,
}

fn create_mpv() -> Result<Mpv, String> {
    unsafe {
        let locale = CString::new("C").unwrap();
        libc::setlocale(libc::LC_NUMERIC, locale.as_ptr());
    }
    Mpv::with_initializer(|init| {
        init.set_property("vo", "libmpv")?;
        init.set_property("hwdec", "auto-safe")?;
        init.set_property("hwdec-codecs", "all")?;
        init.set_property("keep-open", "yes")?;
        init.set_property("idle", "yes")?;
        init.set_property("osc", false)?;
        init.set_property("input-default-bindings", false)?;
        init.set_property("input-vo-keyboard", false)?;
        init.set_property("terminal", false)?;
        init.set_property("msg-level", "all=warn")?;
        init.set_property("pause", true)?;
        Ok(())
    })
    .map_err(|error| format!("创建 GPU libmpv 失败: {error}"))
}

fn status_of(player: &NativePlayer) -> Result<PlayerStatus, String> {
    let pause = status_property(player.mpv.get_property("pause"), true)?;
    let time_pos = status_property(player.mpv.get_property("time-pos"), 0.0)?;
    let duration = status_property(player.mpv.get_property("duration"), 0.0)?;
    let source_width = status_property(player.mpv.get_property("width"), 0_i64)?;
    let source_height = status_property(player.mpv.get_property("height"), 0_i64)?;
    let display_width = status_property(player.mpv.get_property("dwidth"), source_width)?;
    let display_height = status_property(player.mpv.get_property("dheight"), source_height)?;
    let rotation = status_property(player.mpv.get_property("video-out-params/rotate"), 0_i64)?;
    let (width, height) = rotated_dimensions(display_width, display_height, rotation);
    let eof = status_property(player.mpv.get_property("eof-reached"), false)?;
    let hwdec = status_property(player.mpv.get_property("hwdec-current"), String::new())?;
    Ok(PlayerStatus {
        available: true,
        ready: !player.path.is_empty() && width > 0 && height > 0,
        path: player.path.clone(),
        pause,
        time_pos: time_pos.max(0.0),
        duration: duration.max(0.0),
        width,
        height,
        source_width,
        source_height,
        eof,
        renderer: "gpu".into(),
        hwdec,
    })
}

fn status_property<T>(result: libmpv2::Result<T>, fallback: T) -> Result<T, String> {
    match result {
        Ok(value) => Ok(value),
        Err(libmpv2::Error::Raw(code)) if code == mpv_error::PropertyUnavailable => Ok(fallback),
        Err(error) => Err(map_mpv_error(error)),
    }
}

fn map_mpv_error(error: libmpv2::Error) -> String {
    format!("mpv: {error}")
}

#[link(name = "EGL")]
extern "C" {
    fn eglGetProcAddress(name: *const c_char) -> *mut c_void;
}

#[link(name = "gdk-3")]
extern "C" {
    fn gdk_wayland_display_get_wl_display(display: *mut gdk::ffi::GdkDisplay) -> *mut c_void;
}

fn wayland_display() -> Result<*const c_void, String> {
    use glib::translate::ToGlibPtr;
    let display = gdk::Display::default().ok_or("找不到 GDK 显示器")?;
    let display = unsafe { gdk_wayland_display_get_wl_display(display.to_glib_none().0) };
    if display.is_null() {
        return Err("无法取得 Wayland wl_display".into());
    }
    Ok(display.cast_const())
}

fn get_proc_address(_: &(), name: &str) -> *mut c_void {
    let Ok(name) = CString::new(name) else {
        return std::ptr::null_mut();
    };
    unsafe { eglGetProcAddress(name.as_ptr()) }
}

fn ensure_gl_loaded() -> Result<(), String> {
    static GL_LOADED: Once = Once::new();
    GL_LOADED.call_once(|| {
        gl::load_with(|name| get_proc_address(&(), name).cast_const());
    });
    if gl::Viewport::is_loaded() && gl::Clear::is_loaded() && gl::Scissor::is_loaded() {
        Ok(())
    } else {
        Err("GTK OpenGL 上下文未提供所需的 OpenGL 函数".into())
    }
}

fn draw_crop(crop: &Option<SurfaceCrop>, width: i32, height: i32, scale: i32) {
    let Some(crop) = crop else { return };
    let x = (crop.x * scale as f64).round() as i32;
    let y = (crop.y * scale as f64).round() as i32;
    let crop_width = (crop.width * scale as f64).round() as i32;
    let crop_height = (crop.height * scale as f64).round() as i32;
    if crop_width <= 0 || crop_height <= 0 {
        return;
    }
    let left = x.clamp(0, width - 1);
    let right = (x + crop_width).clamp(left + 1, width);
    let top = y.clamp(0, height - 1);
    let bottom = (y + crop_height).clamp(top + 1, height);
    let thickness = (2 * scale).clamp(1, 8);
    unsafe {
        gl::Enable(gl::SCISSOR_TEST);
        gl::ClearColor(0.92, 0.22, 0.54, 1.0);
        clear_scissor(left, height - top - thickness, right - left, thickness);
        clear_scissor(left, height - bottom, right - left, thickness);
        clear_scissor(left, height - bottom, thickness, bottom - top);
        clear_scissor(right - thickness, height - bottom, thickness, bottom - top);
        gl::Disable(gl::SCISSOR_TEST);
    }
}

unsafe fn clear_scissor(x: i32, y: i32, width: i32, height: i32) {
    if width > 0 && height > 0 {
        gl::Scissor(x, y, width, height);
        gl::Clear(gl::COLOR_BUFFER_BIT);
    }
}
