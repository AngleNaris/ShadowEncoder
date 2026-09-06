use super::*;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScriptPlan {
    filter_complex: String,
    pub duration: f32,
}

pub fn validate_plan(plan: &ScriptPlan) -> Result<(), String> {
    if !plan.duration.is_finite() || !(0.1..=86400.0).contains(&plan.duration)
        || plan.filter_complex.is_empty() || plan.filter_complex.len() > 262144
    {
        return Err("脚本输出格式、时长或滤镜长度无效".into());
    }
    // Only pure media filters: no file, network, device, plugin or command sources.
    let allowed = ["scale", "pad", "crop", "overlay", "xstack", "hstack", "vstack",
        "setsar", "setdar", "setpts", "fps", "format", "null", "split", "trim",
        "concat", "transpose", "hflip", "vflip", "rotate", "eq", "hue", "color",
        "colorbalance", "colorchannelmixer", "fade", "xfade", "zoompan", "boxblur",
        "gblur", "unsharp", "reverse", "loop", "tpad", "select", "lut", "lutrgb",
        "lutyuv", "geq", "chromakey", "colorkey", "alphamerge", "alphaextract",
        "blend", "tblend", "lut2", "haldclut", "colorspace", "zscale", "tonemap"];
    let mut quoted = false;
    let mut escaped = false;
    let mut start = 0;
    let mut parts = Vec::new();
    for (index, ch) in plan.filter_complex.char_indices() {
        if escaped { escaped = false; continue; }
        if ch == '\\' { escaped = true; continue; }
        if ch == '\'' { quoted = !quoted; }
        if !quoted && (ch == ',' || ch == ';') {
            parts.push(&plan.filter_complex[start..index]);
            start = index + 1;
        }
    }
    if quoted || escaped { return Err("滤镜中的引号或转义不完整".into()); }
    parts.push(&plan.filter_complex[start..]);
    for part in parts {
        let mut filter = part.trim();
        while filter.starts_with('[') {
            let end = filter.find(']').ok_or("滤镜输入标签不完整")?;
            filter = filter[end + 1..].trim_start();
        }
        let name: String = filter.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_').collect();
        if !allowed.contains(&name.as_str()) {
            return Err(format!("脚本滤镜不支持或不可访问外部资源: {name}"));
        }
        // Reject file-backed option syntax (e.g. scale=/w=/path).
        if filter.contains("=/") || filter.contains(":/") || filter.contains('\0') {
            return Err("脚本滤镜不能读取外部文件选项".into());
        }
    }
    Ok(())
}

pub fn input_args(paths: &[String], plan: &ScriptPlan, preset_filter: &str, audio: bool) -> Result<Vec<String>, String> {
    validate_plan(plan)?;
    if paths.is_empty() || paths.len() > 32 { return Err("脚本必须接收 1 到 32 个素材".into()); }
    let mut args = vec!["-y".into(), "-nostdin".into()];
    for path in paths {
        let path = std::fs::canonicalize(path).map_err(|error| format!("素材不可用 {path}: {error}"))?;
        if !path.is_file() { return Err("素材输入必须是文件".into()); }
        args.extend(["-protocol_whitelist".into(), "file,pipe".into(), "-i".into(), path.to_string_lossy().into_owned()]);
    }
    let filter = if preset_filter.is_empty() { plan.filter_complex.clone() }
        else { format!("{};[out]{}[se_encoded]", plan.filter_complex, preset_filter) };
    args.extend(["-filter_complex".into(), filter, "-map".into(), if preset_filter.is_empty() { "[out]" } else { "[se_encoded]" }.into(), "-t".into(), plan.duration.to_string()]);
    if audio { args.extend(["-map".into(), "0:a?".into()]); }
    Ok(args)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_composition_and_rejects_external_resources() {
        let mut plan = ScriptPlan { filter_complex: "[0:v]scale=64:64[a];[1:v]scale=64:64[b];[a][b]hstack=inputs=2[out]".into(), duration: 1.0 };
        assert!(validate_plan(&plan).is_ok());
        for filter in ["movie=/secret[out]", "[0:v]scale=/w=/secret[out]", "[0:v]null;amovie=test[out]", "[0:v]drawtext=textfile=secret[out]"] {
            plan.filter_complex = filter.into();
            assert!(validate_plan(&plan).is_err(), "{filter}");
        }
    }
    #[test]
    fn preprocessing_has_no_encoding_or_output_and_appends_preset_filters() {
        assert!(serde_json::from_value::<ScriptPlan>(serde_json::json!({"filterComplex":"[0:v]null[out]","duration":1,"format":"mp4"})).is_err());
        let path = std::env::temp_dir().join(format!("se-preprocess-{}-{}.mp4", std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::write(&path, b"input").unwrap();
        let plan = ScriptPlan { filter_complex: "[0:v]null[out]".into(), duration: 2.0 };
        let result = input_args(&[path.to_string_lossy().into_owned()], &plan, "scale=1920:1080", true);
        std::fs::remove_file(path).unwrap();
        let args = result.unwrap();
        assert!(args.contains(&"[0:v]null[out];[out]scale=1920:1080[se_encoded]".into()));
        assert!(args.contains(&"0:a?".into()));
        assert!(!args.iter().any(|arg| matches!(arg.as_str(), "-c:v" | "-b:v" | "-crf" | "-f")));
    }
}
