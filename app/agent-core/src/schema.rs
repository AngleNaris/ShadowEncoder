use serde_json::{json, Map, Value};

pub const PRESET_TYPES: [&str; 11] = [
    "encode",
    "mix",
    "check",
    "alpha",
    "screenshot",
    "segment",
    "gif",
    "webp",
    "sequence",
    "backup",
    "workflow",
];

const OUTPUT_FIELDS: [&str; 4] = [
    "outputMode",
    "outputNameTemplate",
    "outputSubdirectory",
    "outputDirectory",
];

const ENCODE_FIELDS: [&str; 37] = [
    "outputKind",
    "container",
    "videoCodec",
    "videoProfile",
    "crf",
    "preset",
    "tune",
    "videoLevel",
    "pixelFormat",
    "scaleMode",
    "scaleEdge",
    "scaleW",
    "scaleH",
    "fps",
    "keepRes",
    "loudnorm",
    "audioOnly",
    "noAudio",
    "audioCodec",
    "audioProfile",
    "audioBitrate",
    "videoBitrate",
    "maxrate",
    "bufsize",
    "audioSampleRate",
    "audioChannels",
    "unsharp",
    "denoise",
    "deblock",
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

const BOOLEAN_FIELDS: [&str; 17] = [
    "keepRes",
    "loudnorm",
    "audioOnly",
    "noAudio",
    "twoPass",
    "previewDuringEncode",
    "lnOn",
    "tpOn",
    "recursive",
    "blackDetect",
    "fpsOriginal",
    "fullDuration",
    "fixedDur",
    "mediaOnly",
    "verifyMd5",
    "unsharpEnabled",
    "denoiseEnabled",
];

const INTEGER_FIELDS: [&str; 16] = [
    "scaleW",
    "scaleH",
    "scaleEdge",
    "audioBitrate",
    "videoBitrate",
    "maxrate",
    "bufsize",
    "audioSampleRate",
    "audioChannels",
    "style",
    "w",
    "h",
    "quality",
    "pngCompression",
    "minSizeMb",
    "targetFileSizeMb",
];

const NUMBER_FIELDS: [&str; 13] = [
    "crf",
    "unsharp",
    "denoise",
    "deblock",
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

const CONTAINERS: [&str; 19] = [
    "mp4", "mkv", "mov", "webm", "avi", "flv", "ts", "mpeg", "wmv", "ogv", "3gp", "asf", "m4v",
    "mp3", "m4a", "wav", "flac", "ogg", "opus",
];
const VIDEO_CODECS: [&str; 21] = [
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
    "ffv1",
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

    if BOOLEAN_FIELDS.contains(&field) {
        if !value.is_boolean() {
            return Err(format!("字段 {field} 必须是 true 或 false"));
        }
    } else if INTEGER_FIELDS.contains(&field) {
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
        "screenshot" => {
            matches!(
                field,
                "aspect" | "customRatio" | "w" | "h" | "imageFormat" | "quality" | "pngCompression"
            ) || output
        }
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
        "sequence" => {
            matches!(
                field,
                "aspect"
                    | "customRatio"
                    | "w"
                    | "h"
                    | "fps"
                    | "imageFormat"
                    | "quality"
                    | "pngCompression"
                    | "fullDuration"
                    | "fixedDur"
                    | "fixedVal"
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

fn integer_range(field: &str) -> Option<(i64, i64)> {
    match field {
        "scaleW" | "scaleH" => Some((0, 8192)),
        "scaleEdge" => Some((0, 16384)),
        "w" | "h" => Some((1, 8192)),
        "quality" => Some((1, 100)),
        "pngCompression" => Some((0, 9)),
        "audioBitrate" | "videoBitrate" | "maxrate" | "bufsize" => Some((0, 2_000_000)),
        "audioSampleRate" => Some((8_000, 384_000)),
        "audioChannels" => Some((1, 32)),
        "style" => Some((0, 2)),
        "minSizeMb" | "targetFileSizeMb" => Some((0, 10_000_000)),
        _ => None,
    }
}

fn validate_integer_range(field: &str, value: i64) -> Result<(), String> {
    if integer_range(field).map_or(true, |(minimum, maximum)| {
        (minimum..=maximum).contains(&value)
    }) {
        Ok(())
    } else {
        Err(format!("字段 {field} 超出允许范围"))
    }
}

fn number_range(field: &str) -> Option<(f64, f64)> {
    match field {
        "crf" => Some((0.0, 63.0)),
        "unsharp" => Some((0.0, 1.5)),
        "denoise" => Some((0.0, 10.0)),
        "deblock" => Some((0.0, 1.0)),
        "fps" => Some((0.0, 240.0)),
        "lnI" => Some((-70.0, -5.0)),
        "lnTp" => Some((-9.0, 0.0)),
        "lnLra" => Some((1.0, 50.0)),
        "cpTh" => Some((-80.0, 0.0)),
        "cpGain" => Some((-20.0, 40.0)),
        "fpsTol" => Some((0.0, 10.0)),
        "fixedVal" => Some((0.1, 9999.0)),
        "trigger.settleSeconds" => Some((1.0, 30.0)),
        _ => None,
    }
}

fn validate_number_range(field: &str, value: f64) -> Result<(), String> {
    if number_range(field).map_or(true, |(minimum, maximum)| {
        (minimum..=maximum).contains(&value)
    }) {
        Ok(())
    } else {
        Err(format!("字段 {field} 超出允许范围"))
    }
}

fn allowed_values(field: &str) -> Option<&'static [&'static str]> {
    match field {
        "container" => Some(&CONTAINERS),
        "outputKind" => Some(&["video", "audio"]),
        "videoCodec" => Some(&VIDEO_CODECS),
        "audioCodec" => Some(&AUDIO_CODECS),
        "rateMode" => Some(&["crf", "capped", "bitrate", "filesize"]),
        "scaleMode" => Some(&["original", "dimensions", "longEdge", "shortEdge"]),
        "outputMode" => Some(&["source", "rename", "subdir", "fixed", "fixedRename"]),
        "aspect" => Some(&["free", "1:1", "4:3", "16:9", "9:16", "match", "custom"]),
        "gifCompression" => Some(&["optimized", "compact", "aggressive"]),
        "imageFormat" => Some(&["jpg", "png", "webp", "tiff", "bmp"]),
        "operation" => Some(&["copy", "move"]),
        "destinationNameMode" | "renameMode" => Some(&["original", "template"]),
        "directoryStructure" => Some(&["preserve", "flatten"]),
        "conflictStrategy" => Some(&["rename", "subdirectory"]),
        "trigger.kind" => Some(&["manual", "removable"]),
        "trigger.volumeKind" => Some(&["removable", "any"]),
        _ => None,
    }
}

fn validate_enum(field: &str, value: &str) -> Result<(), String> {
    if allowed_values(field).is_some_and(|values| !values.contains(&value)) {
        return Err(format!("字段 {field} 的值不在允许列表中"));
    }
    Ok(())
}

fn field_definition(field: &str) -> Value {
    let mut definition = Map::new();
    if BOOLEAN_FIELDS.contains(&field) {
        definition.insert("type".into(), json!("boolean"));
        definition.insert("cliValues".into(), json!(["true", "false"]));
    } else if INTEGER_FIELDS.contains(&field) {
        definition.insert("type".into(), json!("integer"));
        if let Some((minimum, maximum)) = integer_range(field) {
            definition.insert("minimum".into(), json!(minimum));
            definition.insert("maximum".into(), json!(maximum));
        }
    } else if NUMBER_FIELDS.contains(&field) {
        definition.insert("type".into(), json!("number"));
        if let Some((minimum, maximum)) = number_range(field) {
            definition.insert("minimum".into(), json!(minimum));
            definition.insert("maximum".into(), json!(maximum));
        }
    } else {
        definition.insert("type".into(), json!("string"));
        definition.insert("maxLength".into(), json!(4096));
        if let Some(values) = allowed_values(field) {
            definition.insert("allowedValues".into(), json!(values));
        }
    }

    if matches!(
        field,
        "audioBitrate" | "videoBitrate" | "maxrate" | "bufsize"
    ) {
        definition.insert("unit".into(), json!("kbps"));
    } else if matches!(field, "scaleW" | "scaleH") {
        definition.insert("unit".into(), json!("px"));
    } else if field == "style" {
        definition.insert("deprecated".into(), json!(true));
        definition.insert("replacement".into(), json!("tune"));
    } else if field == "audioOnly" {
        definition.insert("deprecated".into(), json!(true));
        definition.insert("replacement".into(), json!("outputKind"));
    }

    Value::Object(definition)
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
        "screenshot" => [
            "aspect",
            "customRatio",
            "w",
            "h",
            "imageFormat",
            "quality",
            "pngCompression",
        ]
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
        "sequence" => [
            "aspect",
            "customRatio",
            "w",
            "h",
            "fps",
            "imageFormat",
            "quality",
            "pngCompression",
            "fullDuration",
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
    let field_definitions: Map<String, Value> = scalar_fields
        .iter()
        .map(|field| ((*field).to_string(), field_definition(field)))
        .collect();
    let list_fields: Vec<&str> = if preset_type == "backup" {
        vec!["destinations", "extensions"]
    } else {
        Vec::new()
    };
    Some(json!({
        "function": preset_type,
        "scalarFields": scalar_fields,
        "fieldDefinitions": field_definitions,
        "listFields": list_fields,
        "workflowNodeKinds": if preset_type == "workflow" {
            json!(["backup", "transcode", "mix", "check", "filter", "long_edge", "frame_rate", "list_index", "reverse_index", "count", "math", "compare", "boolean", "gate", "output"])
        } else {
            json!([])
        },
        "workflowNodeFields": if preset_type == "workflow" {
            json!(["presetId", "presetRevision", "filter.mediaKind", "filter.nameIncludes", "metric", "logic.value", "logic.mathOperator", "logic.compareOperator", "logic.booleanOperator", "output.mode", "output.directory", "output.writeLog", "position.x", "position.y"])
        } else {
            json!([])
        },
        "workflowEdgeFields": if preset_type == "workflow" {
            json!(["source", "sourcePort", "target", "targetPort"])
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

    #[test]
    fn workflow_schema_describes_graph_nodes_and_edges() {
        let schema = schema_show("workflow").unwrap();
        assert!(schema["workflowNodeKinds"]
            .as_array()
            .unwrap()
            .contains(&json!("transcode")));
        assert!(schema["workflowNodeFields"]
            .as_array()
            .unwrap()
            .contains(&json!("output.directory")));
        assert_eq!(
            schema["workflowEdgeFields"],
            json!(["source", "sourcePort", "target", "targetPort"])
        );
        assert!(schema.get("workflowStepFields").is_none());
    }

    #[test]
    fn encode_boolean_fields_accept_json_booleans() {
        for field in [
            "keepRes",
            "twoPass",
            "loudnorm",
            "audioOnly",
            "previewDuringEncode",
        ] {
            assert!(
                validate_scalar_field("encode", field, &json!(true)).is_ok(),
                "{field} should accept true"
            );
            assert!(
                validate_scalar_field("encode", field, &json!(false)).is_ok(),
                "{field} should accept false"
            );
            assert!(
                validate_scalar_field("encode", field, &json!(1)).is_err(),
                "{field} should reject numeric booleans"
            );
            assert!(
                validate_scalar_field("encode", field, &json!(0)).is_err(),
                "{field} should reject numeric booleans"
            );
        }
    }

    #[test]
    fn encode_schema_describes_cli_types_ranges_units_and_allowed_values() {
        let schema = schema_show("encode").unwrap();
        let fields = &schema["fieldDefinitions"];

        assert_eq!(fields["twoPass"]["type"], "boolean");
        assert_eq!(fields["twoPass"]["cliValues"], json!(["true", "false"]));
        assert_eq!(fields["videoBitrate"]["type"], "integer");
        assert_eq!(fields["videoBitrate"]["unit"], "kbps");
        assert_eq!(fields["scaleH"]["minimum"], 0);
        assert_eq!(fields["videoCodec"]["allowedValues"][1], "libx264");
        assert_eq!(
            fields["rateMode"]["allowedValues"],
            json!(["crf", "capped", "bitrate", "filesize"])
        );
        assert_eq!(
            fields["outputMode"]["allowedValues"],
            json!(["source", "rename", "subdir", "fixed", "fixedRename"])
        );
        assert_eq!(fields["style"]["maximum"], 2);
        assert_eq!(fields["style"]["deprecated"], true);
        assert_eq!(fields["style"]["replacement"], "tune");
        assert_eq!(
            fields["outputKind"]["allowedValues"],
            json!(["video", "audio"])
        );
        assert_eq!(fields["audioOnly"]["deprecated"], true);
        assert_eq!(fields["audioOnly"]["replacement"], "outputKind");
    }

    #[test]
    fn legacy_style_rejects_values_without_backend_meaning() {
        assert!(validate_scalar_field("encode", "style", &json!(0)).is_ok());
        assert!(validate_scalar_field("encode", "style", &json!(2)).is_ok());
        assert!(validate_scalar_field("encode", "style", &json!(3)).is_err());
    }

    #[test]
    fn encode_schema_accepts_capped_rate_scaling_audio_and_filter_fields() {
        assert!(validate_scalar_field("encode", "rateMode", &json!("capped")).is_ok());
        assert!(validate_scalar_field("encode", "outputKind", &json!("audio")).is_ok());
        assert!(validate_scalar_field("encode", "outputKind", &json!("podcast")).is_err());
        assert!(validate_scalar_field("encode", "container", &json!("flac")).is_ok());
        assert!(validate_scalar_field("encode", "scaleMode", &json!("longEdge")).is_ok());
        assert!(validate_scalar_field("encode", "scaleEdge", &json!(4096)).is_ok());
        assert!(validate_scalar_field("encode", "maxrate", &json!(80_000)).is_ok());
        assert!(validate_scalar_field("encode", "bufsize", &json!(160_000)).is_ok());
        assert!(validate_scalar_field("encode", "noAudio", &json!(true)).is_ok());
        assert!(validate_scalar_field("encode", "unsharp", &json!(0.8)).is_ok());
        assert!(validate_scalar_field("encode", "denoise", &json!(2.5)).is_ok());
        assert!(validate_scalar_field("encode", "deblock", &json!(0.2)).is_ok());
    }
}
