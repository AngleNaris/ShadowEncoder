use serde_json::{json, Value};

pub const PRESET_TYPES: [&str; 10] = [
    "encode",
    "mix",
    "check",
    "alpha",
    "screenshot",
    "segment",
    "gif",
    "webp",
    "backup",
    "workflow",
];

const OUTPUT_FIELDS: [&str; 4] = [
    "outputMode",
    "outputNameTemplate",
    "outputSubdirectory",
    "outputDirectory",
];

const ENCODE_FIELDS: [&str; 29] = [
    "container",
    "videoCodec",
    "videoProfile",
    "crf",
    "preset",
    "tune",
    "pixelFormat",
    "scaleW",
    "scaleH",
    "fps",
    "keepRes",
    "loudnorm",
    "audioOnly",
    "audioCodec",
    "audioProfile",
    "audioBitrate",
    "videoBitrate",
    "audioSampleRate",
    "audioChannels",
    "unsharp",
    "denoise",
    "style",
    "rateMode",
    "targetFileSizeMb",
    "twoPass",
    "previewDuringEncode",
    "outputMode",
    "outputNameTemplate",
    "outputSubdirectory",
];

const BACKUP_SCALAR_FIELDS: [&str; 16] = [
    "minSizeMb",
    "mediaOnly",
    "recursive",
    "operation",
    "verifyMd5",
    "destinationNameMode",
    "destinationNameTemplate",
    "directoryStructure",
    "renameMode",
    "renameTemplate",
    "conflictStrategy",
    "conflictRenameTemplate",
    "conflictSubdirectory",
    "outputMode",
    "outputNameTemplate",
    "outputDirectory",
];

const BOOLEAN_FIELDS: [&str; 15] = [
    "keepRes",
    "loudnorm",
    "audioOnly",
    "twoPass",
    "previewDuringEncode",
    "lnOn",
    "tpOn",
    "recursive",
    "blackDetect",
    "fpsOriginal",
    "fixedDur",
    "mediaOnly",
    "verifyMd5",
    "unsharpEnabled",
    "denoiseEnabled",
];

const INTEGER_FIELDS: [&str; 14] = [
    "scaleW",
    "scaleH",
    "audioBitrate",
    "videoBitrate",
    "audioSampleRate",
    "audioChannels",
    "unsharp",
    "denoise",
    "style",
    "w",
    "h",
    "quality",
    "minSizeMb",
    "targetFileSizeMb",
];

const NUMBER_FIELDS: [&str; 10] = [
    "crf",
    "fps",
    "lnI",
    "lnTp",
    "lnLra",
    "cpTh",
    "cpGain",
    "fpsTol",
    "fixedVal",
    "trigger.settleSeconds",
];

const CONTAINERS: [&str; 14] = [
    "mp4", "mkv", "mov", "webm", "avi", "flv", "ts", "mpeg", "wmv", "ogv", "3gp", "asf", "m4v",
    "gif",
];
const VIDEO_CODECS: [&str; 23] = [
    "copy",
    "libx264",
    "libx265",
    "h264_nvenc",
    "hevc_nvenc",
    "h264_amf",
    "hevc_amf",
    "h264_qsv",
    "hevc_qsv",
    "libsvtav1",
    "libaom-av1",
    "av1_nvenc",
    "av1_amf",
    "av1_qsv",
    "libvpx",
    "libvpx-vp9",
    "mpeg4",
    "mpeg2video",
    "prores",
    "dnxhd",
    "mjpeg",
    "ffv1",
    "gif",
];
const AUDIO_CODECS: [&str; 12] = [
    "copy",
    "aac",
    "libmp3lame",
    "libopus",
    "libvorbis",
    "flac",
    "pcm_s16le",
    "pcm_s24le",
    "alac",
    "ac3",
    "eac3",
    "wmav2",
];

pub fn is_preset_type(value: &str) -> bool {
    PRESET_TYPES.contains(&value)
}

pub fn validate_name(value: &str) -> Result<(), String> {
    let length = value.chars().count();
    if value.trim().is_empty() {
        return Err("预设名称不能为空".into());
    }
    if length > 128 {
        return Err("预设名称不能超过 128 个字符".into());
    }
    if value.contains('\0') {
        return Err("预设名称包含非法字符".into());
    }
    Ok(())
}

pub fn is_list_field(preset_type: &str, field: &str) -> bool {
    preset_type == "backup" && matches!(field, "destinations" | "extensions")
}

pub fn validate_list_item(preset_type: &str, field: &str, value: &Value) -> Result<(), String> {
    if !is_list_field(preset_type, field) {
        return Err(format!("字段 {field} 不是可逐项编辑的列表"));
    }
    let text = value
        .as_str()
        .ok_or_else(|| format!("字段 {field} 的列表项必须是字符串"))?;
    if text.trim().is_empty() {
        return Err(format!("字段 {field} 的列表项不能为空"));
    }
    if text.len() > 4096 || text.contains('\0') {
        return Err(format!("字段 {field} 的列表项无效"));
    }
    if field == "extensions"
        && (!text
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
            || text.starts_with('.'))
    {
        return Err("扩展名只填写名称本身，例如 mp4，不能包含点号或通配符".into());
    }
    Ok(())
}

pub fn validate_scalar_field(preset_type: &str, field: &str, value: &Value) -> Result<(), String> {
    if value.is_array() || value.is_object() || value.is_null() {
        return Err("preset set 只允许修改一个标量字段；列表必须使用 item-add/item-remove".into());
    }
    if is_list_field(preset_type, field) {
        return Err(format!("字段 {field} 必须使用 item-add/item-remove 修改"));
    }
    if !field_allowed(preset_type, field) {
        return Err(format!("{preset_type} 预设不存在可编辑字段 {field}"));
    }

    if BOOLEAN_FIELDS.contains(&field) && !value.is_boolean() {
        return Err(format!("字段 {field} 必须是 true 或 false"));
    }
    if INTEGER_FIELDS.contains(&field) {
        let number = value
            .as_i64()
            .ok_or_else(|| format!("字段 {field} 必须是整数"))?;
        validate_integer_range(field, number)?;
    } else if NUMBER_FIELDS.contains(&field) {
        let number = value
            .as_f64()
            .ok_or_else(|| format!("字段 {field} 必须是数字"))?;
        if !number.is_finite() {
            return Err(format!("字段 {field} 必须是有限数字"));
        }
        validate_number_range(field, number)?;
    } else {
        let text = value
            .as_str()
            .ok_or_else(|| format!("字段 {field} 必须是字符串"))?;
        if text.len() > 4096 || text.contains('\0') {
            return Err(format!("字段 {field} 的文本无效"));
        }
        validate_enum(field, text)?;
    }
    Ok(())
}

fn field_allowed(preset_type: &str, field: &str) -> bool {
    let output = OUTPUT_FIELDS.contains(&field);
    match preset_type {
        "encode" => ENCODE_FIELDS.contains(&field) || field == "outputDirectory",
        "mix" => {
            matches!(
                field,
                "lnOn" | "lnI" | "lnTp" | "lnLra" | "tpOn" | "cpTh" | "cpGain"
            ) || output
        }
        "check" => matches!(
            field,
            "refEncPresetId" | "fpsTol" | "recursive" | "blackDetect"
        ),
        "alpha" => matches!(field, "fpsOriginal" | "fps") || output,
        "screenshot" => matches!(field, "aspect" | "customRatio" | "w" | "h") || output,
        "segment" => {
            matches!(
                field,
                "aspect" | "customRatio" | "w" | "h" | "fixedDur" | "fixedVal" | "clipPresetId"
            ) || output
        }
        "gif" => {
            matches!(
                field,
                "aspect"
                    | "customRatio"
                    | "w"
                    | "h"
                    | "fps"
                    | "gifCompression"
                    | "fixedDur"
                    | "fixedVal"
            ) || output
        }
        "webp" => {
            matches!(
                field,
                "aspect" | "customRatio" | "w" | "h" | "fps" | "quality" | "fixedDur" | "fixedVal"
            ) || output
        }
        "backup" => BACKUP_SCALAR_FIELDS.contains(&field),
        "workflow" => matches!(
            field,
            "trigger.kind"
                | "trigger.volumeKind"
                | "trigger.labelContains"
                | "trigger.settleSeconds"
        ),
        _ => false,
    }
}

fn validate_integer_range(field: &str, value: i64) -> Result<(), String> {
    let valid = match field {
        "scaleW" | "scaleH" => (0..=8192).contains(&value),
        "w" | "h" => (1..=8192).contains(&value),
        "quality" => (1..=100).contains(&value),
        "audioBitrate" | "videoBitrate" => (0..=1_000_000).contains(&value),
        "audioSampleRate" => (8_000..=384_000).contains(&value),
        "audioChannels" => (1..=32).contains(&value),
        "unsharp" | "denoise" | "style" => (0..=10).contains(&value),
        "minSizeMb" | "targetFileSizeMb" => (0..=10_000_000).contains(&value),
        _ => true,
    };
    if valid {
        Ok(())
    } else {
        Err(format!("字段 {field} 超出允许范围"))
    }
}

fn validate_number_range(field: &str, value: f64) -> Result<(), String> {
    let valid = match field {
        "crf" => (0.0..=63.0).contains(&value),
        "fps" => (0.0..=240.0).contains(&value),
        "lnI" => (-70.0..=-5.0).contains(&value),
        "lnTp" => (-9.0..=0.0).contains(&value),
        "lnLra" => (1.0..=50.0).contains(&value),
        "cpTh" => (-80.0..=0.0).contains(&value),
        "cpGain" => (-20.0..=40.0).contains(&value),
        "fpsTol" => (0.0..=10.0).contains(&value),
        "fixedVal" => (0.1..=9999.0).contains(&value),
        "trigger.settleSeconds" => (1.0..=30.0).contains(&value),
        _ => true,
    };
    if valid {
        Ok(())
    } else {
        Err(format!("字段 {field} 超出允许范围"))
    }
}

fn validate_enum(field: &str, value: &str) -> Result<(), String> {
    let allowed: Option<&[&str]> = match field {
        "container" => Some(&CONTAINERS),
        "videoCodec" => Some(&VIDEO_CODECS),
        "audioCodec" => Some(&AUDIO_CODECS),
        "rateMode" => Some(&["crf", "bitrate", "filesize"]),
        "outputMode" => Some(&["source", "rename", "subdir", "fixed"]),
        "aspect" => Some(&["free", "1:1", "4:3", "16:9", "9:16", "match", "custom"]),
        "gifCompression" => Some(&["optimized", "compact", "aggressive"]),
        "operation" => Some(&["copy", "move"]),
        "destinationNameMode" | "renameMode" => Some(&["original", "template"]),
        "directoryStructure" => Some(&["preserve", "flatten"]),
        "conflictStrategy" => Some(&["rename", "subdirectory"]),
        "trigger.kind" => Some(&["manual", "removable"]),
        "trigger.volumeKind" => Some(&["removable", "any"]),
        _ => None,
    };
    if allowed.is_some_and(|values| !values.contains(&value)) {
        return Err(format!("字段 {field} 的值不在允许列表中"));
    }
    Ok(())
}

pub fn schema_list() -> Value {
    Value::Array(
        PRESET_TYPES
            .iter()
            .map(|preset_type| {
                json!({
                    "function": preset_type,
                    "schemaCommand": format!("shadowencoder-cli schema show {preset_type} --json")
                })
            })
            .collect(),
    )
}

pub fn schema_show(preset_type: &str) -> Option<Value> {
    if !is_preset_type(preset_type) {
        return None;
    }
    let scalar_fields: Vec<&str> = match preset_type {
        "encode" => ENCODE_FIELDS
            .iter()
            .copied()
            .chain(std::iter::once("outputDirectory"))
            .collect(),
        "mix" => ["lnOn", "lnI", "lnTp", "lnLra", "tpOn", "cpTh", "cpGain"]
            .into_iter()
            .chain(OUTPUT_FIELDS)
            .collect(),
        "check" => vec!["refEncPresetId", "fpsTol", "recursive", "blackDetect"],
        "alpha" => ["fpsOriginal", "fps"]
            .into_iter()
            .chain(OUTPUT_FIELDS)
            .collect(),
        "screenshot" => ["aspect", "customRatio", "w", "h"]
            .into_iter()
            .chain(OUTPUT_FIELDS)
            .collect(),
        "segment" => [
            "aspect",
            "customRatio",
            "w",
            "h",
            "fixedDur",
            "fixedVal",
            "clipPresetId",
        ]
        .into_iter()
        .chain(OUTPUT_FIELDS)
        .collect(),
        "gif" => [
            "aspect",
            "customRatio",
            "w",
            "h",
            "fps",
            "gifCompression",
            "fixedDur",
            "fixedVal",
        ]
        .into_iter()
        .chain(OUTPUT_FIELDS)
        .collect(),
        "webp" => [
            "aspect",
            "customRatio",
            "w",
            "h",
            "fps",
            "quality",
            "fixedDur",
            "fixedVal",
        ]
        .into_iter()
        .chain(OUTPUT_FIELDS)
        .collect(),
        "backup" => BACKUP_SCALAR_FIELDS.to_vec(),
        "workflow" => vec![
            "trigger.kind",
            "trigger.volumeKind",
            "trigger.labelContains",
            "trigger.settleSeconds",
        ],
        _ => Vec::new(),
    };
    let list_fields: Vec<&str> = if preset_type == "backup" {
        vec!["destinations", "extensions"]
    } else {
        Vec::new()
    };
    Some(json!({
        "function": preset_type,
        "scalarFields": scalar_fields,
        "listFields": list_fields,
        "workflowStepFields": if preset_type == "workflow" {
            json!(["kind", "presetId", "presetRevision", "failureMode", "condition.kind", "condition.backupPresetId", "condition.reservePercent"])
        } else {
            json!([])
        },
        "rules": {
            "singleMutationOnly": true,
            "wholeObjectReplacement": false,
            "arbitraryFfmpegArguments": false
        }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn array_replacement_is_rejected() {
        assert!(validate_scalar_field("backup", "destinations", &json!(["D:/Backup"])).is_err());
    }

    #[test]
    fn extension_items_do_not_accept_dot_prefix() {
        assert!(validate_list_item("backup", "extensions", &json!(".mp4")).is_err());
        assert!(validate_list_item("backup", "extensions", &json!("mp4")).is_ok());
    }

    #[test]
    fn arbitrary_codec_is_rejected() {
        assert!(validate_scalar_field("encode", "videoCodec", &json!("-filter_complex")).is_err());
    }
}
