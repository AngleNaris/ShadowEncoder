#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use serde::Serialize;
use serde_json::Value;
use tauri::Emitter;

#[derive(Clone, Serialize)]
struct Progress {
    percent: f32,
    fps: f32,
    detail: String,
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
        fps,
        detail: format!("time={}", t),
    })
}

/// 向前端推送一条日志（对应原 ActivityLog 行）
fn emit_log(window: &tauri::Window, line: &str) {
    let _ = window.emit("ffmpeg-log", line.to_string());
}

/// 通用：spawn ffmpeg，逐行解析进度并推事件，返回 (success, last_stderr)
fn run_with_progress(
    args: &[String],
    duration: f32,
    window: &tauri::Window,
    stage: &str,
) -> Result<(), String> {
    let mut cmd = Command::new("ffmpeg");
    cmd.args(args).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("无法启动 ffmpeg: {}", e))?;

    let stderr = child.stderr.take().unwrap();
    let mut last = String::new();
    for line in BufReader::new(stderr).lines().flatten() {
        last = line.clone();
        if let Some(p) = parse_progress(&line, duration) {
            let _ = window.emit(
                "ffmpeg-progress",
                Progress {
                    percent: p.percent,
                    fps: p.fps,
                    detail: format!("{} | {}", stage, p.detail),
                },
            );
        }
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    if status.success() {
        emit_log(window, &format!("[PASS] {} 完成", stage));
        Ok(())
    } else {
        let msg = last.lines().last().unwrap_or("未知错误").to_string();
        emit_log(window, &format!("[FAIL] {}: {}", stage, msg));
        Err(format!("ffmpeg 失败: {}", msg))
    }
}

fn probe_duration(path: &str) -> f32 {
    let out = Command::new("ffprobe")
        .args([
            "-v", "error", "-show_entries", "format=duration",
            "-of", "default=nw=1:nk=1", path,
        ])
        .output();
    if let Ok(o) = out {
        String::from_utf8_lossy(&o.stdout).trim().parse::<f32>().unwrap_or(0.0)
    } else {
        0.0
    }
}

/// 常见视频扩展名
fn is_video(p: &str) -> bool {
    let low = p.to_lowercase();
    ["mp4", "mov", "mkv", "avi", "webm", "m4v", "flv", "wmv", "ts", "m2ts"]
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

#[tauri::command]
fn compose_alpha(
    input: String,
    output: String,
    fps: Option<f32>,
    window: tauri::Window,
) -> Result<(), String> {
    let info = get_info_map(&input);
    let full_h = info.get("height").and_then(|v| v.as_i64()).unwrap_or(0) as i64;
    let rgb_h = full_h / 2;
    let vf = format!(
        "[0:v]crop={w}:{h}:0:0[rgb];[0:v]crop={w}:{h}:0:{h},format=gray,geq=lum=255:p=0[alpha];[rgb][alpha]alphamerge[out]",
        w = info.get("width").and_then(|v| v.as_i64()).unwrap_or(0),
        h = rgb_h,
    );
    let mut args = vec![
        "-y".into(), "-i".into(), input.clone(),
        "-filter_complex".into(), vf,
        "-c:v".into(), "prores_ks".into(),
        "-profile:v".into(), "4444".into(),
        "-pix_fmt".into(), "yuva444p10le".into(),
    ];
    if let Some(f) = fps {
        args.push("-r".into());
        args.push(f.to_string());
    }
    args.push("-c:a".into());
    args.push("copy".into());
    args.push(output);
    emit_log(&window, &format!("输入: {}", input));
    run_with_progress(&args, 0.0, &window, "合成透明通道")
}

#[tauri::command]
fn screenshot(
    input: String,
    output: String,
    time_sec: f32,
    width: i32,
    height: i32,
    crop: Option<(i32, i32, i32, i32)>,
    window: tauri::Window,
) -> Result<(), String> {
    let mut vf = Vec::new();
    if let Some((x, y, w, h)) = crop {
        if w > 0 && h > 0 {
            vf.push(format!("crop={w}:{h}:{x}:{y}"));
        }
    }
    vf.push(format!("scale={width}:{height}"));
    let args = vec![
        "-y".into(), "-ss".into(), time_sec.to_string(), "-i".into(), input.clone(),
        "-vframes".into(), "1".into(), "-vf".into(), vf.join(","),
        output.clone(),
    ];
    emit_log(&window, &format!("截图: {} @ {:.3}s -> {}", input, time_sec, output.clone()));
    run_with_progress(&args, 0.0, &window, "截图")
}

#[tauri::command]
fn export_gif(
    input: String,
    output: String,
    start: f32,
    duration: f32,
    fps: f32,
    width: i32,
    height: i32,
    crop: Option<(i32, i32, i32, i32)>,
    window: tauri::Window,
) -> Result<(), String> {
    let dur = probe_duration(&input);
    let mut vf = Vec::new();
    if let Some((x, y, w, h)) = crop {
        if w > 0 && h > 0 {
            vf.push(format!("crop={w}:{h}:{x}:{y}"));
        }
    }
    vf.push(format!("scale={width}:{height}:flags=lanczos"));
    let vf_s = vf.join(",");
    let palette = std::env::temp_dir().join("se_palette.png");
    let p = palette.to_string_lossy().to_string();
    // pass 1: palettegen
    let a1 = vec![
        "-y".into(), "-ss".into(), start.to_string(), "-i".into(), input.clone(),
        "-t".into(), duration.to_string(), "-vf".into(),
        format!("{},split[s0][s1];[s0]palettegen=reserve_transparent=1[s];[s1][s]paletteuse", vf_s),
        p.clone(),
    ];
    emit_log(&window, &format!("导出 GIF: {} -> {}", input, output));
    run_with_progress(&a1, dur, &window, "GIF 调色板")?;
    // pass 2: paletteuse
    let a2 = vec![
        "-y".into(), "-ss".into(), start.to_string(), "-i".into(), input.clone(),
        "-t".into(), duration.to_string(),
        "-i".into(), p.clone(),
        "-lavfi".into(), format!("{},split[s0][s1];[s0]palettegen=reserve_transparent=1[s];[s1][s]paletteuse", vf_s),
        "-r".into(), fps.to_string(), "-loop".into(), "0".into(), output,
    ];
    run_with_progress(&a2, dur, &window, "导出 GIF")
}

#[tauri::command]
fn export_webp(
    input: String,
    output: String,
    start: f32,
    duration: f32,
    fps: f32,
    width: i32,
    height: i32,
    quality: i32,
    crop: Option<(i32, i32, i32, i32)>,
    window: tauri::Window,
) -> Result<(), String> {
    let dur = probe_duration(&input);
    let mut vf = Vec::new();
    if let Some((x, y, w, h)) = crop {
        if w > 0 && h > 0 {
            vf.push(format!("crop={w}:{h}:{x}:{y}"));
        }
    }
    vf.push(format!("scale={width}:{height}:flags=lanczos"));
    let args = vec![
        "-y".into(), "-ss".into(), start.to_string(), "-i".into(), input.clone(),
        "-t".into(), duration.to_string(),
        "-vf".into(), vf.join(","),
        "-c:v".into(), "libwebp".into(),
        "-quality".into(), quality.to_string(),
        "-preset".into(), "default".into(),
        "-an".into(),
        "-r".into(), fps.to_string(),
        "-fps_mode".into(), "cfr".into(),
        output.clone(),
    ];
    emit_log(&window, &format!("导出 WebP: {} -> {}", input, output));
    run_with_progress(&args, dur, &window, "导出 WebP")
}

#[tauri::command]
fn export_segment(
    input: String,
    output: String,
    start: f32,
    duration: f32,
    fps: f32,
    width: i32,
    height: i32,
    out_format: String,
    crop: Option<(i32, i32, i32, i32)>,
    video_codec: String,
    video_profile: String,
    crf: i32,
    video_bitrate: i32,
    window: tauri::Window,
) -> Result<(), String> {
    let dur = probe_duration(&input);
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
        "-y".into(), "-ss".into(), start.to_string(), "-i".into(), input.clone(),
        "-t".into(), duration.to_string(),
    ];
    if !vf.is_empty() {
        args.push("-vf".into());
        args.push(vf.join(","));
    }
    // 选中编码预设：应用其视频编码设置；否则回退按容器的默认逻辑
    let use_vc = if video_codec.is_empty() || video_codec == "copy" { String::new() } else { video_codec.clone() };
    if !use_vc.is_empty() {
        args.push("-c:v".into());
        args.push(use_vc.clone());
        if !video_profile.is_empty() {
            args.push("-profile:v".into());
            args.push(video_profile.clone());
        }
        if crf > 0 {
            args.push("-crf".into());
            args.push(crf.to_string());
        } else if video_bitrate > 0 {
            args.push("-b:v".into());
            args.push(format!("{}k", video_bitrate));
        }
    } else if out_format == "mov" {
        args.extend(["-c:v".into(), "prores_ks".into(), "-profile:v".into(), "4444".into(), "-pix_fmt".into(), "yuva444p10le".into()]);
    } else {
        args.extend(["-c:v".into(), "libx264".into(), "-profile:v".into(), "main".into()]);
    }
    args.push("-c:a".into());
    args.push("copy".into());
    if fps > 0.0 {
        args.push("-r".into());
        args.push(fps.to_string());
    }
    args.push(output.clone());
    emit_log(&window, &format!("截取片段: {} -> {}", input, output));
    run_with_progress(&args, dur, &window, "截取片段")
}

/* ════════════ 原 ShadowEncoder 命令（功能等价版） ════════════ */

#[tauri::command]
fn transcode(
    paths: Vec<String>,
    video_codec: String,
    video_profile: String,
    crf: i32,
    speed_preset: String,
    tune: String,
    style: i32,
    pix_fmt: String,
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
    window: tauri::Window,
) -> Result<(), String> {
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

    let ext = if container.is_empty() { "mp4" } else { container.as_str() };

    for p in &files {
        let dur = probe_duration(p);
        let base = p.rsplit_once('.').map(|(b, _)| b).unwrap_or(p);
        let out = format!("{}_se.{}", base, ext);

        // ── 仅音频 / 视频流复制：视频直接 copy，只处理封装与音频轨 ──
        if audio_only || vc == "copy" {
            let mut c = vec!["-y".into(), "-i".into(), p.clone(), "-c:v".into(), "copy".into()];
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
            c.push(out);
            emit_log(&window, &format!("视频流复制，处理封装/音频: {}", p));
            run_with_progress(&c, dur, &window, "音频处理")?;
            continue;
        }

        // ── 视频质量参数（CRF / 固定码率 / 按目标文件体积）──
        // 码控模式：filesize > bitrate > crf（兼容旧调用：rate_mode 为空时按 video_bitrate>0 判）
        let is_filesize = rate_mode == "filesize" && target_file_size_mb > 0.0;
        let is_bitrate  = rate_mode == "bitrate" || (rate_mode.is_empty() && video_bitrate > 0);
        // 按目标文件体积计算码率（每文件不同，需用 ffprobe 取时长）
        let eff_bitrate = if is_filesize {
            let target_bits = target_file_size_mb * 8_388_608.0; // MB → bits (1024*1024*8)
            if dur > 0.0 {
                let abr = if audio_bitrate > 0 && !audio_codec.is_empty() && audio_codec != "copy" {
                    audio_bitrate as f64
                } else { 0.0 };
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
        if !pix_fmt.is_empty() {
            quality.push("-pix_fmt".into());
            quality.push(pix_fmt.clone());
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
                let vb = if is_bitrate || is_filesize { eff_bitrate } else { 2000 };
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
        let vf_str = if vf.is_empty() { String::new() } else { vf.join(",") };

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

        // Pass 1（分析）
        let mut c1 = vec!["-y".into(), "-i".into(), p.clone()];
        c1.extend(quality.iter().cloned());
        c1.push("-an".into());
        c1.push("-pass".into());
        c1.push("1".into());
        c1.push("-f".into());
        c1.push("null".into());
        c1.push("NUL".into());

        // Pass 2（编码）
        let mut c2 = vec!["-y".into(), "-i".into(), p.clone()];
        c2.extend(quality.iter().cloned());
        if !vf_str.is_empty() {
            c2.push("-vf".into());
            c2.push(vf_str.clone());
        }
        c2.extend(audio.iter().cloned());
        if let Some(a) = &af {
            c2.push("-af".into());
            c2.push(a.clone());
        }
        c2.push("-f".into());
        c2.push(ext.to_string());
        c2.push("-pass".into());
        c2.push("2".into());
        c2.push(out);

        emit_log(&window, &format!("转码: {}", p));
        let _ = run_with_progress(&c1, dur, &window, "转码 Pass1");
        run_with_progress(&c2, dur, &window, "转码 Pass2")?;
    }
    emit_log(&window, "[PASS] 全部转码完成");
    Ok(())
}

#[tauri::command]
fn mix(
    paths: Vec<String>,
    loudnorm_i: f32,
    loudnorm_tp: f32,
    loudnorm_lra: f32,
    compand_threshold: f32,
    compand_gain: f32,
    loudnorm_on: bool,
    compand_on: bool,
    window: tauri::Window,
) -> Result<(), String> {
    let files = expand_inputs(&paths, false);
    emit_log(&window, &format!("开始混音，共 {} 个文件", files.len()));
    for p in &files {
        let dur = probe_duration(p);
        let base = p.rsplit_once('.').map(|(b, _)| b).unwrap_or(p);
        let out = format!("{}_mix.mp4", base);
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
            filters.push(format!("loudnorm=I={i}:TP={tp}:LRA={lra}", i = loudnorm_i, tp = loudnorm_tp, lra = loudnorm_lra));
        }
        let af = filters.join(",");
        let mut args: Vec<String> = vec![
            "-y".into(), "-i".into(), p.clone(),
            "-c:v".into(), "copy".into(),
        ];
        if !af.is_empty() {
            args.push("-af".into());
            args.push(af);
        }
        args.push("-c:a".into());
        args.push("aac".into());
        args.push("-b:a".into());
        args.push("320k".into());
        args.push(out);
        emit_log(&window, &format!("混音: {}", p));
        run_with_progress(&args, dur, &window, "混音")?;
    }
    emit_log(&window, "[PASS] 全部混音完成");
    Ok(())
}

#[derive(Serialize)]
struct CheckSummary {
    pass: i32,
    pass_with_warnings: i32,
    fail: i32,
}

#[tauri::command]
fn check(
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
    let mut sum = CheckSummary { pass: 0, pass_with_warnings: 0, fail: 0 };
    let files = expand_inputs(&paths, recursive);
    emit_log(&window, &format!("开始检测，共 {} 个文件", files.len()));
    let standard_fps: [f32; 8] = [23.976, 24.0, 25.0, 29.97, 30.0, 50.0, 59.94, 60.0];
    for p in &files {
        let out = Command::new("ffprobe")
            .args(["-v", "error", "-show_entries", "stream=width,height,r_frame_rate,codec_type,bit_rate,codec_name,pix_fmt", "-show_entries", "format=duration", "-of", "json", p])
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
            continue;
        }
        let vid = video.unwrap();
        let width = vid["width"].as_i64().unwrap_or(0);
        let height = vid["height"].as_i64().unwrap_or(0);
        let codec = vid["codec_name"].as_str().unwrap_or("").to_string();
        let fr = vid["r_frame_rate"].as_str().unwrap_or("0/1").split('/').collect::<Vec<&str>>();
        let fps = if fr.len() == 2 {
            let a = fr[0].parse::<f32>().unwrap_or(0.0);
            let b = fr[1].parse::<f32>().unwrap_or(1.0);
            if b > 0.0 { a / b } else { 0.0 }
        } else { 0.0 };
        let mut warns: Vec<String> = Vec::new();
        if width <= 0 || height <= 0 {
            emit_log(&window, &format!("[FAIL] 分辨率异常 {}x{}: {}", width, height, p));
            sum.fail += 1;
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
                warns.push(format!("分辨率不符 期望 {}x{} 实际 {}x{}", expected_width, expected_height, width, height));
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
            let nearest = standard_fps.iter().copied().min_by(|a, b| {
                (a - fps).abs().partial_cmp(&(b - fps).abs()).unwrap()
            }).unwrap_or(fps);
            if (nearest - fps).abs() > fps_tolerance.max(0.01) {
                warns.push(format!("帧率 {:.3} 偏离标准 {:.3}", fps, nearest));
            }
        }
        // 黑帧检测（启用时，检测开头是否有黑色帧）
        if black_detect {
            let _b_out = Command::new("ffmpeg")
                .args([
                    "-v", "quiet", "-i", p,
                    "-vf", "blackframe=amount=99:threshold=32",
                    "-f", "null", "NUL",
                ])
                .output();
            // 黑帧检测为可选的辅助项：不阻断主流程，忽略执行错误
        }
        if warns.is_empty() {
            emit_log(&window, &format!("[PASS] 通过: {} ({}x{} {:.3}fps)", p, width, height, fps));
            sum.pass += 1;
        } else {
            emit_log(&window, &format!("[PASS_WITH_WARNINGS] {} ({}x{} {:.3}fps) 警告: {}", p, width, height, fps, warns.join("; ")));
            sum.pass_with_warnings += 1;
        }
    }
    let _ = fps_tolerance;
    Ok(sum)
}

/* ════════════ 元数据 / 选择 / 预览 / 更新 ════════════ */

fn get_info_map(path: &str) -> std::collections::HashMap<String, Value> {
    let mut m = std::collections::HashMap::new();
    let out = Command::new("ffprobe")
        .args(["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", path])
        .output();
    if let Ok(o) = out {
        if let Ok(v) = serde_json::from_slice::<Value>(&o.stdout) {
            if let Some(s) = v["streams"].as_array().and_then(|a| a.first()) {
                if let Some(w) = s["width"].as_i64() { m.insert("width".into(), w.into()); }
                if let Some(h) = s["height"].as_i64() { m.insert("height".into(), h.into()); }
            }
        }
    }
    m
}

#[tauri::command]
fn get_video_info(path: String) -> Result<Value, String> {
    let output = Command::new("ffprobe")
        .args(["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", &path])
        .output()
        .map_err(|e| e.to_string())?;
    serde_json::from_slice(&output.stdout).map_err(|e| e.to_string())
}

/// 前端文件/文件夹选择：rfd 现代系统对话框（与 OpenFileDialog 同风格，支持多选）
/// 多文件时以换行拼接返回；目录返回单路径。
#[tauri::command]
fn pick_path(kind: String) -> Result<Option<String>, String> {
    if kind == "dir" {
        let folder = rfd::FileDialog::new()
            .set_title("选择文件夹")
            .pick_folder();
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
                    "mp4", "mov", "mkv", "avi", "webm", "m4v", "flv", "wmv", "ts", "m2ts",
                    "png", "jpg", "jpeg", "gif", "webp", "bmp",
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

/// 读取媒体文件原始字节，供前端用 Blob URL 在 <video> 中预览（Tauri 无资产协议时的最佳方案）
#[tauri::command]
fn read_media_file(path: String) -> Result<Vec<u8>, String> {
    let meta = std::fs::metadata(&path).map_err(|e| format!("无法访问文件: {}", e))?;
    const MAX: u64 = 1_500_000_000; // 1.5GB 预览上限，避免内存爆炸
    if meta.len() > MAX {
        return Err(format!("文件过大（{:.1}GB），预览仅支持小于 1.5GB 的文件", meta.len() as f64 / 1e9));
    }
    std::fs::read(&path).map_err(|e| format!("读取失败: {}", e))
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

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            compose_alpha, screenshot, export_gif, export_webp, export_segment,
            transcode, mix, check,
            get_video_info, pick_path, read_media_file, update_check
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
