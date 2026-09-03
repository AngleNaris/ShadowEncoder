use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_MESSAGE_BYTES: usize = 1024 * 1024;
pub const AGENT_EVENT_NAME: &str = "shadowencoder://agent-state-changed";

pub mod error_code {
    pub const APP_NOT_RUNNING: &str = "APP_NOT_RUNNING";
    pub const PROTOCOL_MISMATCH: &str = "PROTOCOL_MISMATCH";
    pub const VALIDATION_ERROR: &str = "VALIDATION_ERROR";
    pub const REVISION_CONFLICT: &str = "REVISION_CONFLICT";
    pub const UNDO_CONFLICT: &str = "UNDO_CONFLICT";
    pub const HISTORY_EMPTY: &str = "HISTORY_EMPTY";
    pub const TASK_BUSY: &str = "TASK_BUSY";
    pub const DESTRUCTIVE_COMMAND_DENIED: &str = "DESTRUCTIVE_COMMAND_DENIED";
    pub const OUTPUT_CHANGED: &str = "OUTPUT_CHANGED";
    pub const PERMISSION_DENIED: &str = "PERMISSION_DENIED";
    pub const NOT_FOUND: &str = "NOT_FOUND";
    pub const INTERNAL_ERROR: &str = "INTERNAL_ERROR";
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Actor {
    Agent,
    Gui,
    System,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRequest {
    pub protocol_version: u32,
    pub request_id: String,
    pub actor: Actor,
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_revision: Option<i64>,
    pub command: AgentCommand,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum AgentCommand {
    #[serde(rename = "status")]
    Status,
    #[serde(rename = "snapshot")]
    Snapshot,
    #[serde(rename = "events.after")]
    EventsAfter { after: i64 },
    #[serde(rename = "schema.list")]
    SchemaList,
    #[serde(rename = "schema.show")]
    SchemaShow { function: String },

    #[serde(rename = "preset.list")]
    PresetList {
        #[serde(default, rename = "presetType")]
        preset_type: Option<String>,
    },
    #[serde(rename = "preset.show")]
    PresetShow { preset_id: String },
    #[serde(rename = "preset.create")]
    PresetCreate {
        #[serde(rename = "presetType")]
        preset_type: String,
        name: String,
    },
    #[serde(rename = "preset.rename")]
    PresetRename { preset_id: String, name: String },
    #[serde(rename = "preset.set_field")]
    PresetSetField {
        preset_id: String,
        field: String,
        value: Value,
    },
    #[serde(rename = "preset.item_add")]
    PresetItemAdd {
        preset_id: String,
        field: String,
        value: Value,
    },
    #[serde(rename = "preset.item_remove")]
    PresetItemRemove {
        preset_id: String,
        field: String,
        item_id: String,
    },
    #[serde(rename = "preset.delete")]
    PresetDelete { preset_id: String },
    #[serde(rename = "preset.gui_replace_type")]
    PresetGuiReplaceType {
        #[serde(rename = "presetType")]
        preset_type: String,
        presets: Vec<PresetSnapshot>,
    },
    #[serde(rename = "preset.migrate")]
    PresetMigrate {
        presets: BTreeMap<String, Vec<PresetSnapshot>>,
    },

    #[serde(rename = "source.list")]
    SourceList,
    #[serde(rename = "source.add")]
    SourceAdd { path: String },
    #[serde(rename = "source.remove")]
    SourceRemove { source_id: String },
    #[serde(rename = "source.select")]
    SourceSelect { source_id: String },
    #[serde(rename = "source.unselect")]
    SourceUnselect { source_id: String },
    #[serde(rename = "source.gui_replace")]
    SourceGuiReplace {
        paths: Vec<String>,
        selected_paths: Vec<String>,
        #[serde(default)]
        selected_source_paths: Vec<String>,
        #[serde(default)]
        active_path: Option<String>,
    },

    #[serde(rename = "workflow.node_add")]
    WorkflowNodeAdd { workflow_id: String, kind: String },
    #[serde(rename = "workflow.node_set")]
    WorkflowNodeSet {
        workflow_id: String,
        node_id: String,
        field: String,
        value: Value,
    },
    #[serde(rename = "workflow.node_remove")]
    WorkflowNodeRemove {
        workflow_id: String,
        node_id: String,
    },
    #[serde(rename = "workflow.edge_add")]
    WorkflowEdgeAdd {
        workflow_id: String,
        source: String,
        source_port: String,
        target: String,
        target_port: String,
    },
    #[serde(rename = "workflow.edge_remove")]
    WorkflowEdgeRemove {
        workflow_id: String,
        edge_id: String,
    },

    #[serde(rename = "task.list")]
    TaskList,
    #[serde(rename = "task.show")]
    TaskShow { task_id: String },
    #[serde(rename = "task.start")]
    TaskStart {
        function: String,
        preset_id: String,
        scope: String,
    },
    #[serde(rename = "task.cancel")]
    TaskCancel { task_id: String },
    #[serde(rename = "task.gui_update")]
    TaskGuiUpdate {
        task_id: String,
        status: String,
        #[serde(default)]
        progress: Option<f64>,
        #[serde(default)]
        detail: Option<String>,
        #[serde(default)]
        output_paths: Option<Vec<String>>,
        #[serde(default)]
        error: Option<String>,
    },

    #[serde(rename = "history.list")]
    HistoryList,
    #[serde(rename = "undo")]
    Undo,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PresetSnapshot {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub preset_type: String,
    #[serde(default)]
    pub params: Value,
    pub revision: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceSnapshot {
    pub id: String,
    pub path: String,
    pub selected: bool,
    pub revision: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskSnapshot {
    pub id: String,
    pub function: String,
    pub preset_id: String,
    #[serde(default)]
    pub preset_revision: i64,
    #[serde(default)]
    pub preset_snapshots: Vec<PresetSnapshot>,
    pub scope: String,
    #[serde(default)]
    pub input_paths: Vec<String>,
    pub status: String,
    pub progress: f64,
    pub detail: String,
    pub output_paths: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub revision: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationSnapshot {
    pub operation_id: String,
    pub sequence: i64,
    pub session_id: String,
    pub kind: String,
    pub target: String,
    pub summary: String,
    pub status: String,
    pub created_at_ms: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentEvent {
    pub sequence: i64,
    pub actor: Actor,
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    pub kind: String,
    pub target: String,
    pub summary: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentSnapshot {
    pub sequence: i64,
    pub preset_revision: i64,
    pub source_revision: i64,
    pub presets: BTreeMap<String, Vec<PresetSnapshot>>,
    pub sources: Vec<SourceSnapshot>,
    pub selected_paths: Vec<String>,
    #[serde(default)]
    pub selected_source_paths: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_path: Option<String>,
    pub tasks: Vec<TaskSnapshot>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MutationReceipt {
    pub operation_id: String,
    pub sequence: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entity_revision: Option<i64>,
    pub reversible: bool,
    pub summary: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentStateChanged {
    pub actor: Actor,
    pub receipt: MutationReceipt,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentError {
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentResponse {
    pub protocol_version: u32,
    pub request_id: String,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receipt: Option<MutationReceipt>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<AgentError>,
}

impl AgentResponse {
    pub fn success(request_id: impl Into<String>, result: Value) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            request_id: request_id.into(),
            ok: true,
            result: Some(result),
            receipt: None,
            error: None,
        }
    }

    pub fn mutation(
        request_id: impl Into<String>,
        result: Value,
        receipt: MutationReceipt,
    ) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            request_id: request_id.into(),
            ok: true,
            result: Some(result),
            receipt: Some(receipt),
            error: None,
        }
    }

    pub fn failure(
        request_id: impl Into<String>,
        code: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            request_id: request_id.into(),
            ok: false,
            result: None,
            receipt: None,
            error: Some(AgentError {
                code: code.into(),
                message: message.into(),
                details: None,
            }),
        }
    }

    pub fn sequence(&self) -> Option<i64> {
        self.receipt.as_ref().map(|receipt| receipt.sequence)
    }
}

pub fn local_endpoint_name() -> String {
    #[cfg(target_os = "windows")]
    {
        let identity = format!(
            "{}\\{}|{}",
            std::env::var("USERDOMAIN").unwrap_or_default(),
            std::env::var("USERNAME").unwrap_or_default(),
            std::env::var("LOCALAPPDATA").unwrap_or_default(),
        );
        return format!(
            r"\\.\pipe\shadowencoder-agent-{:016x}",
            stable_hash(identity.as_bytes())
        );
    }

    #[cfg(not(target_os = "windows"))]
    {
        let base = if cfg!(target_os = "macos") {
            std::env::var("HOME")
                .map(|home| format!("{home}/Library/Application Support"))
                .unwrap_or_else(|_| "/tmp".to_string())
        } else {
            std::env::var("XDG_DATA_HOME").unwrap_or_else(|_| {
                std::env::var("HOME")
                    .map(|home| format!("{home}/.local/share"))
                    .unwrap_or_else(|_| "/tmp".to_string())
            })
        };
        format!("{base}/com.shadowencoder.app/agent.sock")
    }
}

pub fn stable_hash(bytes: &[u8]) -> u64 {
    let mut value = 0xcbf29ce484222325_u64;
    for byte in bytes {
        value ^= u64::from(*byte);
        value = value.wrapping_mul(0x100000001b3);
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_round_trip_preserves_single_field_command() {
        let request = AgentRequest {
            protocol_version: PROTOCOL_VERSION,
            request_id: "request-1".into(),
            actor: Actor::Agent,
            session_id: "session-1".into(),
            expected_revision: Some(7),
            command: AgentCommand::PresetSetField {
                preset_id: "preset-1".into(),
                field: "crf".into(),
                value: Value::from(20),
            },
        };
        let json = serde_json::to_string(&request).unwrap();
        let decoded: AgentRequest = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded.expected_revision, Some(7));
        assert!(matches!(
            decoded.command,
            AgentCommand::PresetSetField { .. }
        ));
    }

    #[test]
    fn unknown_request_fields_are_rejected() {
        let json = r#"{
            "protocolVersion":1,
            "requestId":"r",
            "actor":"agent",
            "sessionId":"s",
            "command":{"type":"status"},
            "bulk":true
        }"#;
        assert!(serde_json::from_str::<AgentRequest>(json).is_err());
    }

    #[test]
    fn endpoint_hash_is_stable() {
        assert_eq!(stable_hash(b"shadowencoder"), stable_hash(b"shadowencoder"));
        assert_ne!(stable_hash(b"shadowencoder"), stable_hash(b"ShadowEncoder"));
    }
}
