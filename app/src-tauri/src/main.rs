#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent_ipc;
#[cfg(target_os = "linux")]
mod mpv_gpu;
mod mpv_player;
#[cfg(target_os = "windows")]
mod mpv_windows;

use md5::{Digest, Md5};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager};

#[derive(Clone, Serialize)]
struct Progress {
    percent: f32,
    file_percent: f32,
    file_index: usize,
    file_count: usize,
    fps: f32,
    detail: String,
    time_seconds: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_path: Option<String>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OutputOptions {
    mode: String,
    #[serde(default)]
    name_template: String,
    #[serde(default)]
    subdirectory: String,
    #[serde(default)]
    directory: String,
    #[serde(default)]
    preset_name: String,
    #[serde(default)]
    resolution: String,
    #[serde(default)]
    fps_label: String,
    #[serde(default)]
    codec_label: String,
    #[serde(default)]
    bitrate_label: String,
    #[serde(default)]
    unique_name: bool,
}

fn sanitize_filename_component(value: &str) -> String {
    value
        .trim()
        .chars()
        .filter(|character| !character.is_whitespace())
        .map(|character| {
            if character.is_control()
                || matches!(
                    character,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                )
            {
                '_'
            } else {
                character
            }
        })
        .collect::<String>()
        .trim_end_matches(['.', ' '])
        .to_string()
}

fn ensure_simple_relative_dir(value: &str) -> Result<PathBuf, String> {
    let path = Path::new(value.trim());
    if value.trim().is_empty()
        || path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err("子目录必须位于原文件目录内".into());
    }
    Ok(path.to_path_buf())
}

fn output_paths_equal(input: &Path, output: &Path) -> bool {
    if cfg!(windows) {
        input
            .to_string_lossy()
            .eq_ignore_ascii_case(&output.to_string_lossy())
    } else {
        input == output
    }
}

fn unique_output_path(path: PathBuf) -> Result<PathBuf, String> {
    if !path.exists() {
        return Ok(path);
    }
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| format!("无法为同名输出生成唯一文件名: {}", path.display()))?;
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    for index in 2..=1_000_000_u32 {
        let filename = if extension.is_empty() {
            format!("{stem}_{index}")
        } else {
            format!("{stem}_{index}.{extension}")
        };
        let candidate = parent.join(filename);
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(format!("无法为同名输出生成唯一文件名: {}", path.display()))
}

fn resolve_output_path(
    input: &str,
    options: Option<&OutputOptions>,
    default_suffix: &str,
    extension: &str,
) -> Result<PathBuf, String> {
    let input_path = Path::new(input);
    let parent = input_path.parent().unwrap_or_else(|| Path::new("."));
    let stem = input_path
        .file_stem()
        .and_then(|value| value.to_str())
        .map(sanitize_filename_component)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("无法解析输入文件名: {input}"))?;
    let extension = extension.trim_start_matches('.');
    let default_name = format!("{stem}{default_suffix}.{extension}");
    let output = match options.map(|value| value.mode.as_str()).unwrap_or("source") {
        "source" | "" => {
            let preset = options
                .map(|value| sanitize_filename_component(&value.preset_name))
                .filter(|value| !value.is_empty());
            parent.join(
                preset
                    .map(|value| format!("{stem}_{value}.{extension}"))
                    .unwrap_or(default_name),
            )
        }
        "rename" => {
            let template = options
                .map(|value| value.name_template.trim())
                .filter(|value| !value.is_empty())
                .unwrap_or("{name}{suffix}");
            let rendered = template
                .replace("{name}", &stem)
                .replace("{suffix}", default_suffix)
                .replace(
                    "{preset}",
                    options
                        .map(|value| value.preset_name.as_str())
                        .unwrap_or(""),
                )
                .replace(
                    "{res}",
                    options
                        .map(|value| value.resolution.as_str())
                        .unwrap_or("orig"),
                )
                .replace(
                    "{resolution}",
                    options
                        .map(|value| value.resolution.as_str())
                        .unwrap_or("orig"),
                )
                .replace(
                    "{fps}",
                    options
                        .map(|value| value.fps_label.as_str())
                        .unwrap_or("orig"),
                )
                .replace(
                    "{codec}",
                    options
                        .map(|value| value.codec_label.as_str())
                        .unwrap_or("enc"),
                )
                .replace(
                    "{bitrate}",
                    options
                        .map(|value| value.bitrate_label.as_str())
                        .unwrap_or("default"),
                )
                .replace("{ext}", extension);
            let rendered = sanitize_filename_component(&rendered);
            if rendered.is_empty() || Path::new(&rendered).components().count() != 1 {
                return Err("文件名模板不能包含目录路径".into());
            }
            let mut file_name = PathBuf::from(rendered);
            file_name.set_extension(extension);
            parent.join(file_name)
        }
        "subdir" => parent
            .join(ensure_simple_relative_dir(
                options
                    .map(|value| value.subdirectory.as_str())
                    .unwrap_or(""),
            )?)
            .join(default_name),
        "fixed" => Path::new(
            options
                .map(|value| value.directory.trim())
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "请选择固定输出目录".to_string())?,
        )
        .join(default_name),
        mode => return Err(format!("未知的输出位置模式: {mode}")),
    };
    let output = if options.is_some_and(|value| value.unique_name) {
        unique_output_path(output)?
    } else {
        output
    };
    if output_paths_equal(input_path, &output) {
        return Err("输出文件不能覆盖原文件".into());
    }
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("无法创建输出目录 {}: {error}", parent.display()))?;
    }
    Ok(output)
}

/// 解析 ffmpeg 的 `time=HH:MM:SS.ss` 为秒
fn parse_time_to_secs(t: &str) -> Option<f32> {
    let parts: Vec<&str> = t.split(':').collect();
    if parts.len() != 3 {
        return None;
    }
    let h: f32 = parts[0].parse().ok()?;
    let m: f32 = parts[1].parse().ok()?;
    let s: f32 = parts[2].parse().ok()?;
    Some(h * 3600.0 + m * 60.0 + s)
}

fn parse_progress(line: &str, duration: f32) -> Option<Progress> {
    let t = line.split("time=").nth(1)?.split_whitespace().next()?;
    let secs = parse_time_to_secs(t)?;
    let percent = if duration > 0.0 {
        (secs / duration * 100.0).min(100.0)
    } else {
        0.0
    };
    let fps = line
        .split("fps=")
        .nth(1)
        .and_then(|s| s.split(',').next())
        .and_then(|s| s.trim().parse::<f32>().ok())
        .unwrap_or(0.0);
    Some(Progress {
        percent,
        file_percent: percent,
        file_index: 1,
        file_count: 1,
        fps,
        detail: format!("time={}", t),
        time_seconds: secs,
        source_path: None,
    })
}

#[derive(Clone, Copy)]
struct ProgressContext {
    file_index: usize,
    file_count: usize,
    phase_index: usize,
    phase_count: usize,
}

impl ProgressContext {
    fn single() -> Self {
        Self {
            file_index: 0,
            file_count: 1,
            phase_index: 0,
            phase_count: 1,
        }
    }

    fn aggregate(self, local_percent: f32) -> f32 {
        let file_count = self.file_count.max(1) as f32;
        let phase_count = self.phase_count.max(1) as f32;
        let phase_progress =
            (self.phase_index as f32 + local_percent.clamp(0.0, 100.0) / 100.0) / phase_count;
        ((self.file_index as f32 + phase_progress) / file_count * 100.0).clamp(0.0, 100.0)
    }
}

fn emit_progress_value(
    window: &tauri::Window,
    stage: &str,
    source_path: Option<&str>,
    context: ProgressContext,
    local_percent: f32,
    time_seconds: f32,
    fps: f32,
) {
    let file_index = context.file_index + 1;
    let file_count = context.file_count.max(1);
    let _ = window.emit(
        "ffmpeg-progress",
        Progress {
            percent: context.aggregate(local_percent),
            file_percent: local_percent.clamp(0.0, 100.0),
            file_index,
            file_count,
            fps,
            detail: format!(
                "({file_index}/{file_count}) {stage} | time={}",
                format_progress_time(time_seconds)
            ),
            time_seconds,
            source_path: source_path.map(str::to_string),
        },
    );
}

fn format_progress_time(seconds: f32) -> String {
    let seconds = seconds.max(0.0);
    let hours = (seconds / 3600.0).floor() as u32;
    let minutes = ((seconds % 3600.0) / 60.0).floor() as u32;
    let secs = seconds % 60.0;
    format!("{hours:02}:{minutes:02}:{secs:06.3}")
}

/// 向前端推送一条日志（对应原 ActivityLog 行）
fn emit_log(window: &tauri::Window, line: &str) {
    let _ = window.emit("ffmpeg-log", line.to_string());
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskLogEvent {
    kind: String,
    queue_index: usize,
    queue_total: usize,
    filename: String,
    source_path: String,
    tone: String,
    message: String,
}

fn emit_file_log(
    window: &tauri::Window,
    kind: &str,
    queue_index: usize,
    queue_total: usize,
    source_path: &str,
    tone: &str,
    message: &str,
) {
    let filename = Path::new(source_path)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(source_path)
        .to_string();
    let _ = window.emit(
        "ffmpeg-log",
        TaskLogEvent {
            kind: kind.to_string(),
            queue_index,
            queue_total,
            filename,
            source_path: source_path.to_string(),
            tone: tone.to_string(),
            message: message.to_string(),
        },
    );
}

/// 通用：spawn ffmpeg，逐行解析进度并推事件，返回 (success, last_stderr)
type ActiveFfmpeg = Arc<Mutex<Option<Child>>>;

static ACTIVE_FFMPEG: OnceLock<Mutex<HashMap<String, ActiveFfmpeg>>> = OnceLock::new();
static GIF_CANCEL_FLAGS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
static DIT_CANCEL_FLAGS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
static DIT_TEMP_SEQUENCE: AtomicUsize = AtomicUsize::new(0);

fn active_ffmpeg() -> &'static Mutex<HashMap<String, ActiveFfmpeg>> {
    ACTIVE_FFMPEG.get_or_init(|| Mutex::new(HashMap::new()))
}

fn gif_cancel_flags() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    GIF_CANCEL_FLAGS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn dit_cancel_flags() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    DIT_CANCEL_FLAGS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn summarize_ffmpeg_stderr(lines: &VecDeque<String>) -> String {
    const SIGNALS: [&str; 8] = [
        "error",
        "failed",
        "invalid",
        "could not",
        "not supported",
        "unsupported",
        "unable",
        "cannot",
    ];
    let diagnostics = lines
        .iter()
        .filter(|line| {
            let lower = line.to_ascii_lowercase();
            SIGNALS.iter().any(|signal| lower.contains(signal))
                && lower.trim() != "conversion failed!"
        })
        .rev()
        .take(4)
        .collect::<Vec<_>>();
    if !diagnostics.is_empty() {
        return diagnostics
            .into_iter()
            .rev()
            .cloned()
            .collect::<Vec<_>>()
            .join("\n");
    }
    lines
        .iter()
        .rev()
        .take(6)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .cloned()
        .collect::<Vec<_>>()
        .join("\n")
}

fn run_with_progress_source(
    args: &[String],
    duration: f32,
    window: &tauri::Window,
    stage: &str,
    source_path: Option<&str>,
    context: ProgressContext,
) -> Result<(), String> {
    let key = window.label().to_string();
    let active = Arc::new(Mutex::new(None));
    let mut active_child = active.lock().map_err(|error| error.to_string())?;
    {
        let mut processes = active_ffmpeg().lock().map_err(|error| error.to_string())?;
        if processes.contains_key(&key) {
            return Err("已有任务正在运行".into());
        }
        processes.insert(key.clone(), active.clone());
    }

    let mut cmd = Command::new("ffmpeg");
    cmd.args(["-progress", "pipe:2", "-nostats"])
        .args(args)
        .stderr(Stdio::piped());
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(error) => {
            active_ffmpeg()
                .lock()
                .map_err(|lock_error| lock_error.to_string())?
                .remove(&key);
            return Err(format!("无法启动 ffmpeg: {error}"));
        }
    };
    let Some(stderr) = child.stderr.take() else {
        let _ = child.kill();
        let _ = child.wait();
        active_ffmpeg()
            .lock()
            .map_err(|error| error.to_string())?
            .remove(&key);
        return Err("无法读取 ffmpeg 错误输出".to_string());
    };
    *active_child = Some(child);
    drop(active_child);
    let mut stderr_tail = VecDeque::with_capacity(24);
    let mut latest_fps = 0.0_f32;
    let mut latest_time = 0.0_f32;
    for line in BufReader::new(stderr).lines().flatten() {
        let trimmed = line.trim();
        if let Some(value) = trimmed.strip_prefix("fps=") {
            latest_fps = value.trim().parse::<f32>().unwrap_or(latest_fps);
            continue;
        }
        let machine_time = trimmed
            .strip_prefix("out_time=")
            .and_then(parse_time_to_secs)
            .or_else(|| {
                trimmed
                    .strip_prefix("out_time_us=")
                    .and_then(|value| value.parse::<f64>().ok())
                    .map(|value| (value / 1_000_000.0) as f32)
            });
        if let Some(seconds) = machine_time {
            latest_time = seconds.max(0.0);
            let local_percent = if duration > 0.0 {
                latest_time / duration * 100.0
            } else {
                0.0
            };
            emit_progress_value(
                window,
                stage,
                source_path,
                context,
                local_percent,
                latest_time,
                latest_fps,
            );
            continue;
        }
        if trimmed == "progress=end" {
            emit_progress_value(
                window,
                stage,
                source_path,
                context,
                100.0,
                if duration > 0.0 {
                    duration
                } else {
                    latest_time
                },
                latest_fps,
            );
            continue;
        }
        if trimmed.starts_with("progress=")
            || trimmed.starts_with("frame=")
            || trimmed.starts_with("bitrate=")
            || trimmed.starts_with("total_size=")
            || trimmed.starts_with("out_time_ms=")
            || trimmed.starts_with("dup_frames=")
            || trimmed.starts_with("drop_frames=")
            || trimmed.starts_with("speed=")
        {
            continue;
        }
        if let Some(p) = parse_progress(trimmed, duration) {
            emit_progress_value(
                window,
                stage,
                source_path,
                context,
                p.percent,
                p.time_seconds,
                p.fps,
            );
        } else if !trimmed.is_empty() {
            if stderr_tail.len() == 24 {
                stderr_tail.pop_front();
            }
            stderr_tail.push_back(line);
        }
    }
    let status = active
        .lock()
        .map_err(|error| error.to_string())?
        .take()
        .ok_or_else(|| "任务已取消".to_string())?
        .wait()
        .map_err(|error| error.to_string());
    active_ffmpeg()
        .lock()
        .map_err(|error| error.to_string())?
        .remove(&key);
    let status = status?;
    if status.success() {
        emit_log(window, &format!("[PASS] {} 完成", stage));
        Ok(())
    } else {
        let msg = summarize_ffmpeg_stderr(&stderr_tail);
        let msg = if msg.is_empty() {
            "未知错误".to_string()
        } else {
            msg
        };
        emit_log(window, &format!("[FAIL] {}: {}", stage, msg));
        Err(format!("ffmpeg 失败: {}", msg))
    }
}

fn run_with_progress(
    args: &[String],
    duration: f32,
    window: &tauri::Window,
    stage: &str,
) -> Result<(), String> {
    run_with_progress_source(
        args,
        duration,
        window,
        stage,
        None,
        ProgressContext::single(),
    )
}

#[tauri::command]
fn cancel_ffmpeg(window: tauri::Window) -> Result<bool, String> {
    let gif_cancelled = if let Some(cancelled) = gif_cancel_flags()
        .lock()
        .map_err(|error| error.to_string())?
        .get(window.label())
        .cloned()
    {
        cancelled.store(true, Ordering::Relaxed);
        true
    } else {
        false
    };
    let dit_cancelled = if let Some(cancelled) = dit_cancel_flags()
        .lock()
        .map_err(|error| error.to_string())?
        .get(window.label())
        .cloned()
    {
        cancelled.store(true, Ordering::Relaxed);
        true
    } else {
        false
    };
    let active = active_ffmpeg()
        .lock()
        .map_err(|error| error.to_string())?
        .get(window.label())
        .cloned();
    let Some(active) = active else {
        if dit_cancelled {
            emit_log(&window, "[CANCEL] 正在停止 DIT 备份任务");
        }
        return Ok(gif_cancelled || dit_cancelled);
    };
    let mut child = active.lock().map_err(|error| error.to_string())?;
    if let Some(process) = child.as_mut() {
        process.kill().map_err(|error| error.to_string())?;
        emit_log(&window, "[CANCEL] 正在停止 FFmpeg 任务");
        Ok(true)
    } else {
        if gif_cancelled {
            emit_log(&window, "[CANCEL] 正在停止 Gifski 编码");
        }
        Ok(gif_cancelled || dit_cancelled)
    }
}

async fn run_blocking<F, T>(task: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| format!("任务线程失败: {error}"))?
}

fn null_device() -> &'static str {
    if cfg!(windows) {
        "NUL"
    } else {
        "/dev/null"
    }
}

fn probe_duration(path: &str) -> f32 {
    let out = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=nw=1:nk=1",
            path,
        ])
        .output();
    if let Ok(o) = out {
        String::from_utf8_lossy(&o.stdout)
            .trim()
            .parse::<f32>()
            .unwrap_or(0.0)
    } else {
        0.0
    }
}

fn display_dimensions_from_probe(probe: &Value) -> Option<(i32, i32)> {
    let stream = probe["streams"]
        .as_array()?
        .iter()
        .find(|stream| stream["codec_type"] == "video")?;
    let mut width = stream["width"].as_i64()? as i32;
    let mut height = stream["height"].as_i64()? as i32;
    let rotation = stream["side_data_list"]
        .as_array()
        .and_then(|items| items.iter().find_map(|item| item["rotation"].as_i64()))
        .or_else(|| {
            stream["tags"]["rotate"]
                .as_str()
                .and_then(|value| value.parse::<i64>().ok())
        })
        .unwrap_or(0);
    if rotation.rem_euclid(180) == 90 {
        std::mem::swap(&mut width, &mut height);
    }
    Some((width, height))
}

fn probe_display_dimensions(path: &str) -> Result<(i32, i32), String> {
    let output = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=codec_type,width,height:stream_tags=rotate:stream_side_data=rotation",
            "-of",
            "json",
            path,
        ])
        .output()
        .map_err(|error| format!("无法探测视频尺寸: {error}"))?;
    let probe: Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("无法解析视频尺寸: {error}"))?;
    display_dimensions_from_probe(&probe).ok_or_else(|| "视频尺寸无效".into())
}

fn clamp_crop_to_dimensions(
    crop: Option<(i32, i32, i32, i32)>,
    dimensions: (i32, i32),
) -> Option<(i32, i32, i32, i32)> {
    let (x, y, width, height) = crop?;
    let (video_width, video_height) = dimensions;
    if video_width <= 0 || video_height <= 0 || width <= 0 || height <= 0 {
        return None;
    }
    let x = x.clamp(0, video_width.saturating_sub(1));
    let y = y.clamp(0, video_height.saturating_sub(1));
    let width = width.min(video_width - x).max(1);
    let height = height.min(video_height - y).max(1);
    Some((x, y, width, height))
}

fn sanitize_crop_for_input(
    input: &str,
    crop: Option<(i32, i32, i32, i32)>,
) -> Result<Option<(i32, i32, i32, i32)>, String> {
    match crop {
        Some(crop) => Ok(clamp_crop_to_dimensions(
            Some(crop),
            probe_display_dimensions(input)?,
        )),
        None => Ok(None),
    }
}

/// 常见视频扩展名
fn is_video(p: &str) -> bool {
    let low = p.to_lowercase();
    [
        "mp4", "mov", "mkv", "avi", "webm", "m4v", "flv", "wmv", "ts", "m2ts",
    ]
    .iter()
    .any(|e| low.ends_with(e))
}

/// 把目录展开为其中的视频文件列表（recursive 控制是否递归）
fn expand_inputs(paths: &[String], recursive: bool) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for p in paths {
        let meta = std::fs::metadata(p);
        if let Ok(m) = meta {
            if m.is_dir() {
                collect_dir(p, recursive, &mut out);
            } else {
                out.push(p.clone());
            }
        } else {
            out.push(p.clone());
        }
    }
    let mut seen = std::collections::HashSet::new();
    out.retain(|path| seen.insert(normalized_path_text(Path::new(path))));
    out
}

fn collect_dir(dir: &str, recursive: bool, out: &mut Vec<String>) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            let path = e.path();
            if path.is_dir() {
                if recursive {
                    collect_dir(&path.to_string_lossy(), recursive, out);
                }
            } else {
                let s = path.to_string_lossy().to_string();
                if is_video(&s) {
                    out.push(s);
                }
            }
        }
    }
}

/* ════════════ Alpha 工具命令（精确复刻） ════════════ */

fn compose_alpha_blocking(
    input: String,
    fps: Option<f32>,
    output_options: Option<OutputOptions>,
    window: tauri::Window,
) -> Result<String, String> {
    let output = resolve_output_path(&input, output_options.as_ref(), "_alpha", "mov")?
        .to_string_lossy()
        .to_string();
    let info = get_info_map(&input);
    let full_h = info.get("height").and_then(|v| v.as_i64()).unwrap_or(0) as i64;
    let rgb_h = full_h / 2;
    let vf = format!(
        "[0:v]crop={w}:{h}:0:0[rgb];[0:v]crop={w}:{h}:0:{h},format=gray,geq=lum=255:p=0[alpha];[rgb][alpha]alphamerge[out]",
        w = info.get("width").and_then(|v| v.as_i64()).unwrap_or(0),
        h = rgb_h,
    );
    let mut args = vec![
        "-y".into(),
        "-i".into(),
        input.clone(),
        "-filter_complex".into(),
        vf,
        "-c:v".into(),
        "prores_ks".into(),
        "-profile:v".into(),
        "4444".into(),
        "-pix_fmt".into(),
        "yuva444p10le".into(),
    ];
    if let Some(f) = fps {
        args.push("-r".into());
        args.push(f.to_string());
    }
    args.push("-c:a".into());
    args.push("copy".into());
    args.push(output.clone());
    emit_log(&window, &format!("输入: {}", input));
    run_with_progress(&args, 0.0, &window, "合成透明通道")?;
    emit_log(&window, &format!("输出位置: {output}"));
    Ok(output)
}

fn screenshot_blocking(
    input: String,
    time_sec: f32,
    width: i32,
    height: i32,
    crop: Option<(i32, i32, i32, i32)>,
    output_options: Option<OutputOptions>,
    window: tauri::Window,
) -> Result<String, String> {
    let suffix = format!("_screenshot_{time_sec:.2}s");
    let output = resolve_output_path(&input, output_options.as_ref(), &suffix, "png")?
        .to_string_lossy()
        .to_string();
    let crop = sanitize_crop_for_input(&input, crop)?;
    let mut vf = Vec::new();
    if let Some((x, y, w, h)) = crop {
        if w > 0 && h > 0 {
            vf.push(format!("crop={w}:{h}:{x}:{y}"));
        }
    }
    vf.push(format!("scale={width}:{height}"));
    let args = vec![
        "-y".into(),
        "-ss".into(),
        time_sec.to_string(),
        "-i".into(),
        input.clone(),
        "-vframes".into(),
        "1".into(),
        "-vf".into(),
        vf.join(","),
        output.clone(),
    ];
    emit_log(
        &window,
        &format!("截图: {} @ {:.3}s -> {}", input, time_sec, output.clone()),
    );
    run_with_progress(&args, 0.0, &window, "截图")?;
    emit_log(&window, &format!("输出位置: {output}"));
    Ok(output)
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum GifCompression {
    Optimized,
    Compact,
    Aggressive,
}

impl GifCompression {
    fn parse(value: Option<&str>) -> Result<Self, String> {
        match value.unwrap_or("optimized") {
            "optimized" => Ok(Self::Optimized),
            "compact" => Ok(Self::Compact),
            "aggressive" => Ok(Self::Aggressive),
            // Keep presets created by the earlier FFmpeg-only implementation usable.
            "quality" => Ok(Self::Optimized),
            "smallest" => Ok(Self::Aggressive),
            value => Err(format!("不支持的 GIF 压缩方式: {value}")),
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Optimized => "智能压缩",
            Self::Compact => "体积优先",
            Self::Aggressive => "极限压缩",
        }
    }

    fn gifski_quality(self) -> (u8, u8, u8) {
        match self {
            Self::Optimized => (70, 70, 70),
            Self::Compact => (60, 60, 60),
            Self::Aggressive => (50, 40, 50),
        }
    }
}

fn gif_palette_filter(video_filter: &str, fps: f32, compression: GifCompression) -> String {
    let (max_colors, stats_mode) = match compression {
        GifCompression::Optimized => (256, "full"),
        GifCompression::Compact => (192, "diff"),
        GifCompression::Aggressive => (128, "diff"),
    };
    format!(
        "{video_filter},fps={fps},palettegen=max_colors={max_colors}:reserve_transparent=1:stats_mode={stats_mode}"
    )
}

fn gif_render_filter(video_filter: &str, fps: f32, compression: GifCompression) -> String {
    let dither = match compression {
        GifCompression::Optimized => "sierra2_4a",
        GifCompression::Compact => "bayer:bayer_scale=3",
        GifCompression::Aggressive => "bayer:bayer_scale=5",
    };
    format!(
        "[0:v]{video_filter},fps={fps}[frames];[frames][1:v]paletteuse=dither={dither}:diff_mode=rectangle:alpha_threshold=128"
    )
}

struct GifskiProgress {
    window: tauri::Window,
    cancelled: Arc<AtomicBool>,
    frames_written: AtomicUsize,
    total_frames: usize,
    fps: f32,
}

impl gifski::progress::ProgressReporter for GifskiProgress {
    fn increase(&mut self) -> bool {
        let frame = self.frames_written.fetch_add(1, Ordering::Relaxed) + 1;
        let percent = (frame as f32 / self.total_frames.max(1) as f32 * 100.0).min(100.0);
        let _ = self.window.emit(
            "ffmpeg-progress",
            Progress {
                percent,
                file_percent: percent,
                file_index: 1,
                file_count: 1,
                fps: self.fps,
                detail: format!("Gifski 编码 | {frame}/{} 帧", self.total_frames),
                time_seconds: frame as f32 / self.fps,
                source_path: None,
            },
        );
        !self.cancelled.load(Ordering::Relaxed)
    }
}

fn export_gif_with_gifski(
    input: &str,
    output: &str,
    start: f32,
    duration: f32,
    fps: f32,
    width: i32,
    height: i32,
    video_filter: &str,
    compression: GifCompression,
    window: &tauri::Window,
) -> Result<(), String> {
    let key = window.label().to_string();
    let cancelled = Arc::new(AtomicBool::new(false));
    let active = Arc::new(Mutex::new(None));
    if active_ffmpeg()
        .lock()
        .map_err(|error| error.to_string())?
        .contains_key(&key)
    {
        return Err("已有任务正在运行".into());
    }

    let (quality, lossy_quality, motion_quality) = compression.gifski_quality();
    let settings = gifski::Settings {
        width: None,
        height: None,
        quality,
        fast: false,
        repeat: gifski::Repeat::Infinite,
    };
    let (collector, mut writer) = gifski::new(settings).map_err(|error| error.to_string())?;
    #[allow(deprecated)]
    writer.set_lossy_quality(lossy_quality);
    #[allow(deprecated)]
    writer.set_motion_quality(motion_quality);

    let output_file =
        std::fs::File::create(output).map_err(|error| format!("无法创建 GIF 输出文件: {error}"))?;
    let total_frames = (duration * fps).ceil().max(1.0) as usize;
    let args = [
        "-nostdin".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
        "-ss".to_string(),
        start.to_string(),
        "-t".to_string(),
        duration.to_string(),
        "-i".to_string(),
        input.to_string(),
        "-vf".to_string(),
        format!("{video_filter},fps={fps}"),
        "-an".to_string(),
        "-sn".to_string(),
        "-f".to_string(),
        "rawvideo".to_string(),
        "-pix_fmt".to_string(),
        "rgba".to_string(),
        "pipe:1".to_string(),
    ];
    let mut command = Command::new("ffmpeg");
    command
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| format!("无法启动 ffmpeg 解码器: {error}"))?;
    let (stdout, stderr) = match (child.stdout.take(), child.stderr.take()) {
        (Some(stdout), Some(stderr)) => (stdout, stderr),
        _ => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("无法读取 ffmpeg 管道".into());
        }
    };
    *active.lock().map_err(|error| error.to_string())? = Some(child);
    {
        let mut processes = active_ffmpeg().lock().map_err(|error| error.to_string())?;
        if processes.contains_key(&key) {
            if let Some(mut child) = active.lock().map_err(|error| error.to_string())?.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
            return Err("已有任务正在运行".into());
        }
        processes.insert(key.clone(), active.clone());
    }
    gif_cancel_flags()
        .lock()
        .map_err(|error| error.to_string())?
        .insert(key.clone(), cancelled.clone());

    let writer_window = window.clone();
    let writer_cancelled = cancelled.clone();
    let writer_thread = match thread::Builder::new()
        .name("gifski-writer".into())
        .spawn(move || {
            let mut progress = GifskiProgress {
                window: writer_window,
                cancelled: writer_cancelled,
                frames_written: AtomicUsize::new(0),
                total_frames,
                fps,
            };
            writer
                .write(output_file, &mut progress)
                .map_err(|error| error.to_string())
        }) {
        Ok(thread) => thread,
        Err(error) => {
            if let Some(mut child) = active.lock().map_err(|error| error.to_string())?.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
            active_ffmpeg()
                .lock()
                .map_err(|error| error.to_string())?
                .remove(&key);
            gif_cancel_flags()
                .lock()
                .map_err(|error| error.to_string())?
                .remove(&key);
            return Err(format!("无法启动 Gifski 编码线程: {error}"));
        }
    };

    let stderr_thread = thread::spawn(move || {
        BufReader::new(stderr)
            .lines()
            .map_while(Result::ok)
            .last()
            .unwrap_or_default()
    });
    let frame_size = width as usize * height as usize * 4;
    let mut reader = BufReader::new(stdout);
    let mut frame_index = 0usize;
    let mut collect_error = None;
    loop {
        let mut bytes = vec![0_u8; frame_size];
        match reader.read_exact(&mut bytes) {
            Ok(()) => {
                let pixels = bytes
                    .chunks_exact(4)
                    .map(|pixel| {
                        gifski::collector::RGBA8::new(pixel[0], pixel[1], pixel[2], pixel[3])
                    })
                    .collect();
                let frame = gifski::collector::ImgVec::new(pixels, width as usize, height as usize);
                if let Err(error) =
                    collector.add_frame_rgba(frame_index, frame, frame_index as f64 / fps as f64)
                {
                    collect_error = Some(error.to_string());
                    if let Some(process) = active
                        .lock()
                        .map_err(|lock_error| lock_error.to_string())?
                        .as_mut()
                    {
                        let _ = process.kill();
                    }
                    break;
                }
                frame_index += 1;
            }
            Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(error) => {
                collect_error = Some(format!("读取 ffmpeg 帧失败: {error}"));
                if let Some(process) = active
                    .lock()
                    .map_err(|lock_error| lock_error.to_string())?
                    .as_mut()
                {
                    let _ = process.kill();
                }
                break;
            }
        }
    }
    drop(collector);

    let status = active
        .lock()
        .map_err(|error| error.to_string())?
        .take()
        .ok_or("GIF 任务已取消")?
        .wait()
        .map_err(|error| error.to_string())?;
    let stderr_last = stderr_thread.join().unwrap_or_default();
    let writer_join = writer_thread.join();
    active_ffmpeg()
        .lock()
        .map_err(|error| error.to_string())?
        .remove(&key);
    gif_cancel_flags()
        .lock()
        .map_err(|error| error.to_string())?
        .remove(&key);
    let writer_result = writer_join.map_err(|_| "Gifski 编码线程异常退出".to_string())?;

    if cancelled.load(Ordering::Relaxed) {
        return Err("任务已取消".into());
    }
    if let Some(error) = collect_error {
        return Err(format!("Gifski 接收帧失败: {error}"));
    }
    if !status.success() {
        return Err(format!("ffmpeg 解码失败: {stderr_last}"));
    }
    if frame_index == 0 {
        return Err("没有解码到可用于 GIF 的视频帧".into());
    }
    writer_result.map_err(|error| format!("Gifski 编码失败: {error}"))
}

fn unique_gif_palette_path() -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "shadowencoder-gif-palette-{}-{stamp}.png",
        std::process::id()
    ))
}

fn export_gif_blocking(
    input: String,
    start: f32,
    duration: f32,
    fps: f32,
    width: i32,
    height: i32,
    compression: GifCompression,
    crop: Option<(i32, i32, i32, i32)>,
    output_options: Option<OutputOptions>,
    window: tauri::Window,
) -> Result<String, String> {
    if !start.is_finite() || start < 0.0 {
        return Err("GIF 起始时间必须是大于或等于 0 的有限数值".into());
    }
    if !duration.is_finite() || duration <= 0.0 {
        return Err("GIF 时长必须是大于 0 的有限数值".into());
    }
    if !fps.is_finite() || !(1.0..=60.0).contains(&fps) {
        return Err("GIF 帧率必须在 1 到 60 之间".into());
    }
    if !(1..=8192).contains(&width) || !(1..=8192).contains(&height) {
        return Err("GIF 输出尺寸必须在 1 到 8192 像素之间".into());
    }
    let output = resolve_output_path(&input, output_options.as_ref(), "", "gif")?
        .to_string_lossy()
        .to_string();
    let crop = sanitize_crop_for_input(&input, crop)?;
    let mut vf = Vec::new();
    if let Some((x, y, w, h)) = crop {
        if w > 0 && h > 0 {
            vf.push(format!("crop={w}:{h}:{x}:{y}"));
        }
    }
    vf.push(format!("scale={width}:{height}:flags=lanczos"));
    vf.push("format=rgba".into());
    let vf_s = vf.join(",");
    emit_log(
        &window,
        &format!(
            "导出 GIF (Gifski · {})：{} -> {}",
            compression.label(),
            input,
            output
        ),
    );
    let gifski_result = export_gif_with_gifski(
        &input,
        &output,
        start,
        duration,
        fps,
        width,
        height,
        &vf_s,
        compression,
        &window,
    );
    if gifski_result.is_ok() {
        emit_log(&window, &format!("输出位置: {output}"));
        return Ok(output);
    }
    let gifski_error = gifski_result.unwrap_err();
    let _ = std::fs::remove_file(&output);
    if gifski_error == "任务已取消" || gifski_error == "GIF 任务已取消" {
        return Err(gifski_error);
    }
    emit_log(
        &window,
        &format!("[WARN] {gifski_error}，改用 FFmpeg 兼容模式"),
    );

    let palette = unique_gif_palette_path();
    let p = palette.to_string_lossy().to_string();
    let a1 = vec![
        "-y".into(),
        "-ss".into(),
        start.to_string(),
        "-t".into(),
        duration.to_string(),
        "-i".into(),
        input.clone(),
        "-vf".into(),
        gif_palette_filter(&vf_s, fps, compression),
        "-frames:v".into(),
        "1".into(),
        p.clone(),
    ];
    let a2 = vec![
        "-y".into(),
        "-ss".into(),
        start.to_string(),
        "-t".into(),
        duration.to_string(),
        "-i".into(),
        input.clone(),
        "-i".into(),
        p.clone(),
        "-filter_complex".into(),
        gif_render_filter(&vf_s, fps, compression),
        "-loop".into(),
        "0".into(),
        output.clone(),
    ];
    let result = (|| {
        run_with_progress(&a1, duration, &window, "GIF 调色板")?;
        run_with_progress(&a2, duration, &window, "导出 GIF")
    })();
    let _ = std::fs::remove_file(&p);
    result.map_err(|fallback_error| {
        format!("Gifski 失败: {gifski_error}; FFmpeg 回退也失败: {fallback_error}")
    })?;
    emit_log(&window, &format!("输出位置: {output}"));
    Ok(output)
}

fn export_webp_blocking(
    input: String,
    start: f32,
    duration: f32,
    fps: f32,
    width: i32,
    height: i32,
    quality: i32,
    crop: Option<(i32, i32, i32, i32)>,
    output_options: Option<OutputOptions>,
    window: tauri::Window,
) -> Result<String, String> {
    let output = resolve_output_path(&input, output_options.as_ref(), "", "webp")?
        .to_string_lossy()
        .to_string();
    let dur = probe_duration(&input);
    let crop = sanitize_crop_for_input(&input, crop)?;
    let mut vf = Vec::new();
    if let Some((x, y, w, h)) = crop {
        if w > 0 && h > 0 {
            vf.push(format!("crop={w}:{h}:{x}:{y}"));
        }
    }
    vf.push(format!("scale={width}:{height}:flags=lanczos"));
    let args = vec![
        "-y".into(),
        "-ss".into(),
        start.to_string(),
        "-i".into(),
        input.clone(),
        "-t".into(),
        duration.to_string(),
        "-vf".into(),
        vf.join(","),
        "-c:v".into(),
        "libwebp".into(),
        "-quality".into(),
        quality.to_string(),
        "-preset".into(),
        "default".into(),
        "-an".into(),
        "-r".into(),
        fps.to_string(),
        "-fps_mode".into(),
        "cfr".into(),
        output.clone(),
    ];
    emit_log(&window, &format!("导出 WebP: {} -> {}", input, output));
    run_with_progress(&args, dur, &window, "导出 WebP")?;
    emit_log(&window, &format!("输出位置: {output}"));
    Ok(output)
}

fn normalized_segment_profile(codec: &str, profile: &str) -> String {
    if !matches!(codec, "prores" | "prores_ks") {
        return profile.to_string();
    }
    match profile.to_ascii_lowercase().as_str() {
        "422proxy" | "proxy" => "proxy",
        "422lt" | "lt" => "lt",
        "422" | "standard" => "standard",
        "422hq" | "hq" => "hq",
        "4444" => "4444",
        "4444xq" => "4444xq",
        _ => profile,
    }
    .to_string()
}

fn segment_video_args(
    out_format: &str,
    video_codec: &str,
    video_profile: &str,
    pixel_format: &str,
    crf: i32,
    video_bitrate: i32,
) -> Vec<String> {
    let fallback = video_codec.is_empty() || video_codec == "copy";
    let codec = if fallback {
        if out_format.eq_ignore_ascii_case("mov") {
            "prores_ks"
        } else {
            "libx264"
        }
    } else if video_codec == "prores" {
        "prores_ks"
    } else {
        video_codec
    };
    let mut args = vec!["-c:v".into(), codec.into()];
    let profile = if fallback && codec == "prores_ks" {
        "4444".to_string()
    } else if fallback && codec == "libx264" {
        "main".to_string()
    } else {
        normalized_segment_profile(codec, video_profile)
    };
    if !profile.is_empty() {
        args.extend(["-profile:v".into(), profile]);
    }
    let pix_fmt = if !pixel_format.is_empty() {
        pixel_format
    } else if codec == "prores_ks" && fallback {
        "yuva444p10le"
    } else if codec == "libx264" {
        "yuv420p"
    } else {
        ""
    };
    if !pix_fmt.is_empty() {
        args.extend(["-pix_fmt".into(), pix_fmt.into()]);
    }
    if matches!(
        codec,
        "libx264" | "libx265" | "libvpx" | "libvpx-vp9" | "libaom-av1"
    ) && crf > 0
    {
        args.extend(["-crf".into(), crf.to_string()]);
    } else if video_bitrate > 0 {
        args.extend(["-b:v".into(), format!("{}k", video_bitrate)]);
    }
    args
}

fn segment_audio_args(out_format: &str, audio_codec: &str, audio_bitrate: i32) -> Vec<String> {
    let codec = if audio_codec.is_empty() {
        match out_format.to_ascii_lowercase().as_str() {
            "mp4" | "m4v" | "3gp" | "flv" => "aac",
            "webm" => "libopus",
            _ => "copy",
        }
    } else {
        audio_codec
    };
    let mut args = vec!["-c:a".into(), codec.into()];
    let supports_bitrate = matches!(
        codec,
        "aac" | "libopus" | "mp3" | "libmp3lame" | "ac3" | "eac3" | "libvorbis"
    );
    if supports_bitrate && audio_bitrate > 0 {
        args.extend(["-b:a".into(), format!("{}k", audio_bitrate)]);
    } else if matches!(codec, "aac" | "libopus") {
        args.extend(["-b:a".into(), "192k".into()]);
    }
    args
}

fn export_segment_blocking(
    input: String,
    start: f32,
    duration: f32,
    fps: f32,
    width: i32,
    height: i32,
    out_format: String,
    crop: Option<(i32, i32, i32, i32)>,
    video_codec: String,
    video_profile: String,
    pixel_format: String,
    crf: i32,
    video_bitrate: i32,
    audio_codec: String,
    audio_bitrate: i32,
    output_options: Option<OutputOptions>,
    window: tauri::Window,
) -> Result<String, String> {
    let output = resolve_output_path(&input, output_options.as_ref(), "_clip", &out_format)?
        .to_string_lossy()
        .to_string();
    let dur = probe_duration(&input);
    let crop = sanitize_crop_for_input(&input, crop)?;
    let mut vf = Vec::new();
    if let Some((x, y, w, h)) = crop {
        if w > 0 && h > 0 {
            vf.push(format!("crop={w}:{h}:{x}:{y}"));
        }
    }
    if width > 0 && height > 0 {
        vf.push(format!("scale={width}:{height}"));
    }
    let mut args = vec![
        "-y".into(),
        "-ss".into(),
        start.to_string(),
        "-i".into(),
        input.clone(),
        "-t".into(),
        duration.to_string(),
    ];
    if !vf.is_empty() {
        args.push("-vf".into());
        args.push(vf.join(","));
    }
    args.extend(segment_video_args(
        &out_format,
        &video_codec,
        &video_profile,
        &pixel_format,
        crf,
        video_bitrate,
    ));
    args.extend(segment_audio_args(&out_format, &audio_codec, audio_bitrate));
    if fps > 0.0 {
        args.push("-r".into());
        args.push(fps.to_string());
    }
    args.push(output.clone());
    emit_log(&window, &format!("截取片段: {} -> {}", input, output));
    if let Err(error) = run_with_progress(&args, dur, &window, "截取片段") {
        let _ = std::fs::remove_file(&output);
        return Err(error);
    }
    emit_log(&window, &format!("输出位置: {output}"));
    Ok(output)
}

/* ════════════ 原 ShadowEncoder 命令（功能等价版） ════════════ */

fn cleanup_passlog(prefix: &Path) {
    let Some(directory) = prefix.parent() else {
        return;
    };
    let Some(prefix_name) = prefix.file_name().and_then(|name| name.to_str()) else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        if entry.file_name().to_string_lossy().starts_with(prefix_name) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

fn transcode_blocking(
    paths: Vec<String>,
    video_codec: String,
    video_profile: String,
    crf: i32,
    speed_preset: String,
    tune: String,
    style: i32,
    pixel_format: String,
    container: String,
    scale_w: i32,
    scale_h: i32,
    fps: f32,
    video_bitrate: i32,
    audio_codec: String,
    audio_profile: String,
    audio_bitrate: i32,
    audio_sample_rate: i32,
    audio_channels: i32,
    unsharp: i32,
    denoise: i32,
    loudnorm: bool,
    audio_only: bool,
    keep_res: bool,
    rate_mode: String,
    target_file_size_mb: f64,
    two_pass: bool,
    output_options: Option<OutputOptions>,
    window: tauri::Window,
) -> Result<Vec<String>, String> {
    let _ = keep_res; // 缩放由 scale_w/scale_h 决定，保留字段以兼容前端
    let files = expand_inputs(&paths, false);
    emit_log(&window, &format!("开始转码，共 {} 个文件", files.len()));

    let vc = video_codec.as_str();
    // libx264 / libx265 支持 profile / preset / tune；其它编码器按需忽略
    let supports_pp = matches!(vc, "libx264" | "libx265");

    // -tune：显式 tune 优先；否则用 style（原“风格”语义）兜底
    let tune_value: Option<String> = if !tune.is_empty() && tune != "none" {
        Some(tune.clone())
    } else {
        match style {
            1 => Some("film".to_string()),
            2 => Some("animation".to_string()),
            _ => None,
        }
    };

    let ext = if container.is_empty() {
        "mp4"
    } else {
        container.as_str()
    };
    let mut outputs = Vec::new();

    for (file_index, p) in files.iter().enumerate() {
        emit_file_log(
            &window,
            "file_start",
            file_index + 1,
            files.len(),
            p,
            "normal",
            "等待处理",
        );
        let dur = probe_duration(p);
        let out = resolve_output_path(p, output_options.as_ref(), "_se", ext)?
            .to_string_lossy()
            .to_string();

        // ── 仅音频 / 视频流复制：视频直接 copy，只处理封装与音频轨 ──
        if audio_only || vc == "copy" {
            let mut c = vec![
                "-y".into(),
                "-i".into(),
                p.clone(),
                "-c:v".into(),
                "copy".into(),
            ];
            c.push("-c:a".into());
            if audio_codec == "copy" || audio_codec.is_empty() {
                c.push("copy".into());
            } else {
                c.push(audio_codec.clone());
                if audio_bitrate > 0 {
                    c.push("-b:a".into());
                    c.push(format!("{}k", audio_bitrate));
                }
                if audio_sample_rate > 0 {
                    c.push("-ar".into());
                    c.push(audio_sample_rate.to_string());
                }
                if audio_channels > 0 {
                    c.push("-ac".into());
                    c.push(audio_channels.to_string());
                }
            }
            // 音频也是 copy 时不能挂滤镜（-af 与 -c:a copy 互斥）
            if loudnorm && audio_codec != "copy" && !audio_codec.is_empty() {
                c.push("-af".into());
                c.push("loudnorm=I=-9:TP=0:LRA=7".into());
            }
            c.push(out.clone());
            emit_log(&window, &format!("视频流复制，处理封装/音频: {}", p));
            run_with_progress_source(
                &c,
                dur,
                &window,
                "音频处理",
                Some(p),
                ProgressContext {
                    file_index,
                    file_count: files.len(),
                    phase_index: 0,
                    phase_count: 1,
                },
            )?;
            emit_log(&window, &format!("输出位置: {out}"));
            outputs.push(out);
            emit_file_log(
                &window,
                "file_end",
                file_index + 1,
                files.len(),
                p,
                "pass",
                "处理完成",
            );
            continue;
        }

        // ── 视频质量参数（CRF / 固定码率 / 按目标文件体积）──
        // 码控模式：filesize > bitrate > crf（兼容旧调用：rate_mode 为空时按 video_bitrate>0 判）
        let is_filesize = rate_mode == "filesize" && target_file_size_mb > 0.0;
        let is_bitrate = rate_mode == "bitrate" || (rate_mode.is_empty() && video_bitrate > 0);
        // 按目标文件体积计算码率（每文件不同，需用 ffprobe 取时长）
        let eff_bitrate = if is_filesize {
            let target_bits = target_file_size_mb * 8_388_608.0; // MB → bits (1024*1024*8)
            if dur > 0.0 {
                let abr = if audio_bitrate > 0 && !audio_codec.is_empty() && audio_codec != "copy" {
                    audio_bitrate as f64
                } else {
                    0.0
                };
                let vbr = (target_bits / 1000.0 - abr * dur as f64) / dur as f64;
                (vbr.max(0.0).round() as i32).max(1)
            } else {
                video_bitrate
            }
        } else if is_bitrate {
            video_bitrate
        } else {
            0
        };
        let mut quality: Vec<String> = vec!["-c:v".into(), vc.to_string()];
        if supports_pp && !video_profile.is_empty() {
            quality.push("-profile:v".into());
            quality.push(video_profile.clone());
        }
        if supports_pp && !speed_preset.is_empty() {
            quality.push("-preset".into());
            quality.push(speed_preset.clone());
        }
        if let Some(t) = &tune_value {
            quality.push("-tune".into());
            quality.push(t.clone());
        }
        if !pixel_format.is_empty() {
            quality.push("-pix_fmt".into());
            quality.push(pixel_format.clone());
        }
        match vc {
            "libx264" | "libx265" | "libvpx" | "libvpx-vp9" => {
                if is_bitrate || is_filesize {
                    quality.push("-b:v".into());
                    quality.push(format!("{}k", eff_bitrate));
                } else {
                    quality.push("-crf".into());
                    quality.push(crf.to_string());
                    // VP8/VP9 的 CRF 模式需显式 -b:v 0
                    if vc == "libvpx-vp9" || vc == "libvpx" {
                        quality.push("-b:v".into());
                        quality.push("0".into());
                    }
                }
            }
            _ => {
                // mpeg4 / mpeg2 / av1 等不支持 CRF：用固定码率（未指定给默认）
                let vb = if is_bitrate || is_filesize {
                    eff_bitrate
                } else {
                    2000
                };
                quality.push("-b:v".into());
                quality.push(format!("{}k", vb));
            }
        }

        // ── 视频滤镜链 ──
        let mut vf: Vec<String> = Vec::new();
        if scale_w > 0 && scale_h > 0 {
            vf.push(format!("scale={}:{}", scale_w, scale_h));
        }
        if fps > 0.0 {
            vf.push(format!("fps={}", fps));
        }
        if unsharp > 0 {
            vf.push("unsharp=5:5:1.5:5:5:0".into());
        }
        if denoise > 0 {
            vf.push("hqdn3d".into());
        }
        let vf_str = if vf.is_empty() {
            String::new()
        } else {
            vf.join(",")
        };

        // ── 音频参数 ──
        let mut audio: Vec<String> = vec!["-c:a".into()];
        if audio_codec == "copy" {
            audio.push("copy".into());
        } else {
            audio.push(audio_codec.clone());
            if audio_bitrate > 0 {
                audio.push("-b:a".into());
                audio.push(format!("{}k", audio_bitrate));
            }
            if audio_sample_rate > 0 {
                audio.push("-ar".into());
                audio.push(audio_sample_rate.to_string());
            }
            if audio_channels > 0 {
                audio.push("-ac".into());
                audio.push(audio_channels.to_string());
            }
            if audio_codec == "aac" && !audio_profile.is_empty() && audio_profile != "lc" {
                let ap = match audio_profile.as_str() {
                    "he" => "aac_he",
                    "he_v2" => "aac_he_v2",
                    _ => "aac_low",
                };
                audio.push("-profile:a".into());
                audio.push(ap.to_string());
            }
        }

        let af = if loudnorm {
            Some("loudnorm=I=-9:TP=0:LRA=7".to_string())
        } else {
            None
        };

        let mut output_args = vec!["-y".into(), "-i".into(), p.clone()];
        output_args.extend(quality.iter().cloned());
        if !vf_str.is_empty() {
            output_args.push("-vf".into());
            output_args.push(vf_str.clone());
        }
        output_args.extend(audio.iter().cloned());
        if let Some(a) = &af {
            output_args.push("-af".into());
            output_args.push(a.clone());
        }
        output_args.push("-f".into());
        output_args.push(ext.to_string());
        emit_log(&window, &format!("转码: {}", p));
        let use_two_pass = two_pass
            && (is_bitrate || is_filesize)
            && matches!(vc, "libx264" | "libx265" | "libvpx" | "libvpx-vp9");
        if use_two_pass {
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let passlog = std::env::temp_dir().join(format!(
                "shadowencoder-pass-{}-{stamp}-{file_index}",
                std::process::id()
            ));
            let passlog_arg = passlog.to_string_lossy().to_string();
            let mut first_pass = vec!["-y".into(), "-i".into(), p.clone()];
            first_pass.extend(quality.iter().cloned());
            if !vf_str.is_empty() {
                first_pass.extend(["-vf".into(), vf_str.clone()]);
            }
            first_pass.extend([
                "-an".into(),
                "-pass".into(),
                "1".into(),
                "-passlogfile".into(),
                passlog_arg.clone(),
                "-f".into(),
                "null".into(),
                null_device().into(),
            ]);
            output_args.extend([
                "-pass".into(),
                "2".into(),
                "-passlogfile".into(),
                passlog_arg,
                out.clone(),
            ]);
            let result = (|| {
                run_with_progress_source(
                    &first_pass,
                    dur,
                    &window,
                    "转码 Pass1",
                    Some(p),
                    ProgressContext {
                        file_index,
                        file_count: files.len(),
                        phase_index: 0,
                        phase_count: 2,
                    },
                )?;
                run_with_progress_source(
                    &output_args,
                    dur,
                    &window,
                    "转码 Pass2",
                    Some(p),
                    ProgressContext {
                        file_index,
                        file_count: files.len(),
                        phase_index: 1,
                        phase_count: 2,
                    },
                )
            })();
            cleanup_passlog(&passlog);
            result?;
        } else {
            output_args.push(out.clone());
            run_with_progress_source(
                &output_args,
                dur,
                &window,
                "转码",
                Some(p),
                ProgressContext {
                    file_index,
                    file_count: files.len(),
                    phase_index: 0,
                    phase_count: 1,
                },
            )?;
        }
        emit_log(&window, &format!("输出位置: {out}"));
        outputs.push(out);
        emit_file_log(
            &window,
            "file_end",
            file_index + 1,
            files.len(),
            p,
            "pass",
            "转码完成",
        );
    }
    emit_log(&window, "[PASS] 全部转码完成");
    Ok(outputs)
}

fn mix_blocking(
    paths: Vec<String>,
    loudnorm_i: f32,
    loudnorm_tp: f32,
    loudnorm_lra: f32,
    compand_threshold: f32,
    compand_gain: f32,
    loudnorm_on: bool,
    compand_on: bool,
    output_options: Option<OutputOptions>,
    window: tauri::Window,
) -> Result<Vec<String>, String> {
    let files = expand_inputs(&paths, false);
    emit_log(&window, &format!("开始混音，共 {} 个文件", files.len()));
    let mut outputs = Vec::new();
    for (file_index, p) in files.iter().enumerate() {
        emit_file_log(
            &window,
            "file_start",
            file_index + 1,
            files.len(),
            p,
            "normal",
            "等待混音",
        );
        let dur = probe_duration(p);
        let out = resolve_output_path(p, output_options.as_ref(), "_mix", "mp4")?
            .to_string_lossy()
            .to_string();
        // 按开关逐项拼接音频滤镜链；关闭的项不进入实际命令
        let mut filters: Vec<String> = Vec::new();
        if compand_on {
            // 压缩阈值作为转移曲线拐点：input=阈值 时 output=阈值+18（与原固定曲线 -27/-9 一致）
            let th = compand_threshold.clamp(-70.0, -5.0);
            filters.push(format!(
                "compand=attacks=0.3:decays=0.8:points=-80/-80|-45/-15|{th}/{thp}|0/-7|20/-7:soft-knee=6:gain={gain}:volume=-90:delay=0.2",
                th = th, thp = th + 18.0, gain = compand_gain,
            ));
        }
        if loudnorm_on {
            filters.push(format!(
                "loudnorm=I={i}:TP={tp}:LRA={lra}",
                i = loudnorm_i,
                tp = loudnorm_tp,
                lra = loudnorm_lra
            ));
        }
        let af = filters.join(",");
        let mut args: Vec<String> = vec![
            "-y".into(),
            "-i".into(),
            p.clone(),
            "-c:v".into(),
            "copy".into(),
        ];
        if !af.is_empty() {
            args.push("-af".into());
            args.push(af);
        }
        args.push("-c:a".into());
        args.push("aac".into());
        args.push("-b:a".into());
        args.push("320k".into());
        args.push(out.clone());
        emit_log(&window, &format!("混音: {}", p));
        run_with_progress_source(
            &args,
            dur,
            &window,
            "混音",
            Some(p),
            ProgressContext {
                file_index,
                file_count: files.len(),
                phase_index: 0,
                phase_count: 1,
            },
        )?;
        emit_log(&window, &format!("输出位置: {out}"));
        outputs.push(out);
        emit_file_log(
            &window,
            "file_end",
            file_index + 1,
            files.len(),
            p,
            "pass",
            "混音完成",
        );
    }
    emit_log(&window, "[PASS] 全部混音完成");
    Ok(outputs)
}

#[derive(Serialize)]
struct CheckSummary {
    pass: i32,
    pass_with_warnings: i32,
    fail: i32,
}

fn check_blocking(
    paths: Vec<String>,
    fps_tolerance: f32,
    recursive: bool,
    black_detect: bool,
    expected_width: i32,
    expected_height: i32,
    expected_fps: f32,
    expected_codec: String,
    window: tauri::Window,
) -> Result<CheckSummary, String> {
    let mut sum = CheckSummary {
        pass: 0,
        pass_with_warnings: 0,
        fail: 0,
    };
    let files = expand_inputs(&paths, recursive);
    emit_log(&window, &format!("开始检测，共 {} 个文件", files.len()));
    let standard_fps: [f32; 8] = [23.976, 24.0, 25.0, 29.97, 30.0, 50.0, 59.94, 60.0];
    for (file_index, p) in files.iter().enumerate() {
        let progress_context = ProgressContext {
            file_index,
            file_count: files.len(),
            phase_index: 0,
            phase_count: 1,
        };
        emit_progress_value(
            &window,
            "检测素材",
            Some(p),
            progress_context,
            0.0,
            0.0,
            0.0,
        );
        emit_file_log(
            &window,
            "file_start",
            file_index + 1,
            files.len(),
            p,
            "normal",
            "等待检测",
        );
        let out = Command::new("ffprobe")
            .args([
                "-v",
                "error",
                "-show_entries",
                "stream=width,height,r_frame_rate,codec_type,bit_rate,codec_name,pix_fmt",
                "-show_entries",
                "format=duration",
                "-of",
                "json",
                p,
            ])
            .output()
            .map_err(|e| e.to_string())?;
        let v: Value = serde_json::from_slice(&out.stdout).unwrap_or(Value::Null);
        emit_log(&window, &format!("检查目标: {}", p));
        let streams = v["streams"].as_array().cloned().unwrap_or_default();
        let video = streams.iter().find(|s| s["codec_type"] == "video");
        let audio = streams.iter().any(|s| s["codec_type"] == "audio");
        if video.is_none() {
            emit_log(&window, &format!("[FAIL] 无视频流: {}", p));
            sum.fail += 1;
            emit_file_log(
                &window,
                "file_end",
                file_index + 1,
                files.len(),
                p,
                "fail",
                "检测失败",
            );
            emit_progress_value(
                &window,
                "检测素材",
                Some(p),
                progress_context,
                100.0,
                0.0,
                0.0,
            );
            continue;
        }
        let vid = video.unwrap();
        let width = vid["width"].as_i64().unwrap_or(0);
        let height = vid["height"].as_i64().unwrap_or(0);
        let codec = vid["codec_name"].as_str().unwrap_or("").to_string();
        let fr = vid["r_frame_rate"]
            .as_str()
            .unwrap_or("0/1")
            .split('/')
            .collect::<Vec<&str>>();
        let fps = if fr.len() == 2 {
            let a = fr[0].parse::<f32>().unwrap_or(0.0);
            let b = fr[1].parse::<f32>().unwrap_or(1.0);
            if b > 0.0 {
                a / b
            } else {
                0.0
            }
        } else {
            0.0
        };
        let mut warns: Vec<String> = Vec::new();
        if width <= 0 || height <= 0 {
            emit_log(
                &window,
                &format!("[FAIL] 分辨率异常 {}x{}: {}", width, height, p),
            );
            sum.fail += 1;
            emit_file_log(
                &window,
                "file_end",
                file_index + 1,
                files.len(),
                p,
                "fail",
                "检测失败",
            );
            emit_progress_value(
                &window,
                "检测素材",
                Some(p),
                progress_context,
                100.0,
                0.0,
                0.0,
            );
            continue;
        }
        if width % 2 != 0 || height % 2 != 0 {
            warns.push(format!("分辨率为奇数 {}x{}", width, height));
        }
        if !audio {
            warns.push("缺少音轨".into());
        }
        // 编码规范对照：与所选编码预设逐项比对
        if expected_width > 0 && expected_height > 0 {
            if width != expected_width as i64 || height != expected_height as i64 {
                warns.push(format!(
                    "分辨率不符 期望 {}x{} 实际 {}x{}",
                    expected_width, expected_height, width, height
                ));
            }
        }
        if expected_fps > 0.0 && fps > 0.0 {
            if (expected_fps - fps).abs() > fps_tolerance.max(0.01) {
                warns.push(format!("帧率不符 期望 {:.3} 实际 {:.3}", expected_fps, fps));
            }
        }
        if !expected_codec.is_empty() {
            if codec != expected_codec {
                warns.push(format!("编码器不符 期望 {} 实际 {}", expected_codec, codec));
            }
        }
        // 标准帧率偏离（仅在未指定期望帧率时检查）
        if expected_fps <= 0.0 {
            let nearest = standard_fps
                .iter()
                .copied()
                .min_by(|a, b| (a - fps).abs().partial_cmp(&(b - fps).abs()).unwrap())
                .unwrap_or(fps);
            if (nearest - fps).abs() > fps_tolerance.max(0.01) {
                warns.push(format!("帧率 {:.3} 偏离标准 {:.3}", fps, nearest));
            }
        }
        // 黑帧检测（启用时，检测开头是否有黑色帧）
        if black_detect {
            let _b_out = Command::new("ffmpeg")
                .args([
                    "-v",
                    "quiet",
                    "-i",
                    p,
                    "-vf",
                    "blackframe=amount=99:threshold=32",
                    "-f",
                    "null",
                    null_device(),
                ])
                .output();
            // 黑帧检测为可选的辅助项：不阻断主流程，忽略执行错误
        }
        if warns.is_empty() {
            emit_log(
                &window,
                &format!("[PASS] 通过: {} ({}x{} {:.3}fps)", p, width, height, fps),
            );
            sum.pass += 1;
            emit_file_log(
                &window,
                "file_end",
                file_index + 1,
                files.len(),
                p,
                "pass",
                "检测通过",
            );
        } else {
            emit_log(
                &window,
                &format!(
                    "[PASS_WITH_WARNINGS] {} ({}x{} {:.3}fps) 警告: {}",
                    p,
                    width,
                    height,
                    fps,
                    warns.join("; ")
                ),
            );
            sum.pass_with_warnings += 1;
            emit_file_log(
                &window,
                "file_end",
                file_index + 1,
                files.len(),
                p,
                "warn",
                "检测完成，有警告",
            );
        }
        emit_progress_value(
            &window,
            "检测素材",
            Some(p),
            progress_context,
            100.0,
            0.0,
            0.0,
        );
    }
    let _ = fps_tolerance;
    Ok(sum)
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DitBackupRequest {
    source_paths: Vec<String>,
    #[serde(default)]
    extensions: Vec<String>,
    min_size_bytes: Option<u64>,
    #[serde(default)]
    media_only: bool,
    #[serde(default = "default_true")]
    recursive: bool,
    operation: String,
    destinations: Vec<String>,
    #[serde(default)]
    verify_md5: bool,
    #[serde(default)]
    rename_template: String,
    #[serde(default)]
    directory_name_template: String,
    #[serde(default)]
    flatten_subdirectories: bool,
    #[serde(default)]
    conflict_strategy: String,
    #[serde(default)]
    conflict_rename_template: String,
    #[serde(default)]
    conflict_subdirectory: String,
    #[serde(default = "default_true")]
    reuse_identical: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DitBackupFileResult {
    source_path: String,
    output_paths: Vec<String>,
    success: bool,
    error: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DitBackupSummary {
    total_files: usize,
    completed_files: usize,
    failed_files: usize,
    skipped_files: usize,
    cancelled: bool,
    results: Vec<DitBackupFileResult>,
}

fn normalized_path_text(path: &Path) -> String {
    let value = path.to_string_lossy().replace('/', "\\");
    if cfg!(windows) {
        value.to_lowercase()
    } else {
        value
    }
}

fn path_is_within(path: &Path, parent: &Path) -> bool {
    let path = normalized_path_text(path);
    let mut parent = normalized_path_text(parent);
    if !parent.ends_with('\\') {
        parent.push('\\');
    }
    path == parent.trim_end_matches('\\') || path.starts_with(&parent)
}

fn canonicalize_destination_candidate(path: &Path) -> Result<PathBuf, String> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|error| format!("无法读取当前目录: {error}"))?
            .join(path)
    };
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    let existing = normalized
        .ancestors()
        .find(|candidate| candidate.exists())
        .ok_or_else(|| format!("目标目录没有可访问的父目录: {}", path.display()))?;
    let suffix = normalized
        .strip_prefix(existing)
        .map_err(|error| format!("无法解析目标目录 {}: {error}", path.display()))?;
    let mut canonical = std::fs::canonicalize(existing)
        .map_err(|error| format!("无法访问目标目录父级 {}: {error}", existing.display()))?;
    canonical.push(suffix);
    Ok(canonical)
}

fn normalized_extensions(values: &[String]) -> std::collections::HashSet<String> {
    values
        .iter()
        .flat_map(|value| value.split([',', ';', ' ', '\n', '\r']))
        .map(|value| value.trim().trim_start_matches('.').to_lowercase())
        .filter(|value| !value.is_empty())
        .collect()
}

fn is_dit_media_extension(extension: &str) -> bool {
    matches!(
        extension,
        "3g2"
            | "3gp"
            | "aif"
            | "aiff"
            | "aac"
            | "ac3"
            | "alac"
            | "amr"
            | "ape"
            | "ari"
            | "arw"
            | "avif"
            | "asf"
            | "avi"
            | "bmp"
            | "braw"
            | "caf"
            | "cin"
            | "cr2"
            | "cr3"
            | "crm"
            | "dng"
            | "dpx"
            | "dts"
            | "eac3"
            | "exr"
            | "flac"
            | "flv"
            | "gif"
            | "heic"
            | "heif"
            | "ico"
            | "jpeg"
            | "jpg"
            | "m2ts"
            | "m4a"
            | "m4v"
            | "mka"
            | "mkv"
            | "mov"
            | "mp2"
            | "mp3"
            | "mp4"
            | "mpeg"
            | "mpg"
            | "mts"
            | "mxf"
            | "nef"
            | "ogg"
            | "ogv"
            | "opus"
            | "orf"
            | "pcm"
            | "png"
            | "r3d"
            | "raf"
            | "raw"
            | "rm"
            | "rmvb"
            | "rw2"
            | "tga"
            | "tif"
            | "tiff"
            | "ts"
            | "vob"
            | "wav"
            | "webm"
            | "webp"
            | "wma"
            | "wmv"
    )
}

#[derive(Clone)]
struct DitSourceFile {
    path: PathBuf,
    relative_path: PathBuf,
    source_root_name: Option<String>,
    source_root_index: usize,
}

fn dit_file_matches(
    path: &Path,
    metadata: &std::fs::Metadata,
    extensions: &std::collections::HashSet<String>,
    min_size: Option<u64>,
    media_only: bool,
) -> bool {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_lowercase();
    (!media_only || is_dit_media_extension(&extension))
        && (extensions.is_empty() || extensions.contains(&extension))
        && !min_size.is_some_and(|minimum| metadata.len() < minimum)
}

fn collect_dit_files(
    root: &Path,
    recursive: bool,
    extensions: &std::collections::HashSet<String>,
    min_size: Option<u64>,
    media_only: bool,
) -> Result<(Vec<DitSourceFile>, usize), String> {
    let mut pending = vec![root.to_path_buf()];
    let mut files = Vec::new();
    let mut skipped = 0usize;
    while let Some(directory) = pending.pop() {
        let entries = std::fs::read_dir(&directory)
            .map_err(|error| format!("无法读取目录 {}: {error}", directory.display()))?;
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(metadata) = std::fs::symlink_metadata(&path) else {
                skipped += 1;
                continue;
            };
            if metadata.file_type().is_symlink() {
                skipped += 1;
                continue;
            }
            if metadata.is_dir() {
                if recursive {
                    pending.push(path);
                }
                continue;
            }
            if !metadata.is_file() {
                skipped += 1;
                continue;
            }
            if !dit_file_matches(&path, &metadata, extensions, min_size, media_only) {
                skipped += 1;
                continue;
            }
            let relative_path = path.strip_prefix(root).unwrap_or(&path).to_path_buf();
            files.push(DitSourceFile {
                path,
                relative_path,
                source_root_name: None,
                source_root_index: 0,
            });
        }
    }
    files.sort_by(|a, b| normalized_path_text(&a.path).cmp(&normalized_path_text(&b.path)));
    Ok((files, skipped))
}

fn render_dit_filename(path: &Path, template: &str, index: usize) -> Result<String, String> {
    let original = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| format!("无法解析文件名: {}", path.display()))?;
    if template.trim().is_empty() {
        return Ok(original.to_string());
    }
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    let rendered = template
        .replace("{name}", stem)
        .replace("{index}", &format!("{index:04}"))
        .replace("{ext}", extension);
    let mut rendered = sanitize_filename_component(&rendered);
    if rendered.is_empty() || Path::new(&rendered).components().count() != 1 {
        return Err("文件重命名模板不能生成目录路径或空文件名".into());
    }
    let mut value = PathBuf::from(rendered);
    value.set_extension(extension);
    rendered = value.to_string_lossy().to_string();
    Ok(rendered)
}

fn render_dit_directory_name(
    original_name: &str,
    template: &str,
    source_index: usize,
) -> Result<String, String> {
    if template.trim().is_empty() {
        return Ok(original_name.to_string());
    }
    let rendered = template
        .replace("{name}", original_name)
        .replace("{index}", &format!("{source_index:04}"));
    let rendered = sanitize_filename_component(&rendered);
    if rendered.is_empty() || Path::new(&rendered).components().count() != 1 {
        return Err("备份目录名称模板不能生成目录路径或空名称".into());
    }
    Ok(rendered)
}

fn dit_source_root_name(path: &Path) -> Result<String, String> {
    if let Some(name) = path.file_name().and_then(|value| value.to_str()) {
        if !name.is_empty() {
            return Ok(name.to_string());
        }
    }
    let fallback = path
        .to_string_lossy()
        .trim_end_matches(['\\', '/'])
        .trim_end_matches(':')
        .rsplit(['\\', '/'])
        .next()
        .map(sanitize_filename_component)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("无法解析素材目录名称: {}", path.display()))?;
    Ok(fallback)
}

fn dit_relative_parent(
    source_file: &DitSourceFile,
    directory_name_template: &str,
    flatten_subdirectories: bool,
) -> Result<PathBuf, String> {
    let Some(source_root_name) = source_file.source_root_name.as_deref() else {
        return Ok(PathBuf::new());
    };
    let mut relative_parent = PathBuf::from(render_dit_directory_name(
        source_root_name,
        directory_name_template,
        source_file.source_root_index,
    )?);
    if !flatten_subdirectories {
        if let Some(parent) = source_file.relative_path.parent() {
            relative_parent.push(parent);
        }
    }
    Ok(relative_parent)
}

fn dit_file_md5(path: &Path, cancelled: &AtomicBool) -> Result<[u8; 16], String> {
    let mut file = std::fs::File::open(path)
        .map_err(|error| format!("无法读取文件以计算 MD5 {}: {error}", path.display()))?;
    let mut hasher = Md5::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        if cancelled.load(Ordering::Relaxed) {
            return Err("任务已取消".into());
        }
        let count = file
            .read(&mut buffer)
            .map_err(|error| format!("计算 MD5 时读取失败 {}: {error}", path.display()))?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    let digest = hasher.finalize();
    let mut result = [0u8; 16];
    result.copy_from_slice(&digest);
    Ok(result)
}

enum DitTargetResolution {
    Copy(PathBuf),
    Reuse(PathBuf),
}

enum DitCandidateState {
    Available,
    Identical,
    Conflict,
}

fn apply_dit_reuse_policy(state: DitCandidateState, reuse_identical: bool) -> DitCandidateState {
    if !reuse_identical && matches!(state, DitCandidateState::Identical) {
        DitCandidateState::Conflict
    } else {
        state
    }
}

fn inspect_dit_candidate(
    source: &Path,
    candidate: &Path,
    claimed_targets: &std::collections::HashSet<String>,
    cancelled: &AtomicBool,
    source_digest: &mut Option<[u8; 16]>,
) -> Result<DitCandidateState, String> {
    if normalized_path_text(source) == normalized_path_text(candidate) {
        return Err(format!("备份目标不能覆盖源文件: {}", source.display()));
    }
    let key = normalized_path_text(candidate);
    if !candidate.exists() {
        return Ok(if claimed_targets.contains(&key) {
            DitCandidateState::Conflict
        } else {
            DitCandidateState::Available
        });
    }
    if !candidate.is_file() {
        return Ok(DitCandidateState::Conflict);
    }
    let expected = match source_digest {
        Some(value) => *value,
        None => {
            let value = dit_file_md5(source, cancelled)?;
            *source_digest = Some(value);
            value
        }
    };
    let existing = dit_file_md5(candidate, cancelled)?;
    Ok(if existing == expected {
        DitCandidateState::Identical
    } else {
        DitCandidateState::Conflict
    })
}

fn render_dit_conflict_filename(
    path: &Path,
    template: &str,
    number: usize,
) -> Result<String, String> {
    let active_template = if template.trim().is_empty() {
        "{name}_{index}"
    } else {
        template.trim()
    };
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("backup");
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    let uses_index = active_template.contains("{index}");
    let mut rendered = active_template
        .replace("{name}", stem)
        .replace("{index}", &number.to_string())
        .replace("{ext}", extension);
    rendered = sanitize_filename_component(&rendered);
    if rendered.is_empty() || Path::new(&rendered).components().count() != 1 {
        return Err("冲突重命名模板不能生成目录路径或空文件名".into());
    }
    if !uses_index {
        let mut value = PathBuf::from(&rendered);
        let rendered_stem = value
            .file_stem()
            .and_then(|part| part.to_str())
            .unwrap_or("backup");
        let rendered_extension = value
            .extension()
            .and_then(|part| part.to_str())
            .unwrap_or("");
        value.set_file_name(if rendered_extension.is_empty() {
            format!("{rendered_stem}_{number}")
        } else {
            format!("{rendered_stem}_{number}.{rendered_extension}")
        });
        rendered = value.to_string_lossy().to_string();
    }
    let mut value = PathBuf::from(rendered);
    value.set_extension(extension);
    rendered = value.to_string_lossy().to_string();
    Ok(rendered)
}

fn resolve_dit_target(
    source: &Path,
    backup_root: &Path,
    relative_parent: &Path,
    filename: &str,
    conflict_strategy: &str,
    conflict_rename_template: &str,
    conflict_subdirectory: Option<&str>,
    reuse_identical: bool,
    claimed_targets: &mut std::collections::HashSet<String>,
    cancelled: &AtomicBool,
    source_digest: &mut Option<[u8; 16]>,
) -> Result<DitTargetResolution, String> {
    let base_target = backup_root.join(relative_parent).join(filename);
    let finish = |target: PathBuf,
                  state: DitCandidateState,
                  claimed: &mut std::collections::HashSet<String>| {
        claimed.insert(normalized_path_text(&target));
        match state {
            DitCandidateState::Available => DitTargetResolution::Copy(target),
            DitCandidateState::Identical => DitTargetResolution::Reuse(target),
            DitCandidateState::Conflict => unreachable!(),
        }
    };
    let base_state = apply_dit_reuse_policy(
        inspect_dit_candidate(
            source,
            &base_target,
            claimed_targets,
            cancelled,
            source_digest,
        )?,
        reuse_identical,
    );
    if !matches!(base_state, DitCandidateState::Conflict) {
        return Ok(finish(base_target, base_state, claimed_targets));
    }

    let conflict_base = if conflict_strategy == "subdirectory" {
        backup_root
            .join(conflict_subdirectory.ok_or_else(|| "冲突子目录名称无效".to_string())?)
            .join(relative_parent)
            .join(filename)
    } else {
        base_target
    };
    if conflict_strategy == "subdirectory" {
        let state = apply_dit_reuse_policy(
            inspect_dit_candidate(
                source,
                &conflict_base,
                claimed_targets,
                cancelled,
                source_digest,
            )?,
            reuse_identical,
        );
        if !matches!(state, DitCandidateState::Conflict) {
            return Ok(finish(conflict_base, state, claimed_targets));
        }
    }
    for number in 2usize.. {
        let candidate = conflict_base.with_file_name(render_dit_conflict_filename(
            &conflict_base,
            conflict_rename_template,
            number,
        )?);
        let state = apply_dit_reuse_policy(
            inspect_dit_candidate(
                source,
                &candidate,
                claimed_targets,
                cancelled,
                source_digest,
            )?,
            reuse_identical,
        );
        if !matches!(state, DitCandidateState::Conflict) {
            return Ok(finish(candidate, state, claimed_targets));
        }
    }
    unreachable!()
}

fn copy_dit_file_core<F>(
    source: &Path,
    target: &Path,
    verify_md5: bool,
    cancelled: &AtomicBool,
    context: ProgressContext,
    mut on_progress: F,
) -> Result<(), String>
where
    F: FnMut(f32),
{
    if cancelled.load(Ordering::Relaxed) {
        return Err("任务已取消".into());
    }
    if target.exists() {
        return Err(format!(
            "目标在准备复制后被其他操作占用: {}",
            target.display()
        ));
    }
    let parent = target
        .parent()
        .ok_or_else(|| "目标路径缺少父目录".to_string())?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("无法创建目录 {}: {error}", parent.display()))?;
    let source_before = std::fs::metadata(source)
        .map_err(|error| format!("无法读取源文件属性 {}: {error}", source.display()))?;
    let temp_sequence = DIT_TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temp_name = format!(
        ".{}.shadowencoder-part-{}-{}-{}-{}",
        target
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("backup"),
        std::process::id(),
        context.file_index,
        context.phase_index,
        temp_sequence,
    );
    let temp = parent.join(temp_name);
    let result = (|| {
        let mut input = std::fs::File::open(source)
            .map_err(|error| format!("无法打开源文件 {}: {error}", source.display()))?;
        let mut output = std::fs::File::create(&temp)
            .map_err(|error| format!("无法创建临时文件 {}: {error}", temp.display()))?;
        let mut buffer = vec![0u8; 1024 * 1024];
        let mut copied = 0u64;
        let total = source_before.len();
        let mut source_hash = Md5::new();
        loop {
            if cancelled.load(Ordering::Relaxed) {
                return Err("任务已取消".into());
            }
            let count = input
                .read(&mut buffer)
                .map_err(|error| format!("读取源文件失败: {error}"))?;
            if count == 0 {
                break;
            }
            output
                .write_all(&buffer[..count])
                .map_err(|error| format!("写入备份失败: {error}"))?;
            if verify_md5 {
                source_hash.update(&buffer[..count]);
            }
            copied += count as u64;
            let percent = if total > 0 {
                copied as f32 / total as f32 * 100.0
            } else {
                0.0
            };
            on_progress(percent);
        }
        output
            .flush()
            .map_err(|error| format!("刷新备份文件失败: {error}"))?;
        let source_after = std::fs::metadata(source)
            .map_err(|error| format!("无法重新读取源文件属性: {error}"))?;
        if source_after.len() != source_before.len()
            || source_after.modified().ok() != source_before.modified().ok()
        {
            return Err("复制期间源文件发生变化，已放弃本次备份".into());
        }
        if verify_md5 {
            let expected = source_hash.finalize();
            let mut verifier = Md5::new();
            let mut verify_file = std::fs::File::open(&temp)
                .map_err(|error| format!("无法读取备份以执行 MD5 校验: {error}"))?;
            loop {
                if cancelled.load(Ordering::Relaxed) {
                    return Err("任务已取消".into());
                }
                let count = verify_file
                    .read(&mut buffer)
                    .map_err(|error| format!("校验备份读取失败: {error}"))?;
                if count == 0 {
                    break;
                }
                verifier.update(&buffer[..count]);
            }
            if verifier.finalize()[..] != expected[..] {
                return Err("MD5 校验失败，源文件与备份不一致".into());
            }
        }
        std::fs::rename(&temp, target)
            .map_err(|error| format!("无法提交备份文件 {}: {error}", target.display()))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

fn copy_dit_file(
    source: &Path,
    target: &Path,
    verify_md5: bool,
    cancelled: &AtomicBool,
    window: &tauri::Window,
    context: ProgressContext,
) -> Result<(), String> {
    copy_dit_file_core(source, target, verify_md5, cancelled, context, |percent| {
        emit_progress_value(
            window,
            "DIT 备份",
            source.to_str(),
            context,
            percent,
            0.0,
            0.0,
        );
    })
}

fn dit_backup_blocking(
    request: DitBackupRequest,
    window: tauri::Window,
    cancelled: Arc<AtomicBool>,
) -> Result<DitBackupSummary, String> {
    if request.source_paths.is_empty() {
        return Err("请先在素材列表中添加文件或目录".into());
    }
    if request.destinations.is_empty() {
        return Err("请至少添加一个备份目标目录".into());
    }
    if request.operation != "copy" && request.operation != "move" {
        return Err("DIT 备份操作只能是 copy 或 move".into());
    }
    if request.conflict_strategy != "rename" && request.conflict_strategy != "subdirectory" {
        return Err("冲突处理方式只能是 rename 或 subdirectory".into());
    }
    let conflict_subdirectory = if request.conflict_strategy == "subdirectory" {
        let value = sanitize_filename_component(&request.conflict_subdirectory);
        if value.is_empty() {
            return Err("冲突子目录名称无效".into());
        }
        Some(value)
    } else {
        None
    };
    let extensions = normalized_extensions(&request.extensions);
    let mut source_directories = Vec::new();
    let mut files = Vec::new();
    let mut skipped_files = 0usize;
    for (source_index, raw) in request.source_paths.iter().enumerate() {
        let raw = raw.trim();
        if raw.is_empty() {
            continue;
        }
        let raw_path = PathBuf::from(raw);
        let raw_metadata = std::fs::symlink_metadata(&raw_path)
            .map_err(|error| format!("无法访问素材 {raw}: {error}"))?;
        if raw_metadata.file_type().is_symlink() {
            skipped_files += 1;
            continue;
        }
        let source = std::fs::canonicalize(&raw_path)
            .map_err(|error| format!("无法解析素材路径 {raw}: {error}"))?;
        let metadata = std::fs::metadata(&source)
            .map_err(|error| format!("无法读取素材属性 {raw}: {error}"))?;
        if metadata.is_dir() {
            source_directories.push(source.clone());
            let (mut collected, skipped) = collect_dit_files(
                &source,
                request.recursive,
                &extensions,
                request.min_size_bytes,
                request.media_only,
            )?;
            let source_root_name = dit_source_root_name(&source)?;
            for file in &mut collected {
                file.source_root_name = Some(source_root_name.clone());
                file.source_root_index = source_index + 1;
            }
            files.append(&mut collected);
            skipped_files += skipped;
        } else if metadata.is_file() {
            if dit_file_matches(
                &source,
                &metadata,
                &extensions,
                request.min_size_bytes,
                request.media_only,
            ) {
                let relative_path = source
                    .file_name()
                    .map(PathBuf::from)
                    .ok_or_else(|| format!("无法解析素材文件名: {}", source.display()))?;
                files.push(DitSourceFile {
                    path: source,
                    relative_path,
                    source_root_name: None,
                    source_root_index: source_index + 1,
                });
            } else {
                skipped_files += 1;
            }
        } else {
            skipped_files += 1;
        }
    }
    if files.is_empty() && skipped_files == 0 {
        return Err("素材列表中没有可备份的文件".into());
    }
    let mut seen_sources = std::collections::HashSet::new();
    files.retain(|file| seen_sources.insert(normalized_path_text(&file.path)));
    files.sort_by(|a, b| normalized_path_text(&a.path).cmp(&normalized_path_text(&b.path)));

    let mut destinations = Vec::new();
    let mut destination_keys = std::collections::HashSet::new();
    for raw in &request.destinations {
        if raw.trim().is_empty() {
            continue;
        }
        let root = PathBuf::from(raw.trim());
        let candidate = canonicalize_destination_candidate(&root)?;
        if source_directories
            .iter()
            .any(|source| path_is_within(&candidate, source))
        {
            return Err(format!(
                "目标目录不能位于任一素材目录内部: {}",
                candidate.display()
            ));
        }
        std::fs::create_dir_all(&candidate)
            .map_err(|error| format!("无法创建目标目录 {}: {error}", candidate.display()))?;
        let canonical = std::fs::canonicalize(&candidate)
            .map_err(|error| format!("无法访问目标目录 {}: {error}", candidate.display()))?;
        if source_directories
            .iter()
            .any(|source| path_is_within(&canonical, source))
        {
            return Err(format!(
                "目标目录不能位于任一素材目录内部: {}",
                canonical.display()
            ));
        }
        let key = normalized_path_text(&canonical);
        if destination_keys.insert(key) {
            destinations.push(canonical);
        }
    }
    if destinations.is_empty() {
        return Err("没有可用的备份目标目录".into());
    }
    let total_files = files.len();
    emit_log(
        &window,
        &format!(
            "DIT 备份开始，共 {total_files} 个文件，{} 个目标",
            destinations.len()
        ),
    );
    let mut summary = DitBackupSummary {
        total_files,
        completed_files: 0,
        failed_files: 0,
        skipped_files,
        cancelled: false,
        results: Vec::with_capacity(total_files),
    };
    let mut claimed_targets = std::collections::HashSet::new();
    for (file_index, source_file) in files.iter().enumerate() {
        if cancelled.load(Ordering::Relaxed) {
            summary.cancelled = true;
            break;
        }
        let file = &source_file.path;
        let source_text = file.to_string_lossy().to_string();
        emit_file_log(
            &window,
            "file_start",
            file_index + 1,
            total_files,
            &source_text,
            "normal",
            "等待备份",
        );
        let relative_parent = dit_relative_parent(
            source_file,
            &request.directory_name_template,
            request.flatten_subdirectories,
        )?;
        let filename = render_dit_filename(file, &request.rename_template, file_index + 1)?;
        let mut output_paths = Vec::new();
        let mut error = None;
        let mut source_digest = None;
        for (destination_index, destination) in destinations.iter().enumerate() {
            let resolution = match resolve_dit_target(
                file,
                destination,
                &relative_parent,
                &filename,
                &request.conflict_strategy,
                &request.conflict_rename_template,
                conflict_subdirectory.as_deref(),
                request.reuse_identical,
                &mut claimed_targets,
                &cancelled,
                &mut source_digest,
            ) {
                Ok(value) => value,
                Err(message) => {
                    error = Some(message);
                    break;
                }
            };
            let (target, reuse_existing) = match resolution {
                DitTargetResolution::Copy(path) => (path, false),
                DitTargetResolution::Reuse(path) => (path, true),
            };
            emit_log(
                &window,
                &format!(
                    "目标 {}/{}: {}{}",
                    destination_index + 1,
                    destinations.len(),
                    target.display(),
                    if reuse_existing {
                        "（MD5 一致，复用已有文件）"
                    } else {
                        ""
                    }
                ),
            );
            let result = if reuse_existing {
                Ok(())
            } else {
                copy_dit_file(
                    file,
                    &target,
                    request.verify_md5,
                    &cancelled,
                    &window,
                    ProgressContext {
                        file_index,
                        file_count: total_files.max(1),
                        phase_index: destination_index,
                        phase_count: destinations.len(),
                    },
                )
            };
            match result {
                Ok(()) => output_paths.push(target.to_string_lossy().to_string()),
                Err(message) => {
                    error = Some(message);
                    break;
                }
            }
        }
        if cancelled.load(Ordering::Relaxed) {
            summary.cancelled = true;
        }
        if error.is_none() && !summary.cancelled && request.operation == "move" {
            if let Err(remove_error) = std::fs::remove_file(file) {
                error = Some(format!("备份已完成，但无法删除源文件: {remove_error}"));
            }
        }
        let success = error.is_none() && !summary.cancelled;
        if success {
            summary.completed_files += 1;
            emit_file_log(
                &window,
                "file_end",
                file_index + 1,
                total_files,
                &source_text,
                "pass",
                if request.verify_md5 {
                    "备份及 MD5 校验完成"
                } else {
                    "备份完成"
                },
            );
        } else {
            summary.failed_files += 1;
            let message = error.clone().unwrap_or_else(|| "任务已取消".to_string());
            emit_log(&window, &format!("[FAIL] {message}"));
            emit_file_log(
                &window,
                "file_end",
                file_index + 1,
                total_files,
                &source_text,
                if summary.cancelled { "warn" } else { "fail" },
                if summary.cancelled {
                    "备份已取消"
                } else {
                    "备份失败"
                },
            );
        }
        summary.results.push(DitBackupFileResult {
            source_path: source_text,
            output_paths,
            success,
            error,
        });
        if summary.cancelled {
            break;
        }
    }
    if summary.cancelled {
        emit_log(&window, "[CANCEL] DIT 备份已取消");
    } else {
        emit_log(
            &window,
            &format!(
                "[PASS] DIT 备份结束：完成 {}，失败 {}，过滤/跳过 {}",
                summary.completed_files, summary.failed_files, summary.skipped_files
            ),
        );
    }
    Ok(summary)
}

#[tauri::command]
async fn dit_backup(
    request: DitBackupRequest,
    window: tauri::Window,
) -> Result<DitBackupSummary, String> {
    let key = window.label().to_string();
    let cancelled = Arc::new(AtomicBool::new(false));
    {
        let mut flags = dit_cancel_flags()
            .lock()
            .map_err(|error| error.to_string())?;
        if flags.contains_key(&key) {
            return Err("已有 DIT 备份任务正在运行".into());
        }
        flags.insert(key.clone(), cancelled.clone());
    }
    let result = run_blocking(move || dit_backup_blocking(request, window, cancelled)).await;
    dit_cancel_flags()
        .lock()
        .map_err(|error| error.to_string())?
        .remove(&key);
    result
}

/* ════════════ 元数据 / 选择 / 预览 / 更新 ════════════ */

fn get_info_map(path: &str) -> std::collections::HashMap<String, Value> {
    let mut m = std::collections::HashMap::new();
    let out = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height",
            "-of",
            "json",
            path,
        ])
        .output();
    if let Ok(o) = out {
        if let Ok(v) = serde_json::from_slice::<Value>(&o.stdout) {
            if let Some(s) = v["streams"].as_array().and_then(|a| a.first()) {
                if let Some(w) = s["width"].as_i64() {
                    m.insert("width".into(), w.into());
                }
                if let Some(h) = s["height"].as_i64() {
                    m.insert("height".into(), h.into());
                }
            }
        }
    }
    m
}

fn get_video_info_blocking(path: String) -> Result<Value, String> {
    let output = Command::new("ffprobe")
        .args([
            "-v",
            "quiet",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            &path,
        ])
        .output()
        .map_err(|e| e.to_string())?;
    serde_json::from_slice(&output.stdout).map_err(|e| e.to_string())
}

/// 前端文件/文件夹选择：rfd 现代系统对话框（与 OpenFileDialog 同风格，支持多选）
/// 多文件时以换行拼接返回；目录返回单路径。
fn pick_path_blocking(kind: String) -> Result<Option<String>, String> {
    if kind == "dir" {
        let folder = rfd::FileDialog::new().set_title("选择文件夹").pick_folder();
        Ok(folder.map(|p| {
            let mut s = p.to_string_lossy().to_string();
            if !s.ends_with('\\') && !s.ends_with('/') {
                s.push('\\');
            }
            s
        }))
    } else {
        let files = rfd::FileDialog::new()
            .set_title("选择文件")
            .add_filter(
                "媒体文件",
                &[
                    "mp4", "mov", "mkv", "avi", "webm", "m4v", "flv", "wmv", "ts", "m2ts", "png",
                    "jpg", "jpeg", "gif", "webp", "bmp",
                ],
            )
            .add_filter("所有文件", &["*"])
            .pick_files();
        Ok(files.map(|list| {
            list.iter()
                .map(|p| p.to_string_lossy().to_string())
                .collect::<Vec<_>>()
                .join("\n")
        }))
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaBrowserEntry {
    name: String,
    path: String,
    is_directory: bool,
    size_bytes: Option<u64>,
    modified_time_ms: Option<u64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaBrowserRoot {
    path: String,
    label: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaBrowserListing {
    current_path: String,
    parent_path: Option<String>,
    roots: Vec<MediaBrowserRoot>,
    entries: Vec<MediaBrowserEntry>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaTreeEntry {
    name: String,
    path: String,
    parent_path: String,
    is_directory: bool,
    depth: usize,
    size_bytes: Option<u64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaTreeListing {
    root_path: String,
    root_is_directory: bool,
    root_size_bytes: Option<u64>,
    entries: Vec<MediaTreeEntry>,
    errors: Vec<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StorageVolume {
    id: String,
    root_path: String,
    label: String,
    serial: Option<u32>,
    drive_type: String,
    total_bytes: Option<u64>,
    available_bytes: Option<u64>,
}

#[cfg(target_os = "windows")]
fn wide_path(path: &str) -> Vec<u16> {
    use std::ffi::OsStr;
    use std::iter::once;
    use std::os::windows::ffi::OsStrExt;

    OsStr::new(path).encode_wide().chain(once(0)).collect()
}

#[cfg(target_os = "windows")]
fn storage_volume_for_root(root: &str) -> StorageVolume {
    use windows_sys::Win32::Storage::FileSystem::{
        GetDiskFreeSpaceExW, GetDriveTypeW, GetVolumeInformationW,
    };
    use windows_sys::Win32::System::WindowsProgramming::{
        DRIVE_CDROM, DRIVE_FIXED, DRIVE_NO_ROOT_DIR, DRIVE_RAMDISK, DRIVE_REMOTE, DRIVE_REMOVABLE,
    };

    let root_wide = wide_path(root);
    let mut volume_name = vec![0u16; 261];
    let mut serial = 0u32;
    let volume_found = unsafe {
        GetVolumeInformationW(
            root_wide.as_ptr(),
            volume_name.as_mut_ptr(),
            volume_name.len() as u32,
            &mut serial,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            0,
        ) != 0
    };
    let label = if volume_found {
        let length = volume_name
            .iter()
            .position(|character| *character == 0)
            .unwrap_or(volume_name.len());
        String::from_utf16_lossy(&volume_name[..length])
            .trim()
            .to_string()
    } else {
        String::new()
    };
    let drive_type = match unsafe { GetDriveTypeW(root_wide.as_ptr()) } {
        DRIVE_REMOVABLE => "removable",
        DRIVE_FIXED => "fixed",
        DRIVE_REMOTE => "network",
        DRIVE_CDROM => "optical",
        DRIVE_RAMDISK => "ramdisk",
        DRIVE_NO_ROOT_DIR => "unavailable",
        _ => "unknown",
    }
    .to_string();
    let mut available = 0u64;
    let mut total = 0u64;
    let capacity_found = unsafe {
        GetDiskFreeSpaceExW(
            root_wide.as_ptr(),
            &mut available,
            &mut total,
            std::ptr::null_mut(),
        ) != 0
    };
    let serial = volume_found.then_some(serial);
    StorageVolume {
        id: serial
            .map(|value| format!("{value:08X}"))
            .unwrap_or_else(|| root.to_lowercase()),
        root_path: root.to_string(),
        label,
        serial,
        drive_type,
        total_bytes: capacity_found.then_some(total),
        available_bytes: capacity_found.then_some(available),
    }
}

#[cfg(target_os = "windows")]
fn storage_volume_for_path(path: String) -> Result<StorageVolume, String> {
    use windows_sys::Win32::Storage::FileSystem::GetVolumePathNameW;

    let requested = PathBuf::from(path.trim());
    if requested.as_os_str().is_empty() {
        return Err("存储路径不能为空".to_string());
    }
    let mut existing = requested.as_path();
    while !existing.exists() {
        existing = existing
            .parent()
            .ok_or_else(|| format!("无法找到存储路径的可访问父目录: {}", requested.display()))?;
    }
    let existing_text = existing.to_string_lossy().to_string();
    let existing_wide = wide_path(&existing_text);
    let mut root = vec![0u16; 32768];
    let found = unsafe {
        GetVolumePathNameW(existing_wide.as_ptr(), root.as_mut_ptr(), root.len() as u32) != 0
    };
    if !found {
        return Err(format!("无法读取路径所在卷: {}", requested.display()));
    }
    let length = root
        .iter()
        .position(|character| *character == 0)
        .unwrap_or(root.len());
    Ok(storage_volume_for_root(&String::from_utf16_lossy(
        &root[..length],
    )))
}

#[cfg(target_os = "windows")]
fn storage_volumes() -> Vec<StorageVolume> {
    (b'A'..=b'Z')
        .map(|letter| format!("{}:\\", letter as char))
        .filter(|path| Path::new(path).exists())
        .map(|path| storage_volume_for_root(&path))
        .collect()
}

#[cfg(not(target_os = "windows"))]
fn storage_volume_for_path(_path: String) -> Result<StorageVolume, String> {
    Ok(StorageVolume {
        id: "/".to_string(),
        root_path: "/".to_string(),
        label: "/".to_string(),
        serial: None,
        drive_type: "fixed".to_string(),
        total_bytes: None,
        available_bytes: None,
    })
}

#[cfg(not(target_os = "windows"))]
fn storage_volumes() -> Vec<StorageVolume> {
    vec![storage_volume_for_path("/".to_string()).expect("root volume")]
}

#[cfg(target_os = "windows")]
fn media_browser_root_label(path: &str) -> String {
    use std::ffi::OsStr;
    use std::iter::once;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetVolumeInformationW;

    let root_path = OsStr::new(path)
        .encode_wide()
        .chain(once(0))
        .collect::<Vec<_>>();
    let mut volume_name = vec![0u16; 261];
    let found = unsafe {
        GetVolumeInformationW(
            root_path.as_ptr(),
            volume_name.as_mut_ptr(),
            volume_name.len() as u32,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            0,
        ) != 0
    };
    let drive = path.trim_end_matches(&['\\', '/'][..]);
    let name = if found {
        let length = volume_name
            .iter()
            .position(|character| *character == 0)
            .unwrap_or(volume_name.len());
        String::from_utf16_lossy(&volume_name[..length])
            .trim()
            .to_string()
    } else {
        String::new()
    };

    if name.is_empty() {
        format!("本地磁盘 ({drive})")
    } else {
        format!("{name} ({drive})")
    }
}

fn media_browser_roots() -> Vec<MediaBrowserRoot> {
    #[cfg(target_os = "windows")]
    {
        (b'A'..=b'Z')
            .map(|letter| format!("{}:\\", letter as char))
            .filter(|path| Path::new(path).exists())
            .map(|path| MediaBrowserRoot {
                label: media_browser_root_label(&path),
                path,
            })
            .collect()
    }
    #[cfg(not(target_os = "windows"))]
    {
        vec![MediaBrowserRoot {
            path: "/".to_string(),
            label: "/".to_string(),
        }]
    }
}

fn default_media_browser_path() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| PathBuf::from("."))
}

fn list_media_directory_blocking(path: Option<String>) -> Result<MediaBrowserListing, String> {
    let requested = path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(default_media_browser_path);
    let mut directory = if requested.is_file() {
        requested
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| "所选文件没有可浏览的父目录".to_string())?
    } else {
        requested
    };
    if !directory.is_absolute() {
        directory = std::env::current_dir()
            .map_err(|error| format!("无法读取当前目录: {error}"))?
            .join(directory);
    }
    if !directory.is_dir() {
        return Err(format!("目录不存在或无法访问: {}", directory.display()));
    }

    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&directory)
        .map_err(|error| format!("无法读取目录 {}: {error}", directory.display()))?
    {
        let Ok(entry) = entry else {
            continue;
        };
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let is_directory = file_type.is_dir();
        let metadata = entry.metadata().ok();
        let size_bytes = if is_directory {
            None
        } else {
            metadata.as_ref().map(|metadata| metadata.len())
        };
        let modified_time_ms = metadata
            .as_ref()
            .and_then(|metadata| metadata.modified().ok())
            .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
            .and_then(|duration| u64::try_from(duration.as_millis()).ok());
        entries.push(MediaBrowserEntry {
            name: entry.file_name().to_string_lossy().to_string(),
            path: entry.path().to_string_lossy().to_string(),
            is_directory,
            size_bytes,
            modified_time_ms,
        });
    }
    entries.sort_by(|left, right| {
        right
            .is_directory
            .cmp(&left.is_directory)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });

    Ok(MediaBrowserListing {
        current_path: directory.to_string_lossy().to_string(),
        parent_path: directory
            .parent()
            .map(|parent| parent.to_string_lossy().to_string()),
        roots: media_browser_roots(),
        entries,
    })
}

#[cfg(target_os = "windows")]
fn media_tree_is_link(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;

    metadata.file_type().is_symlink()
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(target_os = "windows"))]
fn media_tree_is_link(metadata: &std::fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

const MAX_MEDIA_TREE_ENTRIES: usize = 100_000;

fn collect_media_tree_entries(
    directory: &Path,
    depth: usize,
    entries: &mut Vec<MediaTreeEntry>,
    errors: &mut Vec<String>,
) -> Result<(), String> {
    let directory_entries = match std::fs::read_dir(directory) {
        Ok(value) => value,
        Err(error) => {
            errors.push(format!("无法读取目录 {}: {error}", directory.display()));
            return Ok(());
        }
    };

    let mut children = Vec::new();
    for entry in directory_entries {
        let entry = match entry {
            Ok(value) => value,
            Err(error) => {
                errors.push(format!(
                    "无法读取 {} 中的项目: {error}",
                    directory.display()
                ));
                continue;
            }
        };
        let path = entry.path();
        let metadata = match std::fs::symlink_metadata(&path) {
            Ok(value) => value,
            Err(error) => {
                errors.push(format!("无法读取素材属性 {}: {error}", path.display()));
                continue;
            }
        };
        if media_tree_is_link(&metadata) {
            continue;
        }
        children.push((
            entry.file_name().to_string_lossy().to_string(),
            path,
            metadata.is_dir(),
            metadata.is_file().then_some(metadata.len()),
        ));
    }

    children.sort_by(|left, right| {
        right
            .2
            .cmp(&left.2)
            .then_with(|| left.0.to_lowercase().cmp(&right.0.to_lowercase()))
            .then_with(|| left.0.cmp(&right.0))
            .then_with(|| left.1.cmp(&right.1))
    });

    let parent_path = directory.to_string_lossy().to_string();
    for (name, path, is_directory, size_bytes) in children {
        if entries.len() >= MAX_MEDIA_TREE_ENTRIES {
            return Err(format!(
                "目录中的项目超过 {MAX_MEDIA_TREE_ENTRIES} 个，请缩小素材范围"
            ));
        }
        entries.push(MediaTreeEntry {
            name,
            path: path.to_string_lossy().to_string(),
            parent_path: parent_path.clone(),
            is_directory,
            depth,
            size_bytes,
        });
        if is_directory {
            collect_media_tree_entries(&path, depth + 1, entries, errors)?;
        }
    }
    Ok(())
}

fn list_media_tree_blocking(path: String) -> Result<MediaTreeListing, String> {
    let requested = PathBuf::from(path.trim());
    if requested.as_os_str().is_empty() {
        return Err("目录路径不能为空".to_string());
    }
    let root = if requested.is_absolute() {
        requested
    } else {
        std::env::current_dir()
            .map_err(|error| format!("无法读取当前目录: {error}"))?
            .join(requested)
    };
    let metadata = std::fs::symlink_metadata(&root)
        .map_err(|error| format!("无法访问素材 {}: {error}", root.display()))?;
    if media_tree_is_link(&metadata) {
        return Err(format!(
            "为避免循环读取，不展开链接目录: {}",
            root.display()
        ));
    }

    let root_is_directory = metadata.is_dir();
    let mut entries = Vec::new();
    let mut errors = Vec::new();
    if root_is_directory {
        collect_media_tree_entries(&root, 1, &mut entries, &mut errors)?;
    }
    Ok(MediaTreeListing {
        root_path: root.to_string_lossy().to_string(),
        root_is_directory,
        root_size_bytes: metadata.is_file().then_some(metadata.len()),
        entries,
        errors,
    })
}

/// 读取媒体文件原始字节，供前端用 Blob URL 在 <video> 中预览（Tauri 无资产协议时的最佳方案）
fn read_media_file_blocking(path: String) -> Result<Vec<u8>, String> {
    let meta = std::fs::metadata(&path).map_err(|e| format!("无法访问文件: {}", e))?;
    const MAX: u64 = 1_500_000_000; // 1.5GB 预览上限，避免内存爆炸
    if meta.len() > MAX {
        return Err(format!(
            "文件过大（{:.1}GB），预览仅支持小于 1.5GB 的文件",
            meta.len() as f64 / 1e9
        ));
    }
    std::fs::read(&path).map_err(|e| format!("读取失败: {}", e))
}

fn preview_frame_blocking(path: String, time_sec: f32, max_width: i32) -> Result<Vec<u8>, String> {
    let width = max_width.clamp(160, 1280);
    let output = Command::new("ffmpeg")
        .args([
            "-v",
            "error",
            "-ss",
            &time_sec.max(0.0).to_string(),
            "-i",
            &path,
            "-map",
            "0:v:0",
            "-frames:v",
            "1",
            "-threads",
            "1",
            "-vf",
            &format!("scale={width}:-2:force_original_aspect_ratio=decrease"),
            "-q:v",
            "7",
            "-f",
            "image2pipe",
            "-vcodec",
            "mjpeg",
            "pipe:1",
        ])
        .output()
        .map_err(|error| format!("无法启动预览帧提取: {error}"))?;
    if !output.status.success() {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if message.is_empty() {
            "无法提取预览帧".into()
        } else {
            message
        });
    }
    if output.stdout.is_empty() {
        return Err("预览帧为空".into());
    }
    Ok(output.stdout)
}

#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    if !std::fs::metadata(&path)
        .map_err(|error| format!("无法访问文件: {error}"))?
        .is_file()
    {
        return Err("只能使用系统默认应用打开文件".into());
    }
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("explorer");
        command.arg(&path);
        command
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg(&path);
        command
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(&path);
        command
    };
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("无法使用系统默认应用打开文件: {error}"))
}

#[tauri::command]
fn open_output_directory(path: String) -> Result<(), String> {
    let input = PathBuf::from(&path);
    let metadata =
        std::fs::metadata(&input).map_err(|error| format!("无法访问输出位置: {error}"))?;
    let directory = if metadata.is_dir() {
        input
    } else {
        input
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| "无法确定输出目录".to_string())?
    };
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("explorer");
        command.arg(&directory);
        command
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg(&directory);
        command
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(&directory);
        command
    };
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("无法打开输出目录: {error}"))
}

#[tauri::command]
async fn compose_alpha(
    input: String,
    fps: Option<f32>,
    output_options: Option<OutputOptions>,
    window: tauri::Window,
) -> Result<String, String> {
    run_blocking(move || compose_alpha_blocking(input, fps, output_options, window)).await
}

#[tauri::command]
async fn screenshot(
    input: String,
    time_sec: f32,
    width: i32,
    height: i32,
    crop: Option<(i32, i32, i32, i32)>,
    output_options: Option<OutputOptions>,
    window: tauri::Window,
) -> Result<String, String> {
    run_blocking(move || {
        screenshot_blocking(input, time_sec, width, height, crop, output_options, window)
    })
    .await
}

#[tauri::command]
async fn export_gif(
    input: String,
    start: f32,
    duration: f32,
    fps: f32,
    width: i32,
    height: i32,
    compression: Option<String>,
    crop: Option<(i32, i32, i32, i32)>,
    output_options: Option<OutputOptions>,
    window: tauri::Window,
) -> Result<String, String> {
    let compression = GifCompression::parse(compression.as_deref())?;
    run_blocking(move || {
        export_gif_blocking(
            input,
            start,
            duration,
            fps,
            width,
            height,
            compression,
            crop,
            output_options,
            window,
        )
    })
    .await
}

#[tauri::command]
async fn export_webp(
    input: String,
    start: f32,
    duration: f32,
    fps: f32,
    width: i32,
    height: i32,
    quality: i32,
    crop: Option<(i32, i32, i32, i32)>,
    output_options: Option<OutputOptions>,
    window: tauri::Window,
) -> Result<String, String> {
    run_blocking(move || {
        export_webp_blocking(
            input,
            start,
            duration,
            fps,
            width,
            height,
            quality,
            crop,
            output_options,
            window,
        )
    })
    .await
}

#[tauri::command]
async fn export_segment(
    input: String,
    start: f32,
    duration: f32,
    fps: f32,
    width: i32,
    height: i32,
    out_format: String,
    crop: Option<(i32, i32, i32, i32)>,
    video_codec: String,
    video_profile: String,
    pixel_format: String,
    crf: i32,
    video_bitrate: i32,
    audio_codec: String,
    audio_bitrate: i32,
    output_options: Option<OutputOptions>,
    window: tauri::Window,
) -> Result<String, String> {
    run_blocking(move || {
        export_segment_blocking(
            input,
            start,
            duration,
            fps,
            width,
            height,
            out_format,
            crop,
            video_codec,
            video_profile,
            pixel_format,
            crf,
            video_bitrate,
            audio_codec,
            audio_bitrate,
            output_options,
            window,
        )
    })
    .await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn transcode(
    paths: Vec<String>,
    video_codec: String,
    video_profile: String,
    crf: i32,
    speed_preset: String,
    tune: String,
    style: i32,
    pixel_format: String,
    container: String,
    scale_w: i32,
    scale_h: i32,
    fps: f32,
    video_bitrate: i32,
    audio_codec: String,
    audio_profile: String,
    audio_bitrate: i32,
    audio_sample_rate: i32,
    audio_channels: i32,
    unsharp: i32,
    denoise: i32,
    loudnorm: bool,
    audio_only: bool,
    keep_res: bool,
    rate_mode: String,
    target_file_size_mb: f64,
    two_pass: bool,
    output_options: Option<OutputOptions>,
    window: tauri::Window,
) -> Result<Vec<String>, String> {
    run_blocking(move || {
        transcode_blocking(
            paths,
            video_codec,
            video_profile,
            crf,
            speed_preset,
            tune,
            style,
            pixel_format,
            container,
            scale_w,
            scale_h,
            fps,
            video_bitrate,
            audio_codec,
            audio_profile,
            audio_bitrate,
            audio_sample_rate,
            audio_channels,
            unsharp,
            denoise,
            loudnorm,
            audio_only,
            keep_res,
            rate_mode,
            target_file_size_mb,
            two_pass,
            output_options,
            window,
        )
    })
    .await
}

#[tauri::command]
async fn mix(
    paths: Vec<String>,
    loudnorm_i: f32,
    loudnorm_tp: f32,
    loudnorm_lra: f32,
    compand_threshold: f32,
    compand_gain: f32,
    loudnorm_on: bool,
    compand_on: bool,
    output_options: Option<OutputOptions>,
    window: tauri::Window,
) -> Result<Vec<String>, String> {
    run_blocking(move || {
        mix_blocking(
            paths,
            loudnorm_i,
            loudnorm_tp,
            loudnorm_lra,
            compand_threshold,
            compand_gain,
            loudnorm_on,
            compand_on,
            output_options,
            window,
        )
    })
    .await
}

#[tauri::command]
async fn check(
    paths: Vec<String>,
    fps_tolerance: f32,
    recursive: bool,
    black_detect: bool,
    expected_width: i32,
    expected_height: i32,
    expected_fps: f32,
    expected_codec: String,
    window: tauri::Window,
) -> Result<CheckSummary, String> {
    run_blocking(move || {
        check_blocking(
            paths,
            fps_tolerance,
            recursive,
            black_detect,
            expected_width,
            expected_height,
            expected_fps,
            expected_codec,
            window,
        )
    })
    .await
}

#[tauri::command]
async fn get_video_info(path: String) -> Result<Value, String> {
    run_blocking(move || get_video_info_blocking(path)).await
}

#[tauri::command]
async fn pick_path(kind: String) -> Result<Option<String>, String> {
    run_blocking(move || pick_path_blocking(kind)).await
}

#[tauri::command]
async fn list_media_directory(path: Option<String>) -> Result<MediaBrowserListing, String> {
    run_blocking(move || list_media_directory_blocking(path)).await
}

#[tauri::command]
async fn list_media_tree(path: String) -> Result<MediaTreeListing, String> {
    run_blocking(move || list_media_tree_blocking(path)).await
}

#[tauri::command]
async fn list_storage_volumes() -> Result<Vec<StorageVolume>, String> {
    run_blocking(|| Ok(storage_volumes())).await
}

#[tauri::command]
async fn get_storage_volume(path: String) -> Result<StorageVolume, String> {
    run_blocking(move || storage_volume_for_path(path)).await
}

#[tauri::command]
async fn read_media_file(path: String) -> Result<Vec<u8>, String> {
    run_blocking(move || read_media_file_blocking(path)).await
}

#[tauri::command]
async fn preview_frame(path: String, time_sec: f32, max_width: i32) -> Result<Vec<u8>, String> {
    run_blocking(move || preview_frame_blocking(path, time_sec, max_width)).await
}

#[tauri::command]
fn update_check() -> Result<Value, String> {
    // 占位：返回当前版本，真实检查逻辑（CDN 拉取 manifest + SHA256 校验）为后续精修项
    Ok(serde_json::json!({
        "current_version": env!("CARGO_PKG_VERSION"),
        "update_available": false,
        "notes": "更新检查待接入 CDN",
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dit_test_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "shadowencoder-dit-{label}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ))
    }

    fn dit_temp_files(path: &Path) -> Vec<PathBuf> {
        if !path.exists() {
            return Vec::new();
        }
        std::fs::read_dir(path)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|entry| {
                entry
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.contains(".shadowencoder-part-"))
            })
            .collect()
    }

    #[test]
    fn dit_copy_core_copies_and_verifies_real_file() {
        let root = dit_test_root("copy-core");
        let source = root.join("source.mov");
        let target = root.join("backup").join("source.mov");
        std::fs::create_dir_all(&root).unwrap();
        let content = vec![0x5au8; 2 * 1024 * 1024 + 37];
        std::fs::write(&source, &content).unwrap();
        let cancelled = AtomicBool::new(false);
        let mut progress = Vec::new();

        copy_dit_file_core(
            &source,
            &target,
            true,
            &cancelled,
            ProgressContext::single(),
            |percent| progress.push(percent),
        )
        .unwrap();

        assert_eq!(std::fs::read(&target).unwrap(), content);
        assert!(!progress.is_empty());
        assert!(progress.windows(2).all(|values| values[0] <= values[1]));
        assert!((progress.last().copied().unwrap_or_default() - 100.0).abs() < f32::EPSILON);
        assert!(dit_temp_files(target.parent().unwrap()).is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn dit_copy_core_cancellation_removes_partial_file() {
        let root = dit_test_root("copy-cancel");
        let source = root.join("source.mov");
        let target = root.join("backup").join("source.mov");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(&source, vec![0x3cu8; 3 * 1024 * 1024]).unwrap();
        let cancelled = AtomicBool::new(false);

        let error = copy_dit_file_core(
            &source,
            &target,
            true,
            &cancelled,
            ProgressContext::single(),
            |_| cancelled.store(true, Ordering::Relaxed),
        )
        .unwrap_err();

        assert_eq!(error, "任务已取消");
        assert!(!target.exists());
        assert!(dit_temp_files(target.parent().unwrap()).is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn dit_copy_core_refuses_to_overwrite_existing_target() {
        let root = dit_test_root("copy-existing");
        let source = root.join("source.mov");
        let target = root.join("backup").join("source.mov");
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(&source, b"new-content").unwrap();
        std::fs::write(&target, b"existing-content").unwrap();
        let cancelled = AtomicBool::new(false);

        let error = copy_dit_file_core(
            &source,
            &target,
            false,
            &cancelled,
            ProgressContext::single(),
            |_| {},
        )
        .unwrap_err();

        assert!(error.starts_with("目标在准备复制后被其他操作占用:"));
        assert_eq!(std::fs::read(&target).unwrap(), b"existing-content");
        assert!(dit_temp_files(target.parent().unwrap()).is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn dit_filters_media_extensions_and_minimum_size() {
        let root = dit_test_root("filters");
        std::fs::create_dir_all(&root).unwrap();
        let movie = root.join("CLIP.MOV");
        let note = root.join("notes.txt");
        std::fs::write(&movie, b"media").unwrap();
        std::fs::write(&note, b"notes").unwrap();
        let movie_metadata = std::fs::metadata(&movie).unwrap();
        let note_metadata = std::fs::metadata(&note).unwrap();
        let no_extensions = std::collections::HashSet::new();
        let mov_only = normalized_extensions(&[".MOV".to_string()]);

        assert!(dit_file_matches(
            &movie,
            &movie_metadata,
            &no_extensions,
            None,
            true
        ));
        assert!(!dit_file_matches(
            &note,
            &note_metadata,
            &no_extensions,
            None,
            true
        ));
        assert!(dit_file_matches(
            &movie,
            &movie_metadata,
            &mov_only,
            None,
            false
        ));
        assert!(!dit_file_matches(
            &note,
            &note_metadata,
            &mov_only,
            None,
            false
        ));
        assert!(!dit_file_matches(
            &movie,
            &movie_metadata,
            &no_extensions,
            Some(6),
            false
        ));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn dit_filename_template_preserves_source_extension() {
        let source = Path::new("clip.mov");
        assert_eq!(
            render_dit_filename(source, "{name}_{index}", 7).unwrap(),
            "clip_0007.mov"
        );
        assert_eq!(
            render_dit_filename(source, "A001_{name}.{ext}", 1).unwrap(),
            "A001_clip.mov"
        );
        assert_eq!(
            render_dit_filename(source, "{name}.mp4", 1).unwrap(),
            "clip.mov"
        );
        assert_eq!(render_dit_filename(source, "", 1).unwrap(), "clip.mov");
    }

    #[test]
    fn dit_directory_root_is_preserved_and_nested_structure_can_flatten() {
        let source = DitSourceFile {
            path: PathBuf::from("CARD_A/DCIM/100MEDIA/clip.mov"),
            relative_path: PathBuf::from("DCIM/100MEDIA/clip.mov"),
            source_root_name: Some("CARD_A".to_string()),
            source_root_index: 3,
        };

        assert_eq!(
            dit_relative_parent(&source, "", false).unwrap(),
            PathBuf::from("CARD_A/DCIM/100MEDIA")
        );
        assert_eq!(
            dit_relative_parent(&source, "", true).unwrap(),
            PathBuf::from("CARD_A")
        );
        assert_eq!(
            dit_relative_parent(&source, "ROLL_{name}_{index}", false).unwrap(),
            PathBuf::from("ROLL_CARD_A_0003/DCIM/100MEDIA")
        );
    }

    #[test]
    fn dit_conflict_template_has_configurable_and_automatic_indices() {
        let source = Path::new("clip.mov");
        assert_eq!(
            render_dit_conflict_filename(source, "{name}_duplicate_{index}.{ext}", 2).unwrap(),
            "clip_duplicate_2.mov"
        );
        assert_eq!(
            render_dit_conflict_filename(source, "{name}.{ext}", 3).unwrap(),
            "clip_3.mov"
        );
        assert_eq!(
            render_dit_conflict_filename(source, "{name}_{index}.mp4", 3).unwrap(),
            "clip_3.mov"
        );
        assert_eq!(
            render_dit_conflict_filename(source, "", 4).unwrap(),
            "clip_4.mov"
        );
    }

    #[test]
    fn dit_conflicts_reuse_identical_files_and_route_different_files() {
        let root = dit_test_root("conflicts");
        let destination = root.join("backup");
        std::fs::create_dir_all(&destination).unwrap();
        let source = root.join("clip.mov");
        std::fs::write(&source, b"source-content").unwrap();
        let base = destination.join("clip.mov");
        std::fs::write(&base, b"different-content").unwrap();
        let cancelled = AtomicBool::new(false);

        let mut claimed = std::collections::HashSet::new();
        let mut source_digest = None;
        match resolve_dit_target(
            &source,
            &destination,
            Path::new(""),
            "clip.mov",
            "rename",
            "{name}_{index}.{ext}",
            None,
            true,
            &mut claimed,
            &cancelled,
            &mut source_digest,
        )
        .unwrap()
        {
            DitTargetResolution::Copy(path) => assert_eq!(path, destination.join("clip_2.mov")),
            DitTargetResolution::Reuse(_) => panic!("不同内容不应复用已有文件"),
        }

        let identical_destination = root.join("identical");
        std::fs::create_dir_all(&identical_destination).unwrap();
        let identical = identical_destination.join("clip.mov");
        std::fs::write(&identical, b"source-content").unwrap();
        let mut claimed = std::collections::HashSet::new();
        let mut source_digest = None;
        match resolve_dit_target(
            &source,
            &identical_destination,
            Path::new(""),
            "clip.mov",
            "rename",
            "{name}_{index}.{ext}",
            None,
            true,
            &mut claimed,
            &cancelled,
            &mut source_digest,
        )
        .unwrap()
        {
            DitTargetResolution::Reuse(path) => assert_eq!(path, identical),
            DitTargetResolution::Copy(_) => panic!("相同内容应复用已有文件"),
        }

        let conflict_destination = root.join("subdirectory");
        let conflict_folder = conflict_destination.join("Conflicts");
        std::fs::create_dir_all(&conflict_folder).unwrap();
        std::fs::write(conflict_destination.join("clip.mov"), b"first-conflict").unwrap();
        std::fs::write(conflict_folder.join("clip.mov"), b"second-conflict").unwrap();
        let mut claimed = std::collections::HashSet::new();
        let mut source_digest = None;
        match resolve_dit_target(
            &source,
            &conflict_destination,
            Path::new(""),
            "clip.mov",
            "subdirectory",
            "{name}_{index}.{ext}",
            Some("Conflicts"),
            true,
            &mut claimed,
            &cancelled,
            &mut source_digest,
        )
        .unwrap()
        {
            DitTargetResolution::Copy(path) => {
                assert_eq!(path, conflict_folder.join("clip_2.mov"));
            }
            DitTargetResolution::Reuse(_) => panic!("不同内容不应复用冲突目录中的文件"),
        }

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn media_tree_lists_nested_files_and_empty_directories() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "shadowencoder-media-tree-{}-{suffix}",
            std::process::id()
        ));
        let shots = root.join("shots");
        let empty = root.join("empty");
        std::fs::create_dir_all(&shots).expect("create nested directory");
        std::fs::create_dir_all(&empty).expect("create empty directory");
        std::fs::write(root.join("keep.wav"), b"audio").expect("write root file");
        std::fs::write(shots.join("a.mov"), b"video").expect("write nested file");

        let listing = list_media_tree_blocking(root.to_string_lossy().to_string())
            .expect("list temporary media tree");
        assert!(listing.root_is_directory);
        assert!(listing.errors.is_empty());
        assert!(listing.entries.iter().any(|entry| {
            entry.path == empty.to_string_lossy() && entry.is_directory && entry.depth == 1
        }));
        assert!(listing.entries.iter().any(|entry| {
            entry.path == shots.join("a.mov").to_string_lossy()
                && !entry.is_directory
                && entry.parent_path == shots.to_string_lossy()
                && entry.depth == 2
        }));

        std::fs::remove_dir_all(root).expect("remove temporary media tree");
    }

    #[test]
    fn crop_is_clamped_to_input_dimensions() {
        assert_eq!(
            clamp_crop_to_dimensions(Some((108, 32, 1172, 1590)), (1280, 720)),
            Some((108, 32, 1172, 688))
        );
        assert_eq!(
            clamp_crop_to_dimensions(Some((-20, 700, 400, 100)), (1280, 720)),
            Some((0, 700, 400, 20))
        );
    }

    #[test]
    fn probe_dimensions_follow_display_rotation() {
        let probe = serde_json::json!({
            "streams": [{
                "codec_type": "video",
                "width": 1280,
                "height": 720,
                "side_data_list": [{ "rotation": -90 }]
            }]
        });
        assert_eq!(display_dimensions_from_probe(&probe), Some((720, 1280)));
    }

    #[test]
    fn segment_mp4_uses_compatible_h264_and_aac_defaults() {
        assert_eq!(
            segment_video_args("mp4", "", "", "", 0, 0),
            vec![
                "-c:v",
                "libx264",
                "-profile:v",
                "main",
                "-pix_fmt",
                "yuv420p"
            ]
        );
        assert_eq!(
            segment_audio_args("mp4", "", 0),
            vec!["-c:a", "aac", "-b:a", "192k"]
        );
    }

    #[test]
    fn segment_prores_preset_is_normalized_without_crf() {
        assert_eq!(
            segment_video_args("mov", "prores", "422hq", "yuv422p10le", 23, 0),
            vec![
                "-c:v",
                "prores_ks",
                "-profile:v",
                "hq",
                "-pix_fmt",
                "yuv422p10le"
            ]
        );
        assert_eq!(
            segment_audio_args("mov", "pcm_s16le", 192),
            vec!["-c:a", "pcm_s16le"]
        );
    }

    #[test]
    fn ffmpeg_error_summary_prefers_the_actionable_diagnostic() {
        let lines = VecDeque::from([
            "[mp4 @ 0001] Could not find tag for codec pcm_s24le".to_string(),
            "Error initializing the output stream".to_string(),
            "Conversion failed!".to_string(),
        ]);
        let summary = summarize_ffmpeg_stderr(&lines);
        assert!(summary.contains("pcm_s24le"));
        assert!(summary.contains("Error initializing"));
        assert!(!summary.contains("Conversion failed!"));
    }

    #[test]
    fn gif_palette_pass_outputs_only_the_palette() {
        assert_eq!(
            gif_palette_filter("scale=480:270:flags=lanczos,format=rgba", 15.0, GifCompression::Optimized),
            "scale=480:270:flags=lanczos,format=rgba,fps=15,palettegen=max_colors=256:reserve_transparent=1:stats_mode=full"
        );
    }

    #[test]
    fn gif_render_pass_consumes_the_palette_input() {
        assert_eq!(
            gif_render_filter("scale=480:270:flags=lanczos,format=rgba", 15.0, GifCompression::Optimized),
            "[0:v]scale=480:270:flags=lanczos,format=rgba,fps=15[frames];[frames][1:v]paletteuse=dither=sierra2_4a:diff_mode=rectangle:alpha_threshold=128"
        );
    }

    #[test]
    fn gif_compression_modes_change_palette_and_dither() {
        assert!(
            gif_palette_filter("format=rgba", 12.0, GifCompression::Compact)
                .contains("max_colors=192:reserve_transparent=1:stats_mode=diff")
        );
        assert!(
            gif_render_filter("format=rgba", 12.0, GifCompression::Compact)
                .contains("dither=bayer:bayer_scale=3:diff_mode=rectangle:alpha_threshold=128")
        );
        assert!(
            gif_palette_filter("format=rgba", 12.0, GifCompression::Aggressive)
                .contains("max_colors=128:reserve_transparent=1:stats_mode=diff")
        );
        assert!(
            gif_render_filter("format=rgba", 12.0, GifCompression::Aggressive)
                .contains("dither=bayer:bayer_scale=5:diff_mode=rectangle:alpha_threshold=128")
        );
    }

    #[test]
    fn gifski_compression_modes_use_distinct_quality_budgets() {
        assert_eq!(GifCompression::Optimized.gifski_quality(), (70, 70, 70));
        assert_eq!(GifCompression::Compact.gifski_quality(), (60, 60, 60));
        assert_eq!(GifCompression::Aggressive.gifski_quality(), (50, 40, 50));
    }

    #[test]
    fn gif_compression_rejects_unknown_values() {
        assert_eq!(GifCompression::parse(None), Ok(GifCompression::Optimized));
        assert_eq!(
            GifCompression::parse(Some("quality")),
            Ok(GifCompression::Optimized)
        );
        assert_eq!(
            GifCompression::parse(Some("smallest")),
            Ok(GifCompression::Aggressive)
        );
        assert!(GifCompression::parse(Some("unknown")).is_err());
    }

    #[test]
    fn gifski_encodes_transparent_rgba_frames() {
        let path = std::env::temp_dir().join(format!(
            "shadowencoder-gifski-alpha-test-{}.gif",
            std::process::id()
        ));
        let settings = gifski::Settings {
            width: None,
            height: None,
            quality: 60,
            fast: false,
            repeat: gifski::Repeat::Infinite,
        };
        let (collector, mut writer) = gifski::new(settings).expect("create gifski pipeline");
        #[allow(deprecated)]
        writer.set_lossy_quality(60);
        let output = std::fs::File::create(&path).expect("create temporary GIF");
        let writer_thread = thread::spawn(move || {
            writer
                .write(output, &mut gifski::progress::NoProgress {})
                .expect("encode GIF")
        });
        for index in 0..2 {
            let mut pixels = vec![gifski::collector::RGBA8::new(0, 0, 0, 0); 16];
            pixels[index] = gifski::collector::RGBA8::new(255, 32, 64, 255);
            collector
                .add_frame_rgba(
                    index,
                    gifski::collector::ImgVec::new(pixels, 4, 4),
                    index as f64 / 10.0,
                )
                .expect("submit transparent frame");
        }
        drop(collector);
        writer_thread.join().expect("join gifski writer");

        let mut options = gif::DecodeOptions::new();
        options.set_color_output(gif::ColorOutput::Indexed);
        let mut decoder = options
            .read_info(std::fs::File::open(&path).expect("open encoded GIF"))
            .expect("decode GIF header");
        let frame = decoder
            .read_next_frame()
            .expect("decode first GIF frame")
            .expect("GIF contains a frame");
        assert!(frame.transparent.is_some());
        std::fs::remove_file(path).expect("remove temporary GIF");
    }
}

#[tauri::command]
fn agent_request(
    app: tauri::AppHandle,
    service: tauri::State<'_, shadowencoder_agent_core::AgentService>,
    request: shadowencoder_agent_protocol::AgentRequest,
) -> shadowencoder_agent_protocol::AgentResponse {
    let actor = request.actor.clone();
    let response = service.handle(request);
    if let Some(receipt) = &response.receipt {
        let event = shadowencoder_agent_protocol::AgentStateChanged {
            actor,
            receipt: receipt.clone(),
        };
        if let Err(error) = app.emit(shadowencoder_agent_protocol::AGENT_EVENT_NAME, event) {
            eprintln!("[shadowencoder-agent] GUI 事件发送失败: {error}");
        }
    }
    response
}

fn main() {
    tauri::Builder::default()
        .manage(mpv_player::MpvState::default())
        .setup(|app| {
            let app_data_dir = app
                .path()
                .app_data_dir()
                .map_err(|error| std::io::Error::other(format!("无法定位应用数据目录: {error}")))?;
            let agent_service = shadowencoder_agent_core::AgentService::open(
                app_data_dir.join("shadowencoder-agent.sqlite3"),
            )
            .map_err(std::io::Error::other)?;
            app.manage(agent_service.clone());
            agent_ipc::start(agent_service, app.handle().clone()).map_err(std::io::Error::other)?;

            #[cfg(target_os = "windows")]
            {
                let window = app
                    .get_webview_window("main")
                    .ok_or_else(|| std::io::Error::other("找不到主窗口，无法安装 GPU 播放表面"))?;
                app.state::<mpv_player::MpvState>()
                    .install_gpu_surface(window)
                    .map_err(std::io::Error::other)?;
            }
            #[cfg(target_os = "linux")]
            if let Some(window) = app.get_webview_window("main") {
                if let Err(error) = app
                    .state::<mpv_player::MpvState>()
                    .install_gpu_surface(window)
                {
                    eprintln!("[shadowencoder-mpv] GPU surface unavailable: {error}");
                }
            }
            #[cfg(all(debug_assertions, any(target_os = "linux", target_os = "windows")))]
            if let Ok(path) = std::env::var("SHADOWENCODER_MPV_GPU_SMOKE_FILE") {
                app.state::<mpv_player::MpvState>().run_gpu_smoke(path);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            compose_alpha,
            screenshot,
            export_gif,
            export_webp,
            export_segment,
            transcode,
            mix,
            check,
            dit_backup,
            get_video_info,
            pick_path,
            list_media_directory,
            list_media_tree,
            list_storage_volumes,
            get_storage_volume,
            read_media_file,
            preview_frame,
            open_path,
            open_output_directory,
            update_check,
            cancel_ffmpeg,
            agent_request,
            mpv_player::player_init,
            mpv_player::player_destroy,
            mpv_player::player_load,
            mpv_player::player_play,
            mpv_player::player_pause,
            mpv_player::player_toggle,
            mpv_player::player_seek,
            mpv_player::player_set_volume,
            mpv_player::player_status,
            mpv_player::player_frame,
            mpv_player::player_set_surface,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
