use crate::schema as agent_schema;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use shadowencoder_agent_protocol::{
    error_code, stable_hash, Actor, AgentCommand, AgentEvent, AgentRequest, AgentResponse,
    AgentSnapshot, MutationReceipt, OperationSnapshot, PresetSnapshot, SourceSnapshot,
    TaskSnapshot, PROTOCOL_VERSION,
};
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

const STATE_ID: i64 = 1;
const MAX_AGENT_OPERATIONS: i64 = 20;
static ID_COUNTER: AtomicU64 = AtomicU64::new(1);

#[derive(Clone)]
pub struct AgentService {
    connection: Arc<Mutex<Connection>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredState {
    sequence: i64,
    preset_revision: i64,
    source_revision: i64,
    preset_migrated: bool,
    presets: BTreeMap<String, Vec<PresetSnapshot>>,
    sources: Vec<SourceSnapshot>,
    selected_paths: Vec<String>,
    #[serde(default)]
    selected_source_paths: Vec<String>,
    active_path: Option<String>,
    tasks: Vec<TaskSnapshot>,
    #[serde(default)]
    task_output_hashes: BTreeMap<String, BTreeMap<String, String>>,
}

impl Default for StoredState {
    fn default() -> Self {
        Self {
            sequence: 0,
            preset_revision: 0,
            source_revision: 0,
            preset_migrated: false,
            presets: agent_schema::PRESET_TYPES
                .iter()
                .map(|preset_type| ((*preset_type).to_string(), Vec::new()))
                .collect(),
            sources: Vec::new(),
            selected_paths: Vec::new(),
            selected_source_paths: Vec::new(),
            active_path: None,
            tasks: Vec::new(),
            task_output_hashes: BTreeMap::new(),
        }
    }
}

impl StoredState {
    fn snapshot(&self) -> AgentSnapshot {
        AgentSnapshot {
            sequence: self.sequence,
            preset_revision: self.preset_revision,
            source_revision: self.source_revision,
            presets: self.presets.clone(),
            sources: self.sources.clone(),
            selected_paths: self.selected_paths.clone(),
            selected_source_paths: self.selected_source_paths.clone(),
            active_path: self.active_path.clone(),
            tasks: self.tasks.clone(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum UndoPayload {
    PresetCreate {
        preset: PresetSnapshot,
    },
    PresetDelete {
        preset: PresetSnapshot,
        index: usize,
    },
    PresetRename {
        preset_id: String,
        before: String,
        after: String,
    },
    PresetField {
        preset_id: String,
        field: String,
        before_exists: bool,
        before: Value,
        after: Value,
    },
    PresetItemAdd {
        preset_id: String,
        field: String,
        item_id: String,
        value: Value,
    },
    PresetItemRemove {
        preset_id: String,
        field: String,
        item_id: String,
        value: Value,
        index: usize,
    },
    Workflow {
        preset_id: String,
        before: Value,
        after: Value,
    },
    SourceAdd {
        source: SourceSnapshot,
    },
    SourceRemove {
        source: SourceSnapshot,
        index: usize,
        selected_paths: Vec<String>,
        #[serde(default)]
        selected_source_paths: Vec<String>,
    },
    SourceSelect {
        source_id: String,
        before: bool,
        after: bool,
    },
    TaskStart {
        task_id: String,
    },
}

struct MutationDraft {
    result: Value,
    kind: String,
    target: String,
    summary: String,
    entity_revision: Option<i64>,
    undo: Option<UndoPayload>,
}

enum DispatchOutcome {
    Read(Value),
    Mutation(MutationDraft),
}

#[derive(Debug)]
struct ServiceFailure {
    code: &'static str,
    message: String,
}

impl ServiceFailure {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    fn validation(message: impl Into<String>) -> Self {
        Self::new(error_code::VALIDATION_ERROR, message)
    }
}

impl From<rusqlite::Error> for ServiceFailure {
    fn from(error: rusqlite::Error) -> Self {
        Self::new(
            error_code::INTERNAL_ERROR,
            format!("状态数据库错误: {error}"),
        )
    }
}

impl From<serde_json::Error> for ServiceFailure {
    fn from(error: serde_json::Error) -> Self {
        Self::new(
            error_code::INTERNAL_ERROR,
            format!("状态序列化错误: {error}"),
        )
    }
}

impl AgentService {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, String> {
        let path = path.as_ref();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                format!("无法创建 Agent 状态目录 {}: {error}", parent.display())
            })?;
        }
        let connection = Connection::open(path)
            .map_err(|error| format!("无法打开 Agent 状态数据库 {}: {error}", path.display()))?;
        connection
            .busy_timeout(std::time::Duration::from_secs(3))
            .map_err(|error| format!("无法配置 Agent 状态数据库: {error}"))?;
        connection
            .execute_batch(
                "PRAGMA journal_mode=WAL;
                 PRAGMA synchronous=NORMAL;
                 CREATE TABLE IF NOT EXISTS agent_state (
                   id INTEGER PRIMARY KEY CHECK (id = 1),
                   state_json TEXT NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS agent_requests (
                   request_id TEXT PRIMARY KEY,
                   request_json TEXT NOT NULL,
                   response_json TEXT NOT NULL,
                   created_at_ms INTEGER NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS agent_events (
                   sequence INTEGER PRIMARY KEY,
                   event_json TEXT NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS agent_operations (
                   operation_id TEXT PRIMARY KEY,
                   sequence INTEGER NOT NULL,
                   session_id TEXT NOT NULL,
                   kind TEXT NOT NULL,
                   target TEXT NOT NULL,
                   summary TEXT NOT NULL,
                   status TEXT NOT NULL,
                   undo_json TEXT NOT NULL,
                   created_at_ms INTEGER NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS idx_agent_operations_session_sequence
                   ON agent_operations(session_id, sequence DESC);",
            )
            .map_err(|error| format!("无法初始化 Agent 状态数据库: {error}"))?;

        let initial = serde_json::to_string(&StoredState::default())
            .map_err(|error| format!("无法创建 Agent 初始状态: {error}"))?;
        connection
            .execute(
                "INSERT OR IGNORE INTO agent_state(id, state_json) VALUES (?1, ?2)",
                params![STATE_ID, initial],
            )
            .map_err(|error| format!("无法写入 Agent 初始状态: {error}"))?;

        Ok(Self {
            connection: Arc::new(Mutex::new(connection)),
        })
    }

    pub fn handle(&self, request: AgentRequest) -> AgentResponse {
        if request.protocol_version != PROTOCOL_VERSION {
            return AgentResponse::failure(
                request.request_id,
                error_code::PROTOCOL_MISMATCH,
                format!(
                    "CLI 协议版本 {} 与应用协议版本 {} 不兼容",
                    request.protocol_version, PROTOCOL_VERSION
                ),
            );
        }
        if request.request_id.trim().is_empty() || request.request_id.len() > 128 {
            return AgentResponse::failure(
                request.request_id,
                error_code::VALIDATION_ERROR,
                "requestId 不能为空且不能超过 128 个字符",
            );
        }
        if request.session_id.trim().is_empty() || request.session_id.len() > 128 {
            return AgentResponse::failure(
                request.request_id,
                error_code::VALIDATION_ERROR,
                "sessionId 不能为空且不能超过 128 个字符",
            );
        }

        let mut connection = match self.connection.lock() {
            Ok(connection) => connection,
            Err(_) => {
                return AgentResponse::failure(
                    request.request_id,
                    error_code::INTERNAL_ERROR,
                    "Agent 状态锁已损坏",
                )
            }
        };
        let transaction = match connection.transaction() {
            Ok(transaction) => transaction,
            Err(error) => {
                return AgentResponse::failure(
                    request.request_id,
                    error_code::INTERNAL_ERROR,
                    format!("无法开始 Agent 状态事务: {error}"),
                )
            }
        };

        match handle_transaction(transaction, &request) {
            Ok(response) => response,
            Err(failure) => {
                AgentResponse::failure(request.request_id, failure.code, failure.message)
            }
        }
    }

    #[cfg(test)]
    fn open_in_memory() -> Self {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE agent_state (id INTEGER PRIMARY KEY, state_json TEXT NOT NULL);
                 CREATE TABLE agent_requests (request_id TEXT PRIMARY KEY, request_json TEXT NOT NULL, response_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL);
                 CREATE TABLE agent_events (sequence INTEGER PRIMARY KEY, event_json TEXT NOT NULL);
                 CREATE TABLE agent_operations (operation_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL, session_id TEXT NOT NULL, kind TEXT NOT NULL, target TEXT NOT NULL, summary TEXT NOT NULL, status TEXT NOT NULL, undo_json TEXT NOT NULL, created_at_ms INTEGER NOT NULL);",
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO agent_state(id, state_json) VALUES (1, ?1)",
                params![serde_json::to_string(&StoredState::default()).unwrap()],
            )
            .unwrap();
        Self {
            connection: Arc::new(Mutex::new(connection)),
        }
    }
}

fn handle_transaction(
    transaction: Transaction<'_>,
    request: &AgentRequest,
) -> Result<AgentResponse, ServiceFailure> {
    let request_json = serde_json::to_string(request)?;
    if let Some((cached_request, cached_response)) = transaction
        .query_row(
            "SELECT request_json, response_json FROM agent_requests WHERE request_id = ?1",
            params![request.request_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?
    {
        if cached_request != request_json {
            return Err(ServiceFailure::validation(
                "同一个 requestId 不能用于不同的请求",
            ));
        }
        let response = serde_json::from_str(&cached_response)?;
        transaction.commit()?;
        return Ok(response);
    }

    let mut state = load_state(&transaction)?;
    let outcome = dispatch(&transaction, &mut state, request)?;
    let response = match outcome {
        DispatchOutcome::Read(result) => AgentResponse::success(&request.request_id, result),
        DispatchOutcome::Mutation(draft) => {
            state.sequence += 1;
            let sequence = state.sequence;
            let event_operation_id = new_id("op");
            let reversible = request.actor == Actor::Agent && draft.undo.is_some();
            let event = AgentEvent {
                sequence,
                actor: request.actor.clone(),
                session_id: request.session_id.clone(),
                operation_id: Some(event_operation_id.clone()),
                kind: draft.kind.clone(),
                target: draft.target.clone(),
                summary: draft.summary.clone(),
            };
            transaction.execute(
                "INSERT INTO agent_events(sequence, event_json) VALUES (?1, ?2)",
                params![sequence, serde_json::to_string(&event)?],
            )?;

            if reversible {
                transaction.execute(
                    "INSERT INTO agent_operations(operation_id, sequence, session_id, kind, target, summary, status, undo_json, created_at_ms)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'applied', ?7, ?8)",
                    params![
                        event_operation_id,
                        sequence,
                        request.session_id,
                        draft.kind,
                        draft.target,
                        draft.summary,
                        serde_json::to_string(draft.undo.as_ref().expect("reversible operation has undo payload"))?,
                        now_ms(),
                    ],
                )?;
                transaction.execute(
                    "DELETE FROM agent_operations
                     WHERE operation_id IN (
                       SELECT operation_id FROM agent_operations
                       ORDER BY sequence DESC LIMIT -1 OFFSET ?1
                     )",
                    params![MAX_AGENT_OPERATIONS],
                )?;
            }

            save_state(&transaction, &state)?;
            let receipt = MutationReceipt {
                operation_id: event_operation_id,
                sequence,
                entity_revision: draft.entity_revision,
                reversible,
                summary: draft.summary,
            };
            AgentResponse::mutation(&request.request_id, draft.result, receipt)
        }
    };

    if response.receipt.is_some() {
        transaction.execute(
            "INSERT INTO agent_requests(request_id, request_json, response_json, created_at_ms)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                request.request_id,
                request_json,
                serde_json::to_string(&response)?,
                now_ms(),
            ],
        )?;
    }
    transaction.commit()?;
    Ok(response)
}

fn load_state(transaction: &Transaction<'_>) -> Result<StoredState, ServiceFailure> {
    let serialized: String = transaction.query_row(
        "SELECT state_json FROM agent_state WHERE id = ?1",
        params![STATE_ID],
        |row| row.get(0),
    )?;
    Ok(serde_json::from_str(&serialized)?)
}

fn save_state(transaction: &Transaction<'_>, state: &StoredState) -> Result<(), ServiceFailure> {
    transaction.execute(
        "UPDATE agent_state SET state_json = ?1 WHERE id = ?2",
        params![serde_json::to_string(state)?, STATE_ID],
    )?;
    Ok(())
}

fn dispatch(
    transaction: &Transaction<'_>,
    state: &mut StoredState,
    request: &AgentRequest,
) -> Result<DispatchOutcome, ServiceFailure> {
    match &request.command {
        AgentCommand::Status => Ok(DispatchOutcome::Read(json!({
            "appRunning": true,
            "protocolVersion": PROTOCOL_VERSION,
            "sequence": state.sequence,
            "presetRevision": state.preset_revision,
            "sourceRevision": state.source_revision,
            "reversibleOperations": count_applied_operations(transaction, &request.session_id)?,
        }))),
        AgentCommand::Snapshot => Ok(DispatchOutcome::Read(serde_json::to_value(
            state.snapshot(),
        )?)),
        AgentCommand::EventsAfter { after } => {
            let mut statement = transaction.prepare(
                "SELECT event_json FROM agent_events WHERE sequence > ?1 ORDER BY sequence LIMIT 200",
            )?;
            let events = statement
                .query_map(params![after], |row| row.get::<_, String>(0))?
                .map(|row| {
                    let serialized = row?;
                    serde_json::from_str::<AgentEvent>(&serialized).map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            serialized.len(),
                            rusqlite::types::Type::Text,
                            Box::new(error),
                        )
                    })
                })
                .collect::<Result<Vec<_>, _>>()?;
            Ok(DispatchOutcome::Read(json!(events)))
        }
        AgentCommand::SchemaList => Ok(DispatchOutcome::Read(agent_schema::schema_list())),
        AgentCommand::WorkflowValidate { workflow_id } => {
            let (kind, preset) = find_preset(state, workflow_id)?;
            if kind != "workflow" { return Err(ServiceFailure::validation("目标预设不是流程")); }
            validate_workflow_graph_structure(&preset.params, true)?;
            Ok(DispatchOutcome::Read(json!({ "valid": true, "revision": preset.revision, "scope": "graph", "scriptExecutionChecked": false })))
        }
        AgentCommand::SchemaShow { function } => agent_schema::schema_show(function)
            .map(DispatchOutcome::Read)
            .ok_or_else(|| {
                ServiceFailure::new(
                    error_code::NOT_FOUND,
                    format!("不存在功能 schema: {function}"),
                )
            }),
        AgentCommand::PresetList { preset_type } => {
            if let Some(preset_type) = preset_type {
                ensure_preset_type(preset_type)?;
                Ok(DispatchOutcome::Read(json!(state
                    .presets
                    .get(preset_type)
                    .cloned()
                    .unwrap_or_default())))
            } else {
                Ok(DispatchOutcome::Read(json!(state.presets)))
            }
        }
        AgentCommand::PresetShow { preset_id } => Ok(DispatchOutcome::Read(preset_detail(
            find_preset(state, preset_id)?.1,
        ))),
        AgentCommand::PresetCreate { preset_type, name } => {
            create_preset(state, request, preset_type, name)
        }
        AgentCommand::PresetRename { preset_id, name } => {
            rename_preset(state, request, preset_id, name)
        }
        AgentCommand::PresetSetField {
            preset_id,
            field,
            value,
        } => set_preset_field(state, request, preset_id, field, value.clone()),
        AgentCommand::PresetItemAdd {
            preset_id,
            field,
            value,
        } => add_preset_item(state, request, preset_id, field, value.clone()),
        AgentCommand::PresetItemRemove {
            preset_id,
            field,
            item_id,
        } => remove_preset_item(state, request, preset_id, field, item_id),
        AgentCommand::PresetDelete { preset_id } => delete_preset(state, request, preset_id),
        AgentCommand::PresetGuiReplaceType {
            preset_type,
            presets,
        } => replace_preset_type(state, request, preset_type, presets),
        AgentCommand::PresetMigrate { presets } => migrate_presets(state, request, presets),
        AgentCommand::SourceList => Ok(DispatchOutcome::Read(json!({
            "revision": state.source_revision,
            "sources": state.sources,
            "selectedPaths": state.selected_paths,
            "selectedSourcePaths": state.selected_source_paths,
            "activePath": state.active_path,
        }))),
        AgentCommand::SourceAdd { path } => add_source(state, request, path),
        AgentCommand::SourceRemove { source_id } => remove_source(state, request, source_id),
        AgentCommand::SourceSelect { source_id } => {
            set_source_selected(state, request, source_id, true)
        }
        AgentCommand::SourceUnselect { source_id } => {
            set_source_selected(state, request, source_id, false)
        }
        AgentCommand::SourceGuiReplace {
            paths,
            selected_paths,
            selected_source_paths,
            active_path,
        } => replace_sources(
            state,
            request,
            paths,
            selected_paths,
            selected_source_paths,
            active_path.clone(),
        ),
        AgentCommand::WorkflowNodeAdd { workflow_id, kind } => {
            workflow_node_add(state, request, workflow_id, kind)
        }
        AgentCommand::WorkflowNodeSet {
            workflow_id,
            node_id,
            field,
            value,
        } => workflow_node_set(state, request, workflow_id, node_id, field, value.clone()),
        AgentCommand::WorkflowNodeRemove {
            workflow_id,
            node_id,
        } => workflow_node_remove(state, request, workflow_id, node_id),
        AgentCommand::WorkflowEdgeAdd {
            workflow_id,
            source,
            source_port,
            target,
            target_port,
        } => workflow_edge_add(
            state,
            request,
            workflow_id,
            source,
            source_port,
            target,
            target_port,
        ),
        AgentCommand::WorkflowEdgeRemove {
            workflow_id,
            edge_id,
        } => workflow_edge_remove(state, request, workflow_id, edge_id),
        AgentCommand::TaskList => Ok(DispatchOutcome::Read(json!(state.tasks))),
        AgentCommand::TaskShow { task_id } => {
            Ok(DispatchOutcome::Read(json!(find_task(state, task_id)?)))
        }
        AgentCommand::TaskStart {
            function,
            preset_id,
            scope,
        } => start_task(state, request, function, preset_id, scope),
        AgentCommand::TaskCancel { task_id } => cancel_task(state, request, task_id),
        AgentCommand::TaskGuiUpdate {
            task_id,
            status,
            progress,
            detail,
            output_paths,
            error,
        } => update_task(
            state,
            request,
            task_id,
            status,
            *progress,
            detail.clone(),
            output_paths.clone(),
            error.clone(),
        ),
        AgentCommand::HistoryList => Ok(DispatchOutcome::Read(json!(list_operations(
            transaction,
            &request.session_id
        )?))),
        AgentCommand::Undo => undo_latest(transaction, state, request),
    }
}

fn count_applied_operations(
    transaction: &Transaction<'_>,
    session_id: &str,
) -> Result<i64, ServiceFailure> {
    Ok(transaction.query_row(
        "SELECT COUNT(*) FROM agent_operations WHERE session_id = ?1 AND status = 'applied'",
        params![session_id],
        |row| row.get(0),
    )?)
}

fn list_operations(
    transaction: &Transaction<'_>,
    session_id: &str,
) -> Result<Vec<OperationSnapshot>, ServiceFailure> {
    let mut statement = transaction.prepare(
        "SELECT operation_id, sequence, session_id, kind, target, summary, status, created_at_ms
         FROM agent_operations WHERE session_id = ?1 ORDER BY sequence DESC LIMIT 20",
    )?;
    let operations = statement
        .query_map(params![session_id], |row| {
            Ok(OperationSnapshot {
                operation_id: row.get(0)?,
                sequence: row.get(1)?,
                session_id: row.get(2)?,
                kind: row.get(3)?,
                target: row.get(4)?,
                summary: row.get(5)?,
                status: row.get(6)?,
                created_at_ms: row.get(7)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(operations)
}

fn ensure_actor(request: &AgentRequest, allowed: &[Actor]) -> Result<(), ServiceFailure> {
    if allowed.contains(&request.actor) {
        Ok(())
    } else {
        Err(ServiceFailure::new(
            error_code::PERMISSION_DENIED,
            "该命令不允许当前操作来源调用",
        ))
    }
}

fn ensure_preset_type(preset_type: &str) -> Result<(), ServiceFailure> {
    if agent_schema::is_preset_type(preset_type) {
        Ok(())
    } else {
        Err(ServiceFailure::validation(format!(
            "未知预设类型: {preset_type}"
        )))
    }
}

fn ensure_revision(expected: Option<i64>, actual: i64) -> Result<(), ServiceFailure> {
    match expected {
        Some(expected) if expected == actual => Ok(()),
        Some(expected) => Err(ServiceFailure::new(
            error_code::REVISION_CONFLICT,
            format!("revision 已变化：期望 {expected}，当前 {actual}"),
        )),
        None => Err(ServiceFailure::validation(
            "该写操作必须通过 --revision 提供当前 revision",
        )),
    }
}

fn find_preset<'a>(
    state: &'a StoredState,
    preset_id: &str,
) -> Result<(&'a str, &'a PresetSnapshot), ServiceFailure> {
    for (preset_type, presets) in &state.presets {
        if let Some(preset) = presets.iter().find(|preset| preset.id == preset_id) {
            return Ok((preset_type, preset));
        }
    }
    Err(ServiceFailure::new(
        error_code::NOT_FOUND,
        format!("不存在预设: {preset_id}"),
    ))
}

fn preset_detail(preset: &PresetSnapshot) -> Value {
    let mut detail = serde_json::to_value(preset).unwrap_or_else(|_| json!({}));
    let mut list_items = Map::new();
    if let Some(params) = preset.params.as_object() {
        for (field, value) in params {
            if !agent_schema::is_list_field(&preset.preset_type, field) {
                continue;
            }
            let items = value
                .as_array()
                .map(|values| {
                    values
                        .iter()
                        .map(|value| {
                            json!({
                                "itemId": list_item_id(field, value),
                                "value": value,
                            })
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            list_items.insert(field.clone(), Value::Array(items));
        }
    }
    if let Some(object) = detail.as_object_mut() {
        object.insert("listItems".into(), Value::Object(list_items));
    }
    detail
}

fn find_preset_location(
    state: &StoredState,
    preset_id: &str,
) -> Result<(String, usize), ServiceFailure> {
    for (preset_type, presets) in &state.presets {
        if let Some(index) = presets.iter().position(|preset| preset.id == preset_id) {
            return Ok((preset_type.clone(), index));
        }
    }
    Err(ServiceFailure::new(
        error_code::NOT_FOUND,
        format!("不存在预设: {preset_id}"),
    ))
}

fn find_task<'a>(
    state: &'a StoredState,
    task_id: &str,
) -> Result<&'a TaskSnapshot, ServiceFailure> {
    state
        .tasks
        .iter()
        .find(|task| task.id == task_id)
        .ok_or_else(|| ServiceFailure::new(error_code::NOT_FOUND, format!("不存在任务: {task_id}")))
}

fn create_preset(
    state: &mut StoredState,
    request: &AgentRequest,
    preset_type: &str,
    name: &str,
) -> Result<DispatchOutcome, ServiceFailure> {
    ensure_actor(request, &[Actor::Agent])?;
    ensure_preset_type(preset_type)?;
    agent_schema::validate_name(name).map_err(ServiceFailure::validation)?;
    let preset = PresetSnapshot {
        id: new_id("preset"),
        name: name.trim().to_string(),
        preset_type: preset_type.to_string(),
        params: default_preset_params(preset_type),
        revision: 1,
    };
    state
        .presets
        .entry(preset_type.to_string())
        .or_default()
        .push(preset.clone());
    state.preset_revision += 1;
    Ok(DispatchOutcome::Mutation(MutationDraft {
        result: json!(preset),
        kind: "preset.create".into(),
        target: format!("preset/{}", preset.id),
        summary: format!("创建{}预设“{}”", preset_type, preset.name),
        entity_revision: Some(preset.revision),
        undo: Some(UndoPayload::PresetCreate { preset }),
    }))
}

fn rename_preset(
    state: &mut StoredState,
    request: &AgentRequest,
    preset_id: &str,
    name: &str,
) -> Result<DispatchOutcome, ServiceFailure> {
    ensure_actor(request, &[Actor::Agent])?;
    agent_schema::validate_name(name).map_err(ServiceFailure::validation)?;
    let (preset_type, index) = find_preset_location(state, preset_id)?;
    let preset = &mut state.presets.get_mut(&preset_type).unwrap()[index];
    ensure_revision(request.expected_revision, preset.revision)?;
    let before = preset.name.clone();
    let after = name.trim().to_string();
    if before == after {
        return Err(ServiceFailure::validation("新名称与当前名称相同"));
    }
    preset.name = after.clone();
    preset.revision += 1;
    let revision = preset.revision;
    let result = json!(preset.clone());
    state.preset_revision += 1;
    Ok(DispatchOutcome::Mutation(MutationDraft {
        result,
        kind: "preset.rename".into(),
        target: format!("preset/{preset_id}/name"),
        summary: format!("重命名预设：{before} -> {after}"),
        entity_revision: Some(revision),
        undo: Some(UndoPayload::PresetRename {
            preset_id: preset_id.to_string(),
            before,
            after,
        }),
    }))
}

fn set_preset_field(
    state: &mut StoredState,
    request: &AgentRequest,
    preset_id: &str,
    field: &str,
    value: Value,
) -> Result<DispatchOutcome, ServiceFailure> {
    ensure_actor(request, &[Actor::Agent])?;
    let (preset_type, index) = find_preset_location(state, preset_id)?;
    agent_schema::validate_scalar_field(&preset_type, field, &value)
        .map_err(ServiceFailure::validation)?;
    if preset_type == "backup" && field == "operation" && value == Value::String("move".into()) {
        return Err(ServiceFailure::new(
            error_code::DESTRUCTIVE_COMMAND_DENIED,
            "Agent CLI 不允许把备份操作改为移动",
        ));
    }

    let preset = &mut state.presets.get_mut(&preset_type).unwrap()[index];
    ensure_revision(request.expected_revision, preset.revision)?;
    let (before_exists, before) = get_json_path(&preset.params, field)
        .map(|value| (true, value.clone()))
        .unwrap_or((false, Value::Null));
    if before_exists && before == value {
        return Err(ServiceFailure::validation("新值与当前字段值相同"));
    }
    set_json_path(&mut preset.params, field, value.clone())?;
    preset.revision += 1;
    let revision = preset.revision;
    let result = json!(preset.clone());
    state.preset_revision += 1;
    Ok(DispatchOutcome::Mutation(MutationDraft {
        result,
        kind: "preset.set_field".into(),
        target: format!("preset/{preset_id}/{field}"),
        summary: format!(
            "修改预设字段 {field}: {} -> {}",
            display_value(&before),
            display_value(&value)
        ),
        entity_revision: Some(revision),
        undo: Some(UndoPayload::PresetField {
            preset_id: preset_id.to_string(),
            field: field.to_string(),
            before_exists,
            before,
            after: value,
        }),
    }))
}

fn add_preset_item(
    state: &mut StoredState,
    request: &AgentRequest,
    preset_id: &str,
    field: &str,
    value: Value,
) -> Result<DispatchOutcome, ServiceFailure> {
    ensure_actor(request, &[Actor::Agent])?;
    let (preset_type, index) = find_preset_location(state, preset_id)?;
    agent_schema::validate_list_item(&preset_type, field, &value)
        .map_err(ServiceFailure::validation)?;
    let preset = &mut state.presets.get_mut(&preset_type).unwrap()[index];
    ensure_revision(request.expected_revision, preset.revision)?;
    let object = preset
        .params
        .as_object_mut()
        .ok_or_else(|| ServiceFailure::validation("预设参数不是对象"))?;
    let items = object
        .entry(field.to_string())
        .or_insert_with(|| Value::Array(Vec::new()))
        .as_array_mut()
        .ok_or_else(|| ServiceFailure::validation(format!("字段 {field} 不是数组")))?;
    if items.contains(&value) {
        return Err(ServiceFailure::validation(format!(
            "字段 {field} 已包含该列表项"
        )));
    }
    let item_id = list_item_id(field, &value);
    items.push(value.clone());
    preset.revision += 1;
    let revision = preset.revision;
    let result = json!({
        "preset": preset.clone(),
        "itemId": item_id,
        "value": value,
    });
    state.preset_revision += 1;
    Ok(DispatchOutcome::Mutation(MutationDraft {
        result,
        kind: "preset.item_add".into(),
        target: format!("preset/{preset_id}/{field}/{item_id}"),
        summary: format!("向预设字段 {field} 添加一项"),
        entity_revision: Some(revision),
        undo: Some(UndoPayload::PresetItemAdd {
            preset_id: preset_id.to_string(),
            field: field.to_string(),
            item_id,
            value,
        }),
    }))
}

fn remove_preset_item(
    state: &mut StoredState,
    request: &AgentRequest,
    preset_id: &str,
    field: &str,
    item_id: &str,
) -> Result<DispatchOutcome, ServiceFailure> {
    ensure_actor(request, &[Actor::Agent])?;
    let (preset_type, index) = find_preset_location(state, preset_id)?;
    if !agent_schema::is_list_field(&preset_type, field) {
        return Err(ServiceFailure::validation(format!(
            "字段 {field} 不是可逐项编辑的列表"
        )));
    }
    let preset = &mut state.presets.get_mut(&preset_type).unwrap()[index];
    ensure_revision(request.expected_revision, preset.revision)?;
    let items = get_json_path_mut(&mut preset.params, field)
        .and_then(Value::as_array_mut)
        .ok_or_else(|| ServiceFailure::validation(format!("字段 {field} 不是数组")))?;
    let item_index = items
        .iter()
        .position(|value| list_item_id(field, value) == item_id)
        .ok_or_else(|| {
            ServiceFailure::new(error_code::NOT_FOUND, format!("不存在列表项: {item_id}"))
        })?;
    let value = items.remove(item_index);
    preset.revision += 1;
    let revision = preset.revision;
    let result = json!({
        "preset": preset.clone(),
        "removedItemId": item_id,
    });
    state.preset_revision += 1;
    Ok(DispatchOutcome::Mutation(MutationDraft {
        result,
        kind: "preset.item_remove".into(),
        target: format!("preset/{preset_id}/{field}/{item_id}"),
        summary: format!("从预设字段 {field} 移除一项"),
        entity_revision: Some(revision),
        undo: Some(UndoPayload::PresetItemRemove {
            preset_id: preset_id.to_string(),
            field: field.to_string(),
            item_id: item_id.to_string(),
            value,
            index: item_index,
        }),
    }))
}

fn delete_preset(
    state: &mut StoredState,
    request: &AgentRequest,
    preset_id: &str,
) -> Result<DispatchOutcome, ServiceFailure> {
    ensure_actor(request, &[Actor::Agent])?;
    let (preset_type, index) = find_preset_location(state, preset_id)?;
    let current = &state.presets[&preset_type][index];
    ensure_revision(request.expected_revision, current.revision)?;
    let preset = state.presets.get_mut(&preset_type).unwrap().remove(index);
    state.preset_revision += 1;
    Ok(DispatchOutcome::Mutation(MutationDraft {
        result: json!({ "deletedPresetId": preset_id }),
        kind: "preset.delete".into(),
        target: format!("preset/{preset_id}"),
        summary: format!("删除预设“{}”", preset.name),
        entity_revision: None,
        undo: Some(UndoPayload::PresetDelete { preset, index }),
    }))
}

fn replace_preset_type(
    state: &mut StoredState,
    request: &AgentRequest,
    preset_type: &str,
    presets: &[PresetSnapshot],
) -> Result<DispatchOutcome, ServiceFailure> {
    ensure_actor(request, &[Actor::Gui])?;
    ensure_preset_type(preset_type)?;
    ensure_revision(request.expected_revision, state.preset_revision)?;
    validate_gui_presets(state, preset_type, presets)?;
    state
        .presets
        .insert(preset_type.to_string(), presets.to_vec());
    state.preset_revision += 1;
    Ok(DispatchOutcome::Mutation(MutationDraft {
        result: serde_json::to_value(state.snapshot())?,
        kind: "preset.gui_replace_type".into(),
        target: format!("preset-type/{preset_type}"),
        summary: format!("用户更新 {preset_type} 预设列表"),
        entity_revision: Some(state.preset_revision),
        undo: None,
    }))
}

fn migrate_presets(
    state: &mut StoredState,
    request: &AgentRequest,
    presets: &BTreeMap<String, Vec<PresetSnapshot>>,
) -> Result<DispatchOutcome, ServiceFailure> {
    ensure_actor(request, &[Actor::Gui])?;
    if state.preset_migrated {
        return Ok(DispatchOutcome::Read(serde_json::to_value(
            state.snapshot(),
        )?));
    }
    let mut next = StoredState::default().presets;
    let mut ids = HashSet::new();
    for preset_type in agent_schema::PRESET_TYPES {
        for mut preset in presets.get(preset_type).cloned().unwrap_or_default() {
            if preset.preset_type != preset_type {
                return Err(ServiceFailure::validation(format!(
                    "预设 {} 的类型与所在列表不一致",
                    preset.id
                )));
            }
            agent_schema::validate_name(&preset.name).map_err(ServiceFailure::validation)?;
            if !preset.params.is_object() || !ids.insert(preset.id.clone()) {
                return Err(ServiceFailure::validation(format!(
                    "迁移预设 {} 的参数或 ID 无效",
                    preset.id
                )));
            }
            preset.revision = preset.revision.max(1);
            next.get_mut(preset_type).unwrap().push(preset);
        }
    }
    state.presets = next;
    state.preset_migrated = true;
    state.preset_revision += 1;
    Ok(DispatchOutcome::Mutation(MutationDraft {
        result: serde_json::to_value(state.snapshot())?,
        kind: "preset.migrate".into(),
        target: "preset-store".into(),
        summary: "完成本地预设一次性迁移".into(),
        entity_revision: Some(state.preset_revision),
        undo: None,
    }))
}

fn validate_gui_presets(
    state: &StoredState,
    preset_type: &str,
    presets: &[PresetSnapshot],
) -> Result<(), ServiceFailure> {
    let other_ids: HashSet<&str> = state
        .presets
        .iter()
        .filter(|(current_type, _)| current_type.as_str() != preset_type)
        .flat_map(|(_, list)| list.iter().map(|preset| preset.id.as_str()))
        .collect();
    let mut ids = HashSet::new();
    for preset in presets {
        if preset.preset_type != preset_type || !preset.params.is_object() {
            return Err(ServiceFailure::validation(format!(
                "预设 {} 的类型或参数无效",
                preset.id
            )));
        }
        agent_schema::validate_name(&preset.name).map_err(ServiceFailure::validation)?;
        if preset.id.trim().is_empty()
            || preset.revision < 1
            || !ids.insert(preset.id.as_str())
            || other_ids.contains(preset.id.as_str())
        {
            return Err(ServiceFailure::validation(format!(
                "预设 ID 重复或无效: {}",
                preset.id
            )));
        }
    }
    Ok(())
}

fn default_preset_params(preset_type: &str) -> Value {
    match preset_type {
        "backup" => json!({ "destinations": [], "extensions": [] }),
        "workflow" => json!({
            "trigger": {
                "kind": "manual",
                "volumeKind": "removable",
                "labelContains": "",
                "settleSeconds": 3
            },
            "graph": {
                "startPosition": { "x": 0, "y": 68 },
                "nodes": [],
                "edges": []
            }
        }),
        _ => json!({}),
    }
}

fn add_source(
    state: &mut StoredState,
    request: &AgentRequest,
    path: &str,
) -> Result<DispatchOutcome, ServiceFailure> {
    ensure_actor(request, &[Actor::Agent])?;
    let path = validate_source_path(path, true)?;
    if state
        .sources
        .iter()
        .any(|source| same_path(&source.path, &path))
    {
        return Err(ServiceFailure::validation("该素材已在列表中"));
    }
    let source = SourceSnapshot {
        id: source_id(&path),
        path,
        selected: false,
        revision: 1,
    };
    state.sources.push(source.clone());
    state.source_revision += 1;
    Ok(DispatchOutcome::Mutation(MutationDraft {
        result: json!(source),
        kind: "source.add".into(),
        target: format!("source/{}", source.id),
        summary: format!("添加素材 {}", source.path),
        entity_revision: Some(source.revision),
        undo: Some(UndoPayload::SourceAdd { source }),
    }))
}

fn remove_source(
    state: &mut StoredState,
    request: &AgentRequest,
    source_id: &str,
) -> Result<DispatchOutcome, ServiceFailure> {
    ensure_actor(request, &[Actor::Agent])?;
    let index = state
        .sources
        .iter()
        .position(|source| source.id == source_id)
        .ok_or_else(|| {
            ServiceFailure::new(error_code::NOT_FOUND, format!("不存在素材: {source_id}"))
        })?;
    ensure_revision(request.expected_revision, state.sources[index].revision)?;
    let source = state.sources.remove(index);
    let selected_paths: Vec<String> = state
        .selected_paths
        .iter()
        .filter(|selected| path_belongs_to(selected, &source.path))
        .cloned()
        .collect();
    let selected_source_paths: Vec<String> = state
        .selected_source_paths
        .iter()
        .filter(|selected| path_belongs_to(selected, &source.path))
        .cloned()
        .collect();
    state
        .selected_paths
        .retain(|selected| !path_belongs_to(selected, &source.path));
    state
        .selected_source_paths
        .retain(|selected| !path_belongs_to(selected, &source.path));
    if state
        .active_path
        .as_deref()
        .is_some_and(|active| path_belongs_to(active, &source.path))
    {
        state.active_path = None;
    }
    state.source_revision += 1;
    Ok(DispatchOutcome::Mutation(MutationDraft {
        result: json!({ "removedSourceId": source_id }),
        kind: "source.remove".into(),
        target: format!("source/{source_id}"),
        summary: format!("移除素材 {}", source.path),
        entity_revision: None,
        undo: Some(UndoPayload::SourceRemove {
            source,
            index,
            selected_paths,
            selected_source_paths,
        }),
    }))
}

fn set_source_selected(
    state: &mut StoredState,
    request: &AgentRequest,
    source_id: &str,
    selected: bool,
) -> Result<DispatchOutcome, ServiceFailure> {
    ensure_actor(request, &[Actor::Agent])?;
    let index = state
        .sources
        .iter()
        .position(|source| source.id == source_id)
        .ok_or_else(|| {
            ServiceFailure::new(error_code::NOT_FOUND, format!("不存在素材: {source_id}"))
        })?;
    ensure_revision(request.expected_revision, state.sources[index].revision)?;
    let before = state.sources[index].selected;
    if before == selected {
        return Err(ServiceFailure::validation(if selected {
            "该素材已经勾选"
        } else {
            "该素材已经取消勾选"
        }));
    }
    let path = state.sources[index].path.clone();
    state.sources[index].selected = selected;
    state.sources[index].revision += 1;
    let revision = state.sources[index].revision;
    if selected {
        state.selected_paths.retain(|item| !same_path(item, &path));
        state.selected_paths.push(path.clone());
        state
            .selected_source_paths
            .retain(|item| !same_path(item, &path));
        state.selected_source_paths.push(path.clone());
    } else {
        state
            .selected_paths
            .retain(|item| !path_belongs_to(item, &path));
        state
            .selected_source_paths
            .retain(|item| !path_belongs_to(item, &path));
    }
    state.source_revision += 1;
    Ok(DispatchOutcome::Mutation(MutationDraft {
        result: json!(state.sources[index]),
        kind: if selected {
            "source.select".into()
        } else {
            "source.unselect".into()
        },
        target: format!("source/{source_id}/selected"),
        summary: if selected {
            format!("勾选素材 {path}")
        } else {
            format!("取消勾选素材 {path}")
        },
        entity_revision: Some(revision),
        undo: Some(UndoPayload::SourceSelect {
            source_id: source_id.to_string(),
            before,
            after: selected,
        }),
    }))
}

fn replace_sources(
    state: &mut StoredState,
    request: &AgentRequest,
    paths: &[String],
    selected_paths: &[String],
    selected_source_paths: &[String],
    active_path: Option<String>,
) -> Result<DispatchOutcome, ServiceFailure> {
    ensure_actor(request, &[Actor::Gui])?;
    ensure_revision(request.expected_revision, state.source_revision)?;
    let mut normalized_paths: Vec<String> = Vec::new();
    for path in paths {
        let path = validate_source_path(path, false)?;
        if !normalized_paths.iter().any(|item| same_path(item, &path)) {
            normalized_paths.push(path);
        }
    }
    let mut normalized_selected: Vec<String> = Vec::new();
    for path in selected_paths {
        let path = validate_source_path(path, false)?;
        if !normalized_paths
            .iter()
            .any(|root| path_belongs_to(&path, root))
        {
            return Err(ServiceFailure::validation(format!(
                "勾选项不属于素材列表: {path}"
            )));
        }
        if !normalized_selected
            .iter()
            .any(|item| same_path(item, &path))
        {
            normalized_selected.push(path);
        }
    }
    let mut normalized_selected_sources: Vec<String> = Vec::new();
    for path in selected_source_paths {
        let path = validate_source_path(path, false)?;
        if !normalized_paths
            .iter()
            .any(|root| path_belongs_to(&path, root))
        {
            return Err(ServiceFailure::validation(format!(
                "DIT 勾选项不属于素材列表: {path}"
            )));
        }
        if !normalized_selected_sources
            .iter()
            .any(|item| same_path(item, &path))
        {
            normalized_selected_sources.push(path);
        }
    }
    if normalized_selected_sources.is_empty() && !normalized_selected.is_empty() {
        normalized_selected_sources = normalized_selected.clone();
    }
    let active_path = active_path
        .map(|path| validate_source_path(&path, false))
        .transpose()?;
    if active_path.as_deref().is_some_and(|path| {
        !normalized_paths
            .iter()
            .any(|root| path_belongs_to(path, root))
    }) {
        return Err(ServiceFailure::validation("当前预览素材不属于素材列表"));
    }

    let next_sources = normalized_paths
        .iter()
        .map(|path| {
            let selected = normalized_selected.iter().any(|item| same_path(item, path));
            if let Some(current) = state
                .sources
                .iter()
                .find(|source| same_path(&source.path, path))
            {
                SourceSnapshot {
                    id: current.id.clone(),
                    path: path.clone(),
                    selected,
                    revision: if current.selected == selected {
                        current.revision
                    } else {
                        current.revision + 1
                    },
                }
            } else {
                SourceSnapshot {
                    id: source_id(path),
                    path: path.clone(),
                    selected,
                    revision: 1,
                }
            }
        })
        .collect::<Vec<_>>();

    state.sources = next_sources;
    state.selected_paths = normalized_selected;
    state.selected_source_paths = normalized_selected_sources;
    state.active_path = active_path;
    state.source_revision += 1;
    Ok(DispatchOutcome::Mutation(MutationDraft {
        result: serde_json::to_value(state.snapshot())?,
        kind: "source.gui_replace".into(),
        target: "source-store".into(),
        summary: "用户更新素材列表".into(),
        entity_revision: Some(state.source_revision),
        undo: None,
    }))
}

fn validate_source_path(path: &str, require_exists: bool) -> Result<String, ServiceFailure> {
    let path = path.trim();
    if path.is_empty() || path.len() > 32_768 || path.contains('\0') {
        return Err(ServiceFailure::validation("素材路径无效"));
    }
    if require_exists && !Path::new(path).exists() {
        return Err(ServiceFailure::new(
            error_code::NOT_FOUND,
            format!("素材路径不存在: {path}"),
        ));
    }
    Ok(path.to_string())
}

fn source_id(path: &str) -> String {
    format!("src_{:016x}", stable_hash(path_key(path).as_bytes()))
}

fn path_key(path: &str) -> String {
    #[cfg(target_os = "windows")]
    {
        return path
            .replace('/', "\\")
            .trim_end_matches('\\')
            .to_lowercase();
    }
    #[cfg(not(target_os = "windows"))]
    {
        path.trim_end_matches('/').to_string()
    }
}

fn same_path(left: &str, right: &str) -> bool {
    path_key(left) == path_key(right)
}

fn path_belongs_to(path: &str, root: &str) -> bool {
    let path = path_key(path);
    let root = path_key(root);
    if path == root {
        return true;
    }
    let separator = if cfg!(target_os = "windows") {
        '\\'
    } else {
        '/'
    };
    path.strip_prefix(&root)
        .is_some_and(|suffix| suffix.starts_with(separator))
}

const WORKFLOW_START_ID: &str = "__workflow_start__";

fn workflow_node_add(
    state: &mut StoredState,
    request: &AgentRequest,
    workflow_id: &str,
    kind: &str,
) -> Result<DispatchOutcome, ServiceFailure> {
    ensure_actor(request, &[Actor::Agent])?;
    let node_id = new_id("workflow_node");
    mutate_workflow(state, request, workflow_id, "workflow.node_add", |params| {
        let nodes = workflow_graph_nodes_mut(params)?;
        let node = create_workflow_graph_node(&node_id, kind, nodes.len())?;
        nodes.push(node);
        Ok((
            format!("workflow/{workflow_id}/node/{node_id}"),
            format!("添加流程节点 {kind}"),
            json!({ "nodeId": node_id }),
        ))
    })
}

fn workflow_node_set(
    state: &mut StoredState,
    request: &AgentRequest,
    workflow_id: &str,
    node_id: &str,
    field: &str,
    value: Value,
) -> Result<DispatchOutcome, ServiceFailure> {
    ensure_actor(request, &[Actor::Agent])?;
    if value.is_array() || value.is_object() || value.is_null() {
        return Err(ServiceFailure::validation(
            "流程节点一次只能修改一个标量字段",
        ));
    }
    mutate_workflow(state, request, workflow_id, "workflow.node_set", |params| {
        if node_id == WORKFLOW_START_ID {
            set_workflow_start_position(params, field, value.clone())?;
        } else {
            let node = workflow_graph_nodes_mut(params)?
                .iter_mut()
                .find(|node| node.get("id").and_then(Value::as_str) == Some(node_id))
                .and_then(Value::as_object_mut)
                .ok_or_else(|| {
                    ServiceFailure::new(error_code::NOT_FOUND, format!("不存在流程节点: {node_id}"))
                })?;
            validate_and_set_workflow_graph_node_field(node, field, value.clone())?;
            validate_workflow_graph_structure(params, false)?;
        }
        Ok((
            format!("workflow/{workflow_id}/node/{node_id}/{field}"),
            format!("修改流程节点字段 {field}"),
            json!({ "nodeId": node_id, "field": field, "value": value }),
        ))
    })
}

fn workflow_node_remove(
    state: &mut StoredState,
    request: &AgentRequest,
    workflow_id: &str,
    node_id: &str,
) -> Result<DispatchOutcome, ServiceFailure> {
    ensure_actor(request, &[Actor::Agent])?;
    mutate_workflow(
        state,
        request,
        workflow_id,
        "workflow.node_remove",
        |params| {
            let graph = workflow_graph_mut(params)?;
            if node_id == WORKFLOW_START_ID {
                graph.insert("startEnabled".into(), json!(false));
                graph.get_mut("edges").and_then(Value::as_array_mut).ok_or_else(|| ServiceFailure::validation("流程连线结构无效"))?
                    .retain(|edge| edge.get("source").and_then(Value::as_str) != Some(WORKFLOW_START_ID));
                return Ok((format!("workflow/{workflow_id}/node/{node_id}"), "移除默认输入节点".into(), json!({ "removedNodeId": node_id })));
            }
            let nodes = graph
                .get_mut("nodes")
                .and_then(Value::as_array_mut)
                .ok_or_else(|| ServiceFailure::validation("流程 graph.nodes 结构无效"))?;
            let index = nodes
                .iter()
                .position(|node| node.get("id").and_then(Value::as_str) == Some(node_id))
                .ok_or_else(|| {
                    ServiceFailure::new(error_code::NOT_FOUND, format!("不存在流程节点: {node_id}"))
                })?;
            nodes.remove(index);
            graph
                .get_mut("edges")
                .and_then(Value::as_array_mut)
                .ok_or_else(|| ServiceFailure::validation("流程 graph.edges 结构无效"))?
                .retain(|edge| {
                    edge.get("source").and_then(Value::as_str) != Some(node_id)
                        && edge.get("target").and_then(Value::as_str) != Some(node_id)
                });
            Ok((
                format!("workflow/{workflow_id}/node/{node_id}"),
                "移除流程节点".into(),
                json!({ "removedNodeId": node_id }),
            ))
        },
    )
}

fn workflow_edge_add(
    state: &mut StoredState,
    request: &AgentRequest,
    workflow_id: &str,
    source: &str,
    source_port: &str,
    target: &str,
    target_port: &str,
) -> Result<DispatchOutcome, ServiceFailure> {
    ensure_actor(request, &[Actor::Agent])?;
    let edge_id = new_id("workflow_edge");
    mutate_workflow(state, request, workflow_id, "workflow.edge_add", |params| {
        validate_workflow_connection(params, source, source_port, target, target_port)?;
        workflow_graph_edges_mut(params)?.push(json!({
            "id": edge_id,
            "source": source,
            "sourcePort": source_port,
            "target": target,
            "targetPort": target_port
        }));
        Ok((
            format!("workflow/{workflow_id}/edge/{edge_id}"),
            "添加流程连线".into(),
            json!({ "edgeId": edge_id }),
        ))
    })
}

fn workflow_edge_remove(
    state: &mut StoredState,
    request: &AgentRequest,
    workflow_id: &str,
    edge_id: &str,
) -> Result<DispatchOutcome, ServiceFailure> {
    ensure_actor(request, &[Actor::Agent])?;
    mutate_workflow(
        state,
        request,
        workflow_id,
        "workflow.edge_remove",
        |params| {
            let edges = workflow_graph_edges_mut(params)?;
            let index = edges
                .iter()
                .position(|edge| edge.get("id").and_then(Value::as_str) == Some(edge_id))
                .ok_or_else(|| {
                    ServiceFailure::new(error_code::NOT_FOUND, format!("不存在流程连线: {edge_id}"))
                })?;
            edges.remove(index);
            Ok((
                format!("workflow/{workflow_id}/edge/{edge_id}"),
                "移除流程连线".into(),
                json!({ "removedEdgeId": edge_id }),
            ))
        },
    )
}

fn mutate_workflow<F>(
    state: &mut StoredState,
    request: &AgentRequest,
    workflow_id: &str,
    kind: &str,
    mutate: F,
) -> Result<DispatchOutcome, ServiceFailure>
where
    F: FnOnce(&mut Value) -> Result<(String, String, Value), ServiceFailure>,
{
    let (preset_type, index) = find_preset_location(state, workflow_id)?;
    if preset_type != "workflow" {
        return Err(ServiceFailure::validation("目标预设不是 DIT 流程"));
    }
    let preset = &mut state.presets.get_mut(&preset_type).unwrap()[index];
    ensure_revision(request.expected_revision, preset.revision)?;
    ensure_workflow_shape(&mut preset.params)?;
    let before = preset.params.clone();
    let (target, summary, result_detail) = mutate(&mut preset.params)?;
    let after = preset.params.clone();
    if before == after {
        return Err(ServiceFailure::validation("流程没有发生变化"));
    }
    preset.revision += 1;
    let revision = preset.revision;
    let preset_result = preset.clone();
    state.preset_revision += 1;
    Ok(DispatchOutcome::Mutation(MutationDraft {
        result: json!({
            "preset": preset_result,
            "change": result_detail,
        }),
        kind: kind.into(),
        target,
        summary,
        entity_revision: Some(revision),
        undo: Some(UndoPayload::Workflow {
            preset_id: workflow_id.to_string(),
            before,
            after,
        }),
    }))
}

fn create_workflow_graph_node(id: &str, kind: &str, index: usize) -> Result<Value, ServiceFailure> {
    let position = json!({
        "x": 280 + (index % 3) * 300,
        "y": 80 + (index / 3) * 180
    });
    let node = match kind {
        "material" => json!({ "id": id, "type": "material", "path": "", "position": position }),
        "script" => json!({ "id": id, "type": "script", "script": "", "position": position }),
        "outputOverride" => json!({ "id": id, "type": "outputOverride", "override": { "location": "inherit", "naming": "inherit", "directory": "", "subdirectory": "ShadowEncoder", "nameTemplate": "{name}{suffix}" }, "position": position }),
        "backup" | "transcode" | "mix" | "check" => json!({
            "id": id, "type": "action", "kind": kind,
            "presetId": "", "presetRevision": 1, "position": position
        }),
        "filter" => json!({
            "id": id, "type": "filter",
            "filter": { "mediaKind": "all", "nameIncludes": "" },
            "position": position
        }),
        "long_edge" | "frame_rate" | "list_index" | "reverse_index" => json!({
            "id": id, "type": "probe", "metric": kind, "position": position
        }),
        "count" | "math" | "compare" | "boolean" => json!({
            "id": id, "type": "logic",
            "logic": {
                "kind": kind, "value": 3000, "mathOperator": "add",
                "compareOperator": "gt", "booleanOperator": "and"
            },
            "position": position
        }),
        "gate" => json!({ "id": id, "type": "gate", "position": position }),
        "output" => json!({
            "id": id, "type": "output",
            "output": { "mode": "collect", "directory": "", "writeLog": false },
            "position": position
        }),
        _ => {
            return Err(ServiceFailure::validation(format!(
                "未知流程节点类型: {kind}"
            )))
        }
    };
    Ok(node)
}

fn ensure_workflow_shape(params: &mut Value) -> Result<(), ServiceFailure> {
    let object = params
        .as_object_mut()
        .ok_or_else(|| ServiceFailure::validation("流程参数不是对象"))?;
    object.entry("trigger").or_insert_with(|| {
        json!({
            "kind": "manual",
            "volumeKind": "removable",
            "labelContains": "",
            "settleSeconds": 3
        })
    });
    object.entry("graph").or_insert_with(|| {
        json!({
            "startPosition": { "x": 0, "y": 68 },
            "nodes": [],
            "edges": []
        })
    });
    if !object.get("trigger").is_some_and(Value::is_object)
        || !object.get("graph").is_some_and(Value::is_object)
    {
        return Err(ServiceFailure::validation("流程 trigger 或 graph 结构无效"));
    }
    let graph = object.get_mut("graph").unwrap().as_object_mut().unwrap();
    graph
        .entry("startPosition")
        .or_insert_with(|| json!({ "x": 0, "y": 68 }));
    graph
        .entry("nodes")
        .or_insert_with(|| Value::Array(Vec::new()));
    graph
        .entry("edges")
        .or_insert_with(|| Value::Array(Vec::new()));
    if !graph.get("startPosition").is_some_and(Value::is_object)
        || !graph.get("nodes").is_some_and(Value::is_array)
        || !graph.get("edges").is_some_and(Value::is_array)
    {
        return Err(ServiceFailure::validation("流程 graph 结构无效"));
    }
    Ok(())
}

fn workflow_graph_mut(params: &mut Value) -> Result<&mut Map<String, Value>, ServiceFailure> {
    ensure_workflow_shape(params)?;
    params
        .get_mut("graph")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| ServiceFailure::validation("流程 graph 结构无效"))
}

fn workflow_graph_nodes_mut(params: &mut Value) -> Result<&mut Vec<Value>, ServiceFailure> {
    workflow_graph_mut(params)?
        .get_mut("nodes")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| ServiceFailure::validation("流程 graph.nodes 结构无效"))
}

fn workflow_graph_edges_mut(params: &mut Value) -> Result<&mut Vec<Value>, ServiceFailure> {
    workflow_graph_mut(params)?
        .get_mut("edges")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| ServiceFailure::validation("流程 graph.edges 结构无效"))
}

fn set_workflow_start_position(
    params: &mut Value,
    field: &str,
    value: Value,
) -> Result<(), ServiceFailure> {
    if field == "enabled" {
        if !value.is_boolean() { return Err(ServiceFailure::validation("enabled 必须是布尔值")); }
        workflow_graph_mut(params)?.insert("startEnabled".into(), value);
        return Ok(());
    }
    let coordinate = field
        .strip_prefix("position.")
        .filter(|coordinate| matches!(*coordinate, "x" | "y"))
        .ok_or_else(|| ServiceFailure::validation("输入节点只支持 position.x 或 position.y"))?;
    let number = value
        .as_f64()
        .filter(|number| number.is_finite() && (-10000.0..=10000.0).contains(number))
        .ok_or_else(|| ServiceFailure::validation("节点位置必须在 -10000 到 10000 之间"))?;
    workflow_graph_mut(params)?
        .get_mut("startPosition")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| ServiceFailure::validation("输入节点位置结构无效"))?
        .insert(coordinate.into(), json!(number));
    Ok(())
}

fn validate_and_set_workflow_graph_node_field(
    node: &mut Map<String, Value>,
    field: &str,
    value: Value,
) -> Result<(), ServiceFailure> {
    let node_type = node.get("type").and_then(Value::as_str).unwrap_or_default();
    if field == "position.x" || field == "position.y" {
        let coordinate = field.trim_start_matches("position.");
        let number = value
            .as_f64()
            .filter(|number| number.is_finite() && (-10000.0..=10000.0).contains(number))
            .ok_or_else(|| ServiceFailure::validation("节点位置必须在 -10000 到 10000 之间"))?;
        node.get_mut("position")
            .and_then(Value::as_object_mut)
            .ok_or_else(|| ServiceFailure::validation("流程节点位置结构无效"))?
            .insert(coordinate.into(), json!(number));
        return Ok(());
    }
    match (node_type, field) {
        ("outputOverride", "override.location") => {
            if !matches!(value.as_str(), Some("inherit" | "source" | "subdir" | "fixed")) { return Err(ServiceFailure::validation("未知输出覆盖位置")); }
            workflow_nested_field(node, "override", "location", value)?;
        }
        ("outputOverride", "override.naming") => {
            if !matches!(value.as_str(), Some("inherit" | "default" | "template")) { return Err(ServiceFailure::validation("未知命名覆盖方式")); }
            workflow_nested_field(node, "override", "naming", value)?;
        }
        ("outputOverride", "override.directory" | "override.subdirectory" | "override.nameTemplate") => {
            if value.as_str().is_none_or(|text| text.len() > 4096 || text.contains('\0')) { return Err(ServiceFailure::validation("输出覆盖字段无效")); }
            workflow_nested_field(node, "override", field.trim_start_matches("override."), value)?;
        }
        ("script", "script") | ("material", "path") => {
            let limit = if field == "script" { 262144 } else { 4096 };
            if value.as_str().is_none_or(|text| text.len() > limit || text.contains('\0')) {
                return Err(ServiceFailure::validation("脚本或素材路径无效"));
            }
            node.insert(field.into(), value);
        }
        ("action", "presetId") => {
            let value_text = value
                .as_str()
                .ok_or_else(|| ServiceFailure::validation("presetId 必须是字符串"))?;
            if value_text.len() > 128 || value_text.contains('\0') {
                return Err(ServiceFailure::validation("presetId 无效"));
            }
            node.insert(field.into(), value);
        }
        ("action", "presetRevision") => {
            if value.as_i64().is_none_or(|revision| revision < 1) {
                return Err(ServiceFailure::validation("presetRevision 必须是正整数"));
            }
            node.insert(field.into(), value);
        }
        ("filter", "filter.mediaKind") => {
            if !matches!(value.as_str(), Some("all" | "video" | "audio")) {
                return Err(ServiceFailure::validation(
                    "mediaKind 只能是 all、video 或 audio",
                ));
            }
            node.get_mut("filter")
                .and_then(Value::as_object_mut)
                .ok_or_else(|| ServiceFailure::validation("筛选节点结构无效"))?
                .insert("mediaKind".into(), value);
        }
        ("filter", "filter.nameIncludes") => {
            if value
                .as_str()
                .is_none_or(|text| text.len() > 256 || text.contains('\0'))
            {
                return Err(ServiceFailure::validation("nameIncludes 无效"));
            }
            node.get_mut("filter")
                .and_then(Value::as_object_mut)
                .ok_or_else(|| ServiceFailure::validation("筛选节点结构无效"))?
                .insert("nameIncludes".into(), value);
        }
        ("probe", "metric") => {
            if !matches!(
                value.as_str(),
                Some("long_edge" | "frame_rate" | "list_index" | "reverse_index")
            ) {
                return Err(ServiceFailure::validation("未知检测指标"));
            }
            node.insert("metric".into(), value);
        }
        ("logic", "logic.value") => {
            let number = value
                .as_f64()
                .filter(|number| {
                    number.is_finite() && (-1_000_000.0..=1_000_000.0).contains(number)
                })
                .ok_or_else(|| {
                    ServiceFailure::validation("逻辑常量必须在 -1000000 到 1000000 之间")
                })?;
            workflow_nested_field(node, "logic", "value", json!(number))?;
        }
        ("logic", "logic.mathOperator") => {
            if !matches!(
                value.as_str(),
                Some("add" | "subtract" | "multiply" | "divide" | "modulo")
            ) {
                return Err(ServiceFailure::validation("未知数值运算符"));
            }
            workflow_nested_field(node, "logic", "mathOperator", value)?;
        }
        ("logic", "logic.compareOperator") => {
            if !matches!(
                value.as_str(),
                Some("eq" | "ne" | "lt" | "lte" | "gt" | "gte")
            ) {
                return Err(ServiceFailure::validation("未知比较运算符"));
            }
            workflow_nested_field(node, "logic", "compareOperator", value)?;
        }
        ("logic", "logic.booleanOperator") => {
            if !matches!(value.as_str(), Some("and" | "or" | "xor" | "not")) {
                return Err(ServiceFailure::validation("未知布尔运算符"));
            }
            workflow_nested_field(node, "logic", "booleanOperator", value)?;
        }
        ("output", "output.mode") => {
            if !matches!(
                value.as_str(),
                Some("collect" | "copy" | "move" | "restore")
            ) {
                return Err(ServiceFailure::validation("未知文件输出模式"));
            }
            workflow_nested_field(node, "output", "mode", value)?;
        }
        ("output", "output.directory") => {
            if value
                .as_str()
                .is_none_or(|text| text.len() > 4096 || text.contains('\0'))
            {
                return Err(ServiceFailure::validation("输出目录无效"));
            }
            workflow_nested_field(node, "output", "directory", value)?;
        }
        ("output", "output.writeLog") => {
            if !value.is_boolean() {
                return Err(ServiceFailure::validation("writeLog 必须是布尔值"));
            }
            workflow_nested_field(node, "output", "writeLog", value)?;
        }
        _ => {
            return Err(ServiceFailure::validation(format!(
                "该节点不支持字段 {field}"
            )))
        }
    }
    Ok(())
}

fn workflow_nested_field(
    node: &mut Map<String, Value>,
    object: &str,
    field: &str,
    value: Value,
) -> Result<(), ServiceFailure> {
    node.get_mut(object)
        .and_then(Value::as_object_mut)
        .ok_or_else(|| ServiceFailure::validation("流程节点结构无效"))?
        .insert(field.into(), value);
    Ok(())
}

fn workflow_graph_parts(params: &Value) -> Result<(&[Value], &[Value]), ServiceFailure> {
    let graph = params
        .get("graph")
        .and_then(Value::as_object)
        .ok_or_else(|| ServiceFailure::validation("流程 graph 结构无效"))?;
    let nodes = graph
        .get("nodes")
        .and_then(Value::as_array)
        .ok_or_else(|| ServiceFailure::validation("流程 graph.nodes 结构无效"))?;
    let edges = graph
        .get("edges")
        .and_then(Value::as_array)
        .ok_or_else(|| ServiceFailure::validation("流程 graph.edges 结构无效"))?;
    Ok((nodes, edges))
}

fn workflow_node_ports(
    node: &Value,
) -> Result<
    (
        Vec<(&'static str, &'static str, bool)>,
        Vec<(&'static str, &'static str, bool)>,
    ),
    ServiceFailure,
> {
    let media_in = vec![("media", "media", true)];
    match node.get("type").and_then(Value::as_str) {
        Some("material") => Ok((vec![], vec![("media", "media", false)])),
        Some("script") => Ok((media_in, vec![("media", "media", false), ("error", "error", false)])),
        Some("outputOverride") => Ok((media_in, vec![("media", "media", false)])),
        Some("action") => {
            if !matches!(
                node.get("kind").and_then(Value::as_str),
                Some("backup" | "transcode" | "mix" | "check")
            ) {
                return Err(ServiceFailure::validation("流程动作类型无效"));
            }
            Ok((
                media_in,
                vec![
                    ("media", "media", false),
                    ("failed", "media", false),
                    ("success", "bool", false),
                    ("report", "report", false),
                    ("error", "error", false),
                ],
            ))
        }
        Some("filter") => Ok((media_in, vec![("media", "media", false)])),
        Some("probe") => {
            if !matches!(
                node.get("metric").and_then(Value::as_str),
                Some("long_edge" | "frame_rate" | "list_index" | "reverse_index")
            ) {
                return Err(ServiceFailure::validation("流程检测指标无效"));
            }
            Ok((
                media_in,
                vec![
                    ("media", "media", false),
                    ("value", "number", false),
                    ("error", "error", false),
                ],
            ))
        }
        Some("gate") => Ok((
            vec![("media", "media", true), ("condition", "bool", true)],
            vec![("matched", "media", false), ("unmatched", "media", false)],
        )),
        Some("output") => Ok((
            vec![("media", "media", true), ("report", "report", false)],
            vec![
                ("media", "media", false),
                ("report", "report", false),
                ("error", "error", false),
            ],
        )),
        Some("logic") => {
            let logic = node
                .get("logic")
                .and_then(Value::as_object)
                .ok_or_else(|| ServiceFailure::validation("流程逻辑节点结构无效"))?;
            match logic.get("kind").and_then(Value::as_str) {
                Some("count") => Ok((media_in, vec![("value", "number", false)])),
                Some("math") => Ok((
                    vec![("value", "number", true)],
                    vec![("value", "number", false)],
                )),
                Some("compare") => Ok((
                    vec![("value", "number", true)],
                    vec![("result", "bool", false)],
                )),
                Some("boolean") => {
                    let mut inputs = vec![("left", "bool", true)];
                    if logic.get("booleanOperator").and_then(Value::as_str) != Some("not") {
                        inputs.push(("right", "bool", true));
                    }
                    Ok((inputs, vec![("result", "bool", false)]))
                }
                _ => Err(ServiceFailure::validation("流程逻辑类型无效")),
            }
        }
        _ => Err(ServiceFailure::validation("流程包含未知节点")),
    }
}

fn workflow_node_port_type(
    nodes: &[Value],
    node_id: &str,
    port_id: &str,
    source: bool,
) -> Result<&'static str, ServiceFailure> {
    if node_id == WORKFLOW_START_ID {
        return if source && port_id == "media" {
            Ok("media")
        } else {
            Err(ServiceFailure::validation("输入节点端口无效"))
        };
    }
    let node = nodes
        .iter()
        .find(|node| node.get("id").and_then(Value::as_str) == Some(node_id))
        .ok_or_else(|| {
            ServiceFailure::new(error_code::NOT_FOUND, format!("不存在流程节点: {node_id}"))
        })?;
    let (inputs, outputs) = workflow_node_ports(node)?;
    (if source { outputs } else { inputs })
        .into_iter()
        .find(|(id, _, _)| *id == port_id)
        .map(|(_, port_type, _)| port_type)
        .ok_or_else(|| ServiceFailure::validation(format!("节点 {node_id} 不存在端口 {port_id}")))
}

fn workflow_reaches(
    edges: &[Value],
    current: &str,
    target: &str,
    seen: &mut HashSet<String>,
) -> bool {
    current == target
        || (seen.insert(current.to_string())
            && edges.iter().any(|edge| {
                edge.get("source").and_then(Value::as_str) == Some(current)
                    && edge
                        .get("target")
                        .and_then(Value::as_str)
                        .is_some_and(|next| workflow_reaches(edges, next, target, seen))
            }))
}

fn validate_workflow_connection(
    params: &Value,
    source: &str,
    source_port: &str,
    target: &str,
    target_port: &str,
) -> Result<(), ServiceFailure> {
    if source == WORKFLOW_START_ID && params.pointer("/graph/startEnabled").and_then(Value::as_bool) == Some(false) {
        return Err(ServiceFailure::validation("输入节点已删除"));
    }
    if source == target {
        return Err(ServiceFailure::validation("流程节点不能连接到自己"));
    }
    let (nodes, edges) = workflow_graph_parts(params)?;
    let source_type = workflow_node_port_type(nodes, source, source_port, true)?;
    let target_type = workflow_node_port_type(nodes, target, target_port, false)?;
    if source_type != target_type {
        return Err(ServiceFailure::validation("流程端口类型不匹配"));
    }
    if edges.iter().any(|edge| {
        edge.get("source").and_then(Value::as_str) == Some(source)
            && edge.get("sourcePort").and_then(Value::as_str) == Some(source_port)
            && edge.get("target").and_then(Value::as_str) == Some(target)
            && edge.get("targetPort").and_then(Value::as_str) == Some(target_port)
    }) {
        return Err(ServiceFailure::validation("流程连线已存在"));
    }
    if source != WORKFLOW_START_ID && workflow_reaches(edges, target, source, &mut HashSet::new()) {
        return Err(ServiceFailure::validation("流程连线会形成环路"));
    }
    Ok(())
}

fn validate_workflow_graph_structure(
    params: &Value,
    require_complete: bool,
) -> Result<(), ServiceFailure> {
    let (nodes, edges) = workflow_graph_parts(params)?;
    let mut node_ids = HashSet::new();
    for node in nodes {
        let node_id = node
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty() && *id != WORKFLOW_START_ID)
            .ok_or_else(|| ServiceFailure::validation("流程节点 ID 无效"))?;
        if !node_ids.insert(node_id) {
            return Err(ServiceFailure::validation("流程节点 ID 重复"));
        }
        workflow_node_ports(node)?;
    }

    let mut edge_ids = HashSet::new();
    let mut connections = HashSet::new();
    for edge in edges {
        let edge_id = edge
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| ServiceFailure::validation("流程连线 ID 无效"))?;
        if !edge_ids.insert(edge_id) {
            return Err(ServiceFailure::validation("流程连线 ID 重复"));
        }
        let source = edge
            .get("source")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let source_port = edge
            .get("sourcePort")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let target = edge
            .get("target")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let target_port = edge
            .get("targetPort")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if source == target {
            return Err(ServiceFailure::validation("流程节点不能连接到自己"));
        }
        if workflow_node_port_type(nodes, source, source_port, true)?
            != workflow_node_port_type(nodes, target, target_port, false)?
        {
            return Err(ServiceFailure::validation("流程端口类型不匹配"));
        }
        if !connections.insert((source, source_port, target, target_port)) {
            return Err(ServiceFailure::validation("流程连线重复"));
        }
        if source != WORKFLOW_START_ID
            && workflow_reaches(edges, target, source, &mut HashSet::new())
        {
            return Err(ServiceFailure::validation("流程包含环路"));
        }
    }

    if !require_complete {
        return Ok(());
    }
    if !nodes.iter().any(|node| node.get("type").and_then(Value::as_str) == Some("output")) {
        return Err(ServiceFailure::validation("流程需要至少一个文件输出节点"));
    }
    let start_enabled = params.pointer("/graph/startEnabled").and_then(Value::as_bool) != Some(false);
    if !start_enabled && edges.iter().any(|edge| edge.get("source").and_then(Value::as_str) == Some(WORKFLOW_START_ID)) {
        return Err(ServiceFailure::validation("连线引用了已删除的输入节点"));
    }
    let mut reachable = HashSet::new();
    if start_enabled { reachable.insert(WORKFLOW_START_ID.to_string()); }
    for node in nodes {
        let kind = node.get("type").and_then(Value::as_str).unwrap_or_default();
        if kind == "material" {
            if node.get("path").and_then(Value::as_str).is_none_or(|path| path.trim().is_empty()) { return Err(ServiceFailure::validation("素材节点未指定文件")); }
            reachable.insert(node["id"].as_str().unwrap().to_string());
        }
        if kind == "script" && node.get("script").and_then(Value::as_str).is_none_or(|script| script.trim().is_empty() || script.chars().count() > 65536) {
            return Err(ServiceFailure::validation("脚本为空或超过 64K 字符"));
        }
        if kind == "script" || kind == "outputOverride" {
            let mut pending: Vec<&str> = edges.iter().filter(|edge| edge.get("source") == node.get("id") && edge["sourcePort"] == "media").filter_map(|edge| edge["target"].as_str()).collect();
            let mut seen = HashSet::new();
            while let Some(id) = pending.pop() {
                if !seen.insert(id) { continue; }
                let next = nodes.iter().find(|item| item["id"] == id).ok_or_else(|| ServiceFailure::validation("节点不存在"))?;
                if next["type"] == "action" && (next["kind"] == "transcode" || (kind == "outputOverride" && next["kind"] == "mix")) { continue; }
                if matches!(next["type"].as_str(), Some("output" | "action")) || (kind == "script" && matches!(next["type"].as_str(), Some("probe" | "script"))) {
                    return Err(ServiceFailure::validation(if kind == "script" { "自定义预处理必须先连接编码节点，再输出或执行其他处理" } else { "输出设置覆盖请放在编码或混音节点之前" }));
                }
                pending.extend(edges.iter().filter(|edge| edge["source"] == id && edge["targetPort"] == "media").filter_map(|edge| edge["target"].as_str()));
            }
        }
        if kind == "outputOverride" {
            let value = &node["override"];
            let field = match value["location"].as_str() { Some("fixed") => Some("directory"), Some("subdir") => Some("subdirectory"), _ => None };
            if field.is_some_and(|field| value[field].as_str().is_none_or(|text| text.trim().is_empty())) { return Err(ServiceFailure::validation("输出设置覆盖节点未填写目录")); }
            if value["naming"] == "template" && value["nameTemplate"].as_str().is_none_or(|text| text.trim().is_empty()) { return Err(ServiceFailure::validation("输出设置覆盖节点未填写命名模板")); }
        }
        if kind != "output" && !edges.iter().any(|edge| edge.get("source") == node.get("id")) {
            return Err(ServiceFailure::validation("存在未连接后续节点或文件输出的节点"));
        }
        if kind == "output" && (matches!(node.pointer("/output/mode").and_then(Value::as_str), Some("copy" | "move")) || node.pointer("/output/writeLog").and_then(Value::as_bool) == Some(true))
            && node.pointer("/output/directory").and_then(Value::as_str).is_none_or(|path| path.trim().is_empty()) {
            return Err(ServiceFailure::validation("文件输出节点未选择目录"));
        }
    }
    loop {
        let before = reachable.len();
        for edge in edges {
            let source = edge
                .get("source")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let target = edge
                .get("target")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if reachable.contains(source) {
                reachable.insert(target.to_string());
            }
        }
        if reachable.len() == before {
            break;
        }
    }
    if nodes.iter().any(|node| {
        node.get("id")
            .and_then(Value::as_str)
            .is_none_or(|id| !reachable.contains(id))
    }) {
        return Err(ServiceFailure::validation("存在未接入流程的节点"));
    }
    for node in nodes {
        let node_id = node.get("id").and_then(Value::as_str).unwrap();
        let (inputs, _) = workflow_node_ports(node)?;
        for (port_id, _, required) in inputs {
            if required
                && !edges.iter().any(|edge| {
                    edge.get("target").and_then(Value::as_str) == Some(node_id)
                        && edge.get("targetPort").and_then(Value::as_str) == Some(port_id)
                })
            {
                return Err(ServiceFailure::validation(format!(
                    "节点 {node_id} 缺少必需输入 {port_id}"
                )));
            }
        }
    }
    Ok(())
}

fn start_task(
    state: &mut StoredState,
    request: &AgentRequest,
    function: &str,
    preset_id: &str,
    scope: &str,
) -> Result<DispatchOutcome, ServiceFailure> {
    ensure_actor(request, &[Actor::Agent])?;
    if scope != "selected" {
        return Err(ServiceFailure::validation(
            "Agent CLI 任务只允许使用 --scope selected",
        ));
    }
    if state.tasks.iter().any(|task| {
        matches!(
            task.status.as_str(),
            "requested" | "running" | "cancel_requested"
        )
    }) {
        return Err(ServiceFailure::new(
            error_code::TASK_BUSY,
            "当前已有任务正在执行或等待执行",
        ));
    }
    let expected_type = match function {
        "encode" => "encode",
        "mix" => "mix",
        "check" => "check",
        "alpha" => "alpha",
        "backup" => "backup",
        "workflow" => "workflow",
        _ => {
            return Err(ServiceFailure::new(
                error_code::DESTRUCTIVE_COMMAND_DENIED,
                format!("Agent CLI 尚未开放任务类型: {function}"),
            ))
        }
    };
    let input_paths = if matches!(function, "backup" | "workflow") {
        &state.selected_source_paths
    } else {
        &state.selected_paths
    };
    if input_paths.is_empty() {
        return Err(ServiceFailure::validation("素材列表中没有已勾选项"));
    }
    let (preset_type, preset) = find_preset(state, preset_id)?;
    if preset_type != expected_type {
        return Err(ServiceFailure::validation(format!(
            "任务 {function} 需要 {expected_type} 预设"
        )));
    }
    ensure_revision(request.expected_revision, preset.revision)?;
    if function == "backup"
        && preset.params.get("operation").and_then(Value::as_str) == Some("move")
    {
        return Err(ServiceFailure::new(
            error_code::DESTRUCTIVE_COMMAND_DENIED,
            "Agent CLI 不允许执行移动源文件的 DIT 备份",
        ));
    }
    if function == "workflow" {
        validate_agent_workflow(state, &preset.params)?;
    }
    let preset_snapshots = collect_agent_task_preset_snapshots(state, function, preset)?;

    let task = TaskSnapshot {
        id: new_id("task"),
        function: function.to_string(),
        preset_id: preset_id.to_string(),
        preset_revision: preset.revision,
        preset_snapshots,
        scope: scope.to_string(),
        input_paths: input_paths.clone(),
        status: "requested".into(),
        progress: 0.0,
        detail: "等待 GUI 接收任务".into(),
        output_paths: Vec::new(),
        error: None,
        revision: 1,
    };
    state.tasks.push(task.clone());
    Ok(DispatchOutcome::Mutation(MutationDraft {
        result: json!(task),
        kind: "task.start".into(),
        target: format!("task/{}", task.id),
        summary: format!("请求执行 {function} 任务"),
        entity_revision: Some(task.revision),
        undo: Some(UndoPayload::TaskStart {
            task_id: task.id.clone(),
        }),
    }))
}

fn collect_task_preset(
    state: &StoredState,
    preset_id: &str,
    expected_type: &str,
    expected_revision: Option<i64>,
    snapshots: &mut Vec<PresetSnapshot>,
    seen: &mut HashSet<String>,
) -> Result<PresetSnapshot, ServiceFailure> {
    let (preset_type, preset) = find_preset(state, preset_id)?;
    if preset_type != expected_type {
        return Err(ServiceFailure::validation(format!(
            "流程步骤 {preset_id} 需要 {expected_type} 预设"
        )));
    }
    if expected_revision.is_some_and(|revision| revision != preset.revision) {
        return Err(ServiceFailure::new(
            error_code::REVISION_CONFLICT,
            format!("流程引用的预设 {} 已更新", preset.name),
        ));
    }
    if seen.insert(preset.id.clone()) {
        snapshots.push(preset.clone());
    }
    Ok(preset.clone())
}

fn collect_check_reference(
    state: &StoredState,
    params: &Value,
    snapshots: &mut Vec<PresetSnapshot>,
    seen: &mut HashSet<String>,
) -> Result<(), ServiceFailure> {
    let reference_id = params
        .get("refEncPresetId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !reference_id.is_empty() {
        collect_task_preset(state, reference_id, "encode", None, snapshots, seen)?;
    }
    Ok(())
}

fn collect_workflow_task_presets(
    state: &StoredState,
    nodes: &[Value],
    snapshots: &mut Vec<PresetSnapshot>,
    seen: &mut HashSet<String>,
) -> Result<(), ServiceFailure> {
    for node in nodes {
        if node.get("type").and_then(Value::as_str) != Some("action") {
            continue;
        }

        let kind = node
            .get("kind")
            .and_then(Value::as_str)
            .ok_or_else(|| ServiceFailure::validation("流程动作类型无效"))?;
        let expected_type = match kind {
            "backup" => "backup",
            "transcode" => "encode",
            "mix" => "mix",
            "check" => "check",
            _ => return Err(ServiceFailure::validation("流程包含未知动作")),
        };
        let preset_id = node
            .get("presetId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let preset_revision = node.get("presetRevision").and_then(Value::as_i64);
        let preset = collect_task_preset(
            state,
            preset_id,
            expected_type,
            preset_revision,
            snapshots,
            seen,
        )?;
        if kind == "backup"
            && preset.params.get("operation").and_then(Value::as_str) == Some("move")
        {
            return Err(ServiceFailure::new(
                error_code::DESTRUCTIVE_COMMAND_DENIED,
                "流程引用了移动源文件的备份预设",
            ));
        }
        if kind == "check" {
            collect_check_reference(state, &preset.params, snapshots, seen)?;
        }
    }
    Ok(())
}

fn collect_agent_task_preset_snapshots(
    state: &StoredState,
    function: &str,
    main_preset: &PresetSnapshot,
) -> Result<Vec<PresetSnapshot>, ServiceFailure> {
    let mut snapshots = vec![main_preset.clone()];
    let mut seen = HashSet::from([main_preset.id.clone()]);
    if function == "check" {
        collect_check_reference(state, &main_preset.params, &mut snapshots, &mut seen)?;
    } else if function == "workflow" {
        let nodes = main_preset
            .params
            .pointer("/graph/nodes")
            .and_then(Value::as_array)
            .ok_or_else(|| ServiceFailure::validation("流程 graph.nodes 结构无效"))?;
        collect_workflow_task_presets(state, nodes, &mut snapshots, &mut seen)?;
    }
    Ok(snapshots)
}

fn cancel_task(
    state: &mut StoredState,
    request: &AgentRequest,
    task_id: &str,
) -> Result<DispatchOutcome, ServiceFailure> {
    ensure_actor(request, &[Actor::Agent, Actor::Gui])?;
    let task = state
        .tasks
        .iter_mut()
        .find(|task| task.id == task_id)
        .ok_or_else(|| {
            ServiceFailure::new(error_code::NOT_FOUND, format!("不存在任务: {task_id}"))
        })?;
    if !matches!(task.status.as_str(), "requested" | "running") {
        return Err(ServiceFailure::validation(format!(
            "任务当前状态 {} 不能取消",
            task.status
        )));
    }
    task.status = "cancel_requested".into();
    task.detail = "正在请求终止".into();
    task.revision += 1;
    let revision = task.revision;
    Ok(DispatchOutcome::Mutation(MutationDraft {
        result: json!(task.clone()),
        kind: "task.cancel".into(),
        target: format!("task/{task_id}"),
        summary: "请求终止任务".into(),
        entity_revision: Some(revision),
        undo: None,
    }))
}

#[allow(clippy::too_many_arguments)]
fn update_task(
    state: &mut StoredState,
    request: &AgentRequest,
    task_id: &str,
    status: &str,
    progress: Option<f64>,
    detail: Option<String>,
    output_paths: Option<Vec<String>>,
    error: Option<String>,
) -> Result<DispatchOutcome, ServiceFailure> {
    ensure_actor(request, &[Actor::Gui, Actor::System])?;
    if !matches!(
        status,
        "requested" | "running" | "cancel_requested" | "completed" | "failed" | "canceled"
    ) {
        return Err(ServiceFailure::validation(format!(
            "未知任务状态: {status}"
        )));
    }
    let task = state
        .tasks
        .iter_mut()
        .find(|task| task.id == task_id)
        .ok_or_else(|| {
            ServiceFailure::new(error_code::NOT_FOUND, format!("不存在任务: {task_id}"))
        })?;
    let transition_allowed = match task.status.as_str() {
        "requested" => matches!(status, "running" | "failed" | "canceled"),
        "running" => matches!(status, "running" | "completed" | "failed" | "canceled"),
        "cancel_requested" => matches!(status, "cancel_requested" | "failed" | "canceled"),
        _ => false,
    };
    if !transition_allowed {
        return Err(ServiceFailure::validation(format!(
            "任务状态不能从 {} 变为 {status}",
            task.status
        )));
    }
    task.status = status.to_string();
    if let Some(progress) = progress {
        if !progress.is_finite() || !(0.0..=100.0).contains(&progress) {
            return Err(ServiceFailure::validation("任务进度必须在 0 到 100 之间"));
        }
        task.progress = progress;
    }
    if let Some(detail) = detail {
        task.detail = detail;
    }
    if let Some(paths) = output_paths {
        task.output_paths = paths;
    }
    task.error = error;
    task.revision += 1;
    let revision = task.revision;
    let terminal = matches!(status, "completed" | "failed" | "canceled");
    if status == "completed" {
        let mut hashes = BTreeMap::new();
        for path in &task.output_paths {
            hashes.insert(path.clone(), hash_file(Path::new(path))?);
        }
        state.task_output_hashes.insert(task_id.to_string(), hashes);
    }
    let result = json!(task.clone());
    Ok(DispatchOutcome::Mutation(MutationDraft {
        result,
        kind: "task.gui_update".into(),
        target: format!("task/{task_id}"),
        summary: if terminal {
            format!("任务进入终态 {status}")
        } else {
            format!("更新任务状态 {status}")
        },
        entity_revision: Some(revision),
        undo: None,
    }))
}

fn validate_agent_workflow(state: &StoredState, params: &Value) -> Result<(), ServiceFailure> {
    if params
        .get("trigger")
        .and_then(|trigger| trigger.get("kind"))
        .and_then(Value::as_str)
        != Some("manual")
    {
        return Err(ServiceFailure::new(
            error_code::DESTRUCTIVE_COMMAND_DENIED,
            "Agent CLI 第一版只允许手动触发的流程",
        ));
    }
    validate_workflow_graph_structure(params, true)?;
    let (nodes, _) = workflow_graph_parts(params)?;
    for node in nodes {
        if node.get("type").and_then(Value::as_str) == Some("material") {
            let path = node.get("path").and_then(Value::as_str).unwrap_or_default();
            if !state.selected_paths.iter().chain(state.selected_source_paths.iter()).any(|selected| selected == path) {
                return Err(ServiceFailure::validation("Agent 流程中的指定素材必须先在素材列表中勾选"));
            }
        }
        if node.get("type").and_then(Value::as_str) == Some("action")
            && node.get("kind").and_then(Value::as_str) == Some("backup")
        {
            let preset_id = node
                .get("presetId")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let (preset_type, preset) = find_preset(state, preset_id)?;
            if preset_type != "backup"
                || preset.params.get("operation").and_then(Value::as_str) == Some("move")
            {
                return Err(ServiceFailure::new(
                    error_code::DESTRUCTIVE_COMMAND_DENIED,
                    "流程引用了移动源文件的备份预设",
                ));
            }
        }
        if node.get("type").and_then(Value::as_str) == Some("output")
            && matches!(
                node.pointer("/output/mode").and_then(Value::as_str),
                Some("move" | "restore")
            )
        {
            return Err(ServiceFailure::new(
                error_code::DESTRUCTIVE_COMMAND_DENIED,
                "Agent CLI 不允许启动包含移动文件操作的流程",
            ));
        }
    }
    Ok(())
}

fn hash_file(path: &Path) -> Result<String, ServiceFailure> {
    use md5::{Digest, Md5};
    use std::io::Read;

    let mut file = std::fs::File::open(path).map_err(|error| {
        ServiceFailure::new(
            error_code::OUTPUT_CHANGED,
            format!("无法读取任务输出 {}: {error}", path.display()),
        )
    })?;
    let mut hasher = Md5::new();
    let mut buffer = vec![0_u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| {
            ServiceFailure::new(
                error_code::OUTPUT_CHANGED,
                format!("无法校验任务输出 {}: {error}", path.display()),
            )
        })?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn undo_latest(
    transaction: &Transaction<'_>,
    state: &mut StoredState,
    request: &AgentRequest,
) -> Result<DispatchOutcome, ServiceFailure> {
    ensure_actor(request, &[Actor::Agent])?;
    let record = transaction
        .query_row(
            "SELECT operation_id, kind, target, summary, undo_json
             FROM agent_operations
             WHERE session_id = ?1 AND status = 'applied'
             ORDER BY sequence DESC LIMIT 1",
            params![request.session_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            },
        )
        .optional()?;
    let Some((operation_id, original_kind, target, original_summary, undo_json)) = record else {
        return Err(ServiceFailure::new(
            error_code::HISTORY_EMPTY,
            "当前 Agent 会话没有可撤回操作",
        ));
    };
    let payload: UndoPayload = serde_json::from_str(&undo_json)?;
    let (result, revision) = apply_undo(state, &payload)?;
    transaction.execute(
        "UPDATE agent_operations SET status = 'undone' WHERE operation_id = ?1",
        params![operation_id],
    )?;
    Ok(DispatchOutcome::Mutation(MutationDraft {
        result: json!({
            "undoneOperationId": operation_id,
            "originalKind": original_kind,
            "result": result,
        }),
        kind: "undo".into(),
        target,
        summary: format!("撤回：{original_summary}"),
        entity_revision: revision,
        undo: None,
    }))
}

fn apply_undo(
    state: &mut StoredState,
    payload: &UndoPayload,
) -> Result<(Value, Option<i64>), ServiceFailure> {
    match payload {
        UndoPayload::PresetCreate { preset } => {
            let (preset_type, index) = find_preset_location(state, &preset.id)?;
            let current = &state.presets[&preset_type][index];
            if current != preset {
                return Err(undo_conflict("创建后的预设已被修改"));
            }
            state.presets.get_mut(&preset_type).unwrap().remove(index);
            state.preset_revision += 1;
            Ok((json!({ "deletedPresetId": preset.id }), None))
        }
        UndoPayload::PresetDelete { preset, index } => {
            if find_preset_location(state, &preset.id).is_ok() {
                return Err(undo_conflict("被删除的预设 ID 已被重新占用"));
            }
            let list = state.presets.entry(preset.preset_type.clone()).or_default();
            list.insert((*index).min(list.len()), preset.clone());
            state.preset_revision += 1;
            Ok((json!(preset), Some(preset.revision)))
        }
        UndoPayload::PresetRename {
            preset_id,
            before,
            after,
        } => {
            let (preset_type, index) = find_preset_location(state, preset_id)?;
            let preset = &mut state.presets.get_mut(&preset_type).unwrap()[index];
            if preset.name != *after {
                return Err(undo_conflict("预设名称已被后续操作修改"));
            }
            preset.name = before.clone();
            preset.revision += 1;
            let revision = preset.revision;
            let result = json!(preset.clone());
            state.preset_revision += 1;
            Ok((result, Some(revision)))
        }
        UndoPayload::PresetField {
            preset_id,
            field,
            before_exists,
            before,
            after,
        } => {
            let (preset_type, index) = find_preset_location(state, preset_id)?;
            let preset = &mut state.presets.get_mut(&preset_type).unwrap()[index];
            if get_json_path(&preset.params, field) != Some(after) {
                return Err(undo_conflict("该预设字段已被后续操作修改"));
            }
            if *before_exists {
                set_json_path(&mut preset.params, field, before.clone())?;
            } else {
                remove_json_path(&mut preset.params, field)?;
            }
            preset.revision += 1;
            let revision = preset.revision;
            let result = json!(preset.clone());
            state.preset_revision += 1;
            Ok((result, Some(revision)))
        }
        UndoPayload::PresetItemAdd {
            preset_id,
            field,
            item_id,
            value,
        } => {
            let (preset_type, index) = find_preset_location(state, preset_id)?;
            let preset = &mut state.presets.get_mut(&preset_type).unwrap()[index];
            let items = get_json_path_mut(&mut preset.params, field)
                .and_then(Value::as_array_mut)
                .ok_or_else(|| undo_conflict("列表字段已被改变"))?;
            let item_index = items
                .iter()
                .position(|item| list_item_id(field, item) == *item_id && item == value)
                .ok_or_else(|| undo_conflict("新增的列表项已不存在或已变化"))?;
            items.remove(item_index);
            preset.revision += 1;
            let revision = preset.revision;
            let result = json!(preset.clone());
            state.preset_revision += 1;
            Ok((result, Some(revision)))
        }
        UndoPayload::PresetItemRemove {
            preset_id,
            field,
            item_id,
            value,
            index,
        } => {
            let (preset_type, preset_index) = find_preset_location(state, preset_id)?;
            let preset = &mut state.presets.get_mut(&preset_type).unwrap()[preset_index];
            let items = get_json_path_mut(&mut preset.params, field)
                .and_then(Value::as_array_mut)
                .ok_or_else(|| undo_conflict("列表字段已被改变"))?;
            if items
                .iter()
                .any(|item| list_item_id(field, item) == *item_id)
            {
                return Err(undo_conflict("被移除列表项的 ID 已被重新占用"));
            }
            items.insert((*index).min(items.len()), value.clone());
            preset.revision += 1;
            let revision = preset.revision;
            let result = json!(preset.clone());
            state.preset_revision += 1;
            Ok((result, Some(revision)))
        }
        UndoPayload::Workflow {
            preset_id,
            before,
            after,
        } => {
            let (preset_type, index) = find_preset_location(state, preset_id)?;
            let preset = &mut state.presets.get_mut(&preset_type).unwrap()[index];
            if preset.params != *after {
                return Err(undo_conflict("流程已被后续操作修改"));
            }
            preset.params = before.clone();
            preset.revision += 1;
            let revision = preset.revision;
            let result = json!(preset.clone());
            state.preset_revision += 1;
            Ok((result, Some(revision)))
        }
        UndoPayload::SourceAdd { source } => {
            let index = state
                .sources
                .iter()
                .position(|current| current.id == source.id)
                .ok_or_else(|| undo_conflict("新增的素材已不存在"))?;
            if state.sources[index] != *source {
                return Err(undo_conflict("新增的素材已被后续操作修改"));
            }
            state.sources.remove(index);
            state
                .selected_paths
                .retain(|path| !path_belongs_to(path, &source.path));
            state
                .selected_source_paths
                .retain(|path| !path_belongs_to(path, &source.path));
            state.source_revision += 1;
            Ok((json!({ "removedSourceId": source.id }), None))
        }
        UndoPayload::SourceRemove {
            source,
            index,
            selected_paths,
            selected_source_paths,
        } => {
            if state
                .sources
                .iter()
                .any(|current| current.id == source.id || same_path(&current.path, &source.path))
            {
                return Err(undo_conflict("被移除素材的位置已被重新占用"));
            }
            state
                .sources
                .insert((*index).min(state.sources.len()), source.clone());
            for path in selected_paths {
                if !state
                    .selected_paths
                    .iter()
                    .any(|current| same_path(current, path))
                {
                    state.selected_paths.push(path.clone());
                }
            }
            for path in selected_source_paths {
                if !state
                    .selected_source_paths
                    .iter()
                    .any(|current| same_path(current, path))
                {
                    state.selected_source_paths.push(path.clone());
                }
            }
            state.source_revision += 1;
            Ok((json!(source), Some(source.revision)))
        }
        UndoPayload::SourceSelect {
            source_id,
            before,
            after,
        } => {
            let source = state
                .sources
                .iter_mut()
                .find(|source| source.id == *source_id)
                .ok_or_else(|| undo_conflict("素材已不存在"))?;
            if source.selected != *after {
                return Err(undo_conflict("素材勾选状态已被后续操作修改"));
            }
            source.selected = *before;
            source.revision += 1;
            let revision = source.revision;
            let path = source.path.clone();
            let result = json!(source.clone());
            if *before {
                if !state
                    .selected_paths
                    .iter()
                    .any(|item| same_path(item, &path))
                {
                    state.selected_paths.push(path.clone());
                }
                if !state
                    .selected_source_paths
                    .iter()
                    .any(|item| same_path(item, &path))
                {
                    state.selected_source_paths.push(path);
                }
            } else {
                state
                    .selected_paths
                    .retain(|item| !path_belongs_to(item, &path));
                state
                    .selected_source_paths
                    .retain(|item| !path_belongs_to(item, &path));
            }
            state.source_revision += 1;
            Ok((result, Some(revision)))
        }
        UndoPayload::TaskStart { task_id } => undo_task_start(state, task_id),
    }
}

fn undo_task_start(
    state: &mut StoredState,
    task_id: &str,
) -> Result<(Value, Option<i64>), ServiceFailure> {
    let index = state
        .tasks
        .iter()
        .position(|task| task.id == task_id)
        .ok_or_else(|| undo_conflict("任务记录已不存在"))?;
    let status = state.tasks[index].status.clone();
    match status.as_str() {
        "requested" | "running" | "cancel_requested" => {
            let task = &mut state.tasks[index];
            task.status = "cancel_requested".into();
            task.detail = "Agent 已撤回任务，正在终止".into();
            task.revision += 1;
            Ok((json!(task.clone()), Some(task.revision)))
        }
        "completed" => {
            let hashes = state
                .task_output_hashes
                .get(task_id)
                .cloned()
                .ok_or_else(|| {
                    ServiceFailure::new(
                        error_code::OUTPUT_CHANGED,
                        "任务没有可验证的输出哈希，拒绝删除",
                    )
                })?;
            for (path, expected_hash) in &hashes {
                let path_ref = Path::new(path);
                if !path_ref.is_file() || hash_file(path_ref)? != *expected_hash {
                    return Err(ServiceFailure::new(
                        error_code::OUTPUT_CHANGED,
                        format!("任务输出已变化，拒绝撤回: {path}"),
                    ));
                }
            }
            remove_outputs_transactionally(hashes.keys().map(PathBuf::from).collect())?;
            let task = &mut state.tasks[index];
            task.status = "undone".into();
            task.detail = "Agent 已撤回任务并移除未修改输出".into();
            task.revision += 1;
            state.task_output_hashes.remove(task_id);
            Ok((json!(task.clone()), Some(task.revision)))
        }
        "failed" | "canceled" => {
            let mut task = state.tasks.remove(index);
            task.status = "undone".into();
            state.task_output_hashes.remove(task_id);
            Ok((json!(task), None))
        }
        _ => Err(undo_conflict(format!("任务状态 {status} 不能撤回"))),
    }
}

fn remove_outputs_transactionally(paths: Vec<PathBuf>) -> Result<(), ServiceFailure> {
    let token = new_id("undo");
    let mut staged = Vec::new();
    for path in paths {
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| ServiceFailure::new(error_code::OUTPUT_CHANGED, "输出文件名无效"))?;
        let staged_path = path.with_file_name(format!(".{name}.{token}.pending-delete"));
        if staged_path.exists() {
            rollback_staged_outputs(&staged);
            return Err(ServiceFailure::new(
                error_code::OUTPUT_CHANGED,
                format!("撤回暂存路径已存在: {}", staged_path.display()),
            ));
        }
        if let Err(error) = std::fs::rename(&path, &staged_path) {
            rollback_staged_outputs(&staged);
            return Err(ServiceFailure::new(
                error_code::OUTPUT_CHANGED,
                format!("无法暂存任务输出 {}: {error}", path.display()),
            ));
        }
        staged.push((path, staged_path));
    }
    for (original, staged_path) in &staged {
        if let Err(error) = std::fs::remove_file(staged_path) {
            rollback_staged_outputs(&staged);
            return Err(ServiceFailure::new(
                error_code::OUTPUT_CHANGED,
                format!("无法删除任务输出 {}: {error}", original.display()),
            ));
        }
    }
    Ok(())
}

fn rollback_staged_outputs(staged: &[(PathBuf, PathBuf)]) {
    for (original, staged_path) in staged.iter().rev() {
        if staged_path.exists() && !original.exists() {
            let _ = std::fs::rename(staged_path, original);
        }
    }
}

fn undo_conflict(message: impl Into<String>) -> ServiceFailure {
    ServiceFailure::new(error_code::UNDO_CONFLICT, message)
}

fn get_json_path<'a>(value: &'a Value, path: &str) -> Option<&'a Value> {
    let mut current = value;
    for segment in path.split('.') {
        current = current.get(segment)?;
    }
    Some(current)
}

fn get_json_path_mut<'a>(value: &'a mut Value, path: &str) -> Option<&'a mut Value> {
    let mut current = value;
    for segment in path.split('.') {
        current = current.get_mut(segment)?;
    }
    Some(current)
}

fn set_json_path(value: &mut Value, path: &str, next: Value) -> Result<(), ServiceFailure> {
    let segments: Vec<&str> = path.split('.').collect();
    let (last, parents) = segments
        .split_last()
        .ok_or_else(|| ServiceFailure::validation("字段路径不能为空"))?;
    let mut current = value;
    for segment in parents {
        let object = current
            .as_object_mut()
            .ok_or_else(|| ServiceFailure::validation("字段父路径不是对象"))?;
        current = object
            .entry((*segment).to_string())
            .or_insert_with(|| Value::Object(Map::new()));
    }
    current
        .as_object_mut()
        .ok_or_else(|| ServiceFailure::validation("预设参数不是对象"))?
        .insert((*last).to_string(), next);
    Ok(())
}

fn remove_json_path(value: &mut Value, path: &str) -> Result<(), ServiceFailure> {
    let segments: Vec<&str> = path.split('.').collect();
    let (last, parents) = segments
        .split_last()
        .ok_or_else(|| ServiceFailure::validation("字段路径不能为空"))?;
    let mut current = value;
    for segment in parents {
        current = current
            .get_mut(*segment)
            .ok_or_else(|| ServiceFailure::validation("字段父路径不存在"))?;
    }
    current
        .as_object_mut()
        .ok_or_else(|| ServiceFailure::validation("字段父路径不是对象"))?
        .remove(*last);
    Ok(())
}

fn list_item_id(field: &str, value: &Value) -> String {
    let canonical = serde_json::to_string(value).unwrap_or_default();
    format!(
        "li_{:016x}",
        stable_hash(format!("{field}\0{canonical}").as_bytes())
    )
}

fn display_value(value: &Value) -> String {
    let serialized = match value {
        Value::String(value) => value.clone(),
        _ => value.to_string(),
    };
    if serialized.chars().count() > 80 {
        format!("{}...", serialized.chars().take(77).collect::<String>())
    } else {
        serialized
    }
}

fn new_id(prefix: &str) -> String {
    let counter = ID_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!(
        "{prefix}_{:x}_{:x}_{:x}",
        now_ms(),
        std::process::id(),
        counter
    )
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(
        request_id: impl Into<String>,
        session_id: &str,
        expected_revision: Option<i64>,
        command: AgentCommand,
    ) -> AgentRequest {
        AgentRequest {
            protocol_version: PROTOCOL_VERSION,
            request_id: request_id.into(),
            actor: Actor::Agent,
            session_id: session_id.into(),
            expected_revision,
            command,
        }
    }

    fn gui_request(request_id: &str, command: AgentCommand) -> AgentRequest {
        AgentRequest {
            protocol_version: PROTOCOL_VERSION,
            request_id: request_id.into(),
            actor: Actor::Gui,
            session_id: "gui-test".into(),
            expected_revision: None,
            command,
        }
    }

    #[test]
    fn output_hashing_fits_a_small_ui_thread_stack() {
        let path = std::env::temp_dir().join(format!("shadowencoder-hash-{}.txt", std::process::id()));
        std::fs::write(&path, b"abc").unwrap();
        let input = path.clone();
        let hash = std::thread::Builder::new().stack_size(128 * 1024)
            .spawn(move || hash_file(&input).unwrap()).unwrap().join().unwrap();
        std::fs::remove_file(path).unwrap();
        assert_eq!(hash, "900150983cd24fb0d6963f7d28e17f72");
    }

    fn create_preset(
        service: &AgentService,
        request_id: &str,
        session_id: &str,
        name: &str,
    ) -> PresetSnapshot {
        create_preset_of_type(service, request_id, session_id, "encode", name)
    }

    fn create_preset_of_type(
        service: &AgentService,
        request_id: &str,
        session_id: &str,
        preset_type: &str,
        name: &str,
    ) -> PresetSnapshot {
        let response = service.handle(request(
            request_id,
            session_id,
            None,
            AgentCommand::PresetCreate {
                preset_type: preset_type.into(),
                name: name.into(),
            },
        ));
        assert!(response.ok, "{:?}", response.error);
        serde_json::from_value(response.result.unwrap()).unwrap()
    }

    #[test]
    fn repeated_request_id_is_idempotent() {
        let service = AgentService::open_in_memory();
        let stored_request = request(
            "same-request",
            "session-a",
            None,
            AgentCommand::PresetCreate {
                preset_type: "encode".into(),
                name: "代理".into(),
            },
        );
        let first = service.handle(stored_request.clone());
        let second = service.handle(stored_request);
        assert!(first.ok && second.ok);
        assert_eq!(
            first.receipt.unwrap().sequence,
            second.receipt.unwrap().sequence
        );

        let list = service.handle(request(
            "list-request",
            "session-a",
            None,
            AgentCommand::PresetList {
                preset_type: Some("encode".into()),
            },
        ));
        assert_eq!(list.result.unwrap().as_array().unwrap().len(), 1);
    }

    #[test]
    fn script_and_material_nodes_support_revision_undo_and_completeness_checks() {
        let service = AgentService::open_in_memory();
        let workflow = create_preset_of_type(&service, "create-script-workflow", "script-session", "workflow", "Script");
        let add = service.handle(request("add-script", "script-session", Some(workflow.revision),
            AgentCommand::WorkflowNodeAdd { workflow_id: workflow.id.clone(), kind: "script".into() }));
        assert!(add.ok, "{:?}", add.error);
        let node_id = add.result.as_ref().unwrap().pointer("/change/nodeId").unwrap().as_str().unwrap().to_string();
        let revision = add.receipt.unwrap().entity_revision.unwrap();
        let set = service.handle(request("write-script", "script-session", Some(revision),
            AgentCommand::WorkflowNodeSet { workflow_id: workflow.id.clone(), node_id: node_id.clone(), field: "script".into(),
                value: json!("return {filterComplex:'[0:v]null[out]',duration:1};") }));
        assert!(set.ok, "{:?}", set.error);
        let stale = service.handle(request("stale-script", "script-session", Some(revision),
            AgentCommand::WorkflowNodeSet { workflow_id: workflow.id.clone(), node_id, field: "script".into(), value: json!("bad") }));
        assert_eq!(stale.error.unwrap().code, error_code::REVISION_CONFLICT);
        let undo = service.handle(request("undo-script", "script-session", None, AgentCommand::Undo));
        assert!(undo.ok, "{:?}", undo.error);
        let check = service.handle(request("validate-script", "script-session", None, AgentCommand::WorkflowValidate { workflow_id: workflow.id }));
        assert_eq!(check.error.unwrap().code, error_code::VALIDATION_ERROR);
        let params = json!({"graph": {"startEnabled":false,"nodes":[
            {"id":"m","type":"material","path":"clip.mov"},
            {"id":"s","type":"script","script":"return {};"},
            {"id":"c","type":"action","kind":"transcode","presetId":"encode","presetRevision":1},
            {"id":"o","type":"output","output":{"mode":"collect"}}
        ],"edges":[
            {"id":"e1","source":"m","sourcePort":"media","target":"s","targetPort":"media"},
            {"id":"e2","source":"s","sourcePort":"media","target":"c","targetPort":"media"},
            {"id":"e3","source":"c","sourcePort":"media","target":"o","targetPort":"media"}
        ]}});
        assert!(validate_workflow_graph_structure(&params, true).is_ok());
    }

    #[test]
    fn stale_revision_is_rejected() {
        let service = AgentService::open_in_memory();
        let preset = create_preset(&service, "create", "session-a", "代理");
        let changed = service.handle(request(
            "set-crf",
            "session-a",
            Some(preset.revision),
            AgentCommand::PresetSetField {
                preset_id: preset.id.clone(),
                field: "crf".into(),
                value: json!(20),
            },
        ));
        assert!(changed.ok);

        let stale = service.handle(request(
            "rename-stale",
            "session-a",
            Some(preset.revision),
            AgentCommand::PresetRename {
                preset_id: preset.id,
                name: "过期写入".into(),
            },
        ));
        assert!(!stale.ok);
        assert_eq!(stale.error.unwrap().code, error_code::REVISION_CONFLICT);
    }

    #[test]
    fn undo_refuses_to_overwrite_later_field_change() {
        let service = AgentService::open_in_memory();
        let preset = create_preset(&service, "create-a", "session-a", "代理");
        let first = service.handle(request(
            "set-a",
            "session-a",
            Some(preset.revision),
            AgentCommand::PresetSetField {
                preset_id: preset.id.clone(),
                field: "crf".into(),
                value: json!(20),
            },
        ));
        let revision = first.receipt.unwrap().entity_revision.unwrap();
        let second = service.handle(request(
            "set-b",
            "session-b",
            Some(revision),
            AgentCommand::PresetSetField {
                preset_id: preset.id,
                field: "crf".into(),
                value: json!(18),
            },
        ));
        assert!(second.ok);

        let undo = service.handle(request("undo-a", "session-a", None, AgentCommand::Undo));
        assert!(!undo.ok);
        assert_eq!(undo.error.unwrap().code, error_code::UNDO_CONFLICT);
    }

    #[test]
    fn journal_retains_only_latest_twenty_agent_operations() {
        let service = AgentService::open_in_memory();
        for index in 0..21 {
            create_preset(
                &service,
                &format!("create-{index}"),
                "session-a",
                &format!("预设 {index}"),
            );
        }
        let history = service.handle(request(
            "history",
            "session-a",
            None,
            AgentCommand::HistoryList,
        ));
        let operations: Vec<OperationSnapshot> =
            serde_json::from_value(history.result.unwrap()).unwrap();
        assert_eq!(operations.len(), 20);
        assert!(operations
            .iter()
            .all(|operation| operation.summary != "创建encode预设“预设 0”"));
    }

    #[test]
    fn task_captures_preset_revision_and_cancel_cannot_be_overwritten() {
        let service = AgentService::open_in_memory();
        let preset = create_preset(&service, "create-task-preset", "session-a", "代理任务");
        let source_path =
            std::env::temp_dir().join(format!("shadowencoder-agent-{}.mov", new_id("test")));
        std::fs::write(&source_path, b"test-media").unwrap();

        let added = service.handle(request(
            "add-task-source",
            "session-a",
            None,
            AgentCommand::SourceAdd {
                path: source_path.to_string_lossy().into_owned(),
            },
        ));
        let source: SourceSnapshot = serde_json::from_value(added.result.unwrap()).unwrap();
        let selected = service.handle(request(
            "select-task-source",
            "session-a",
            Some(source.revision),
            AgentCommand::SourceSelect {
                source_id: source.id,
            },
        ));
        assert!(selected.ok, "{:?}", selected.error);

        let started = service.handle(request(
            "start-task",
            "session-a",
            Some(preset.revision),
            AgentCommand::TaskStart {
                function: "encode".into(),
                preset_id: preset.id.clone(),
                scope: "selected".into(),
            },
        ));
        assert!(started.ok, "{:?}", started.error);
        let task: TaskSnapshot = serde_json::from_value(started.result.unwrap()).unwrap();
        assert_eq!(task.preset_revision, preset.revision);
        assert_eq!(task.preset_snapshots, vec![preset.clone()]);

        let running = service.handle(gui_request(
            "run-task",
            AgentCommand::TaskGuiUpdate {
                task_id: task.id.clone(),
                status: "running".into(),
                progress: Some(10.0),
                detail: Some("运行中".into()),
                output_paths: None,
                error: None,
            },
        ));
        assert!(running.ok, "{:?}", running.error);

        let canceled = service.handle(request(
            "cancel-task",
            "session-a",
            None,
            AgentCommand::TaskCancel {
                task_id: task.id.clone(),
            },
        ));
        assert!(canceled.ok, "{:?}", canceled.error);

        let stale_progress = service.handle(gui_request(
            "stale-progress",
            AgentCommand::TaskGuiUpdate {
                task_id: task.id.clone(),
                status: "running".into(),
                progress: Some(20.0),
                detail: Some("不应覆盖取消".into()),
                output_paths: None,
                error: None,
            },
        ));
        assert!(!stale_progress.ok);
        assert_eq!(
            stale_progress.error.unwrap().code,
            error_code::VALIDATION_ERROR
        );

        let terminal = service.handle(gui_request(
            "finish-cancel",
            AgentCommand::TaskGuiUpdate {
                task_id: task.id,
                status: "canceled".into(),
                progress: Some(10.0),
                detail: Some("任务已取消".into()),
                output_paths: Some(Vec::new()),
                error: None,
            },
        ));
        assert!(terminal.ok, "{:?}", terminal.error);
        let _ = std::fs::remove_file(source_path);
    }

    #[test]
    fn check_task_captures_referenced_encode_preset() {
        let service = AgentService::open_in_memory();
        let encode = create_preset_of_type(
            &service,
            "create-check-reference",
            "session-a",
            "encode",
            "检测规范",
        );
        let check = create_preset_of_type(
            &service,
            "create-check-preset",
            "session-a",
            "check",
            "素材检测",
        );
        let configured = service.handle(request(
            "set-check-reference",
            "session-a",
            Some(check.revision),
            AgentCommand::PresetSetField {
                preset_id: check.id.clone(),
                field: "refEncPresetId".into(),
                value: json!(encode.id.clone()),
            },
        ));
        assert!(configured.ok, "{:?}", configured.error);
        let configured_check: PresetSnapshot =
            serde_json::from_value(configured.result.unwrap()).unwrap();

        let source_path =
            std::env::temp_dir().join(format!("shadowencoder-agent-{}.mov", new_id("check")));
        std::fs::write(&source_path, b"test-media").unwrap();
        let added = service.handle(request(
            "add-check-source",
            "session-a",
            None,
            AgentCommand::SourceAdd {
                path: source_path.to_string_lossy().into_owned(),
            },
        ));
        let source: SourceSnapshot = serde_json::from_value(added.result.unwrap()).unwrap();
        let selected = service.handle(request(
            "select-check-source",
            "session-a",
            Some(source.revision),
            AgentCommand::SourceSelect {
                source_id: source.id,
            },
        ));
        assert!(selected.ok, "{:?}", selected.error);

        let started = service.handle(request(
            "start-check-task",
            "session-a",
            Some(configured_check.revision),
            AgentCommand::TaskStart {
                function: "check".into(),
                preset_id: configured_check.id.clone(),
                scope: "selected".into(),
            },
        ));
        assert!(started.ok, "{:?}", started.error);
        let task: TaskSnapshot = serde_json::from_value(started.result.unwrap()).unwrap();
        assert_eq!(task.preset_snapshots.len(), 2);
        assert_eq!(task.preset_snapshots[0], configured_check);
        assert!(task
            .preset_snapshots
            .iter()
            .any(|preset| preset.id == encode.id && preset.preset_type == "encode"));

        let _ = std::fs::remove_file(source_path);
    }

    #[test]
    fn workflow_graph_supports_fanout_and_rejects_invalid_connections() {
        let service = AgentService::open_in_memory();
        let workflow = create_preset_of_type(
            &service,
            "create-graph-workflow",
            "session-a",
            "workflow",
            "并行流程",
        );
        let add_node = |request_id: &str, revision: i64| {
            service.handle(request(
                request_id,
                "session-a",
                Some(revision),
                AgentCommand::WorkflowNodeAdd {
                    workflow_id: workflow.id.clone(),
                    kind: "filter".into(),
                },
            ))
        };
        let first = add_node("add-filter-a", workflow.revision);
        assert!(first.ok, "{:?}", first.error);
        let first_id = first.result.as_ref().unwrap()["change"]["nodeId"]
            .as_str()
            .unwrap()
            .to_string();
        let first_revision = first.receipt.unwrap().entity_revision.unwrap();
        let second = add_node("add-filter-b", first_revision);
        assert!(second.ok, "{:?}", second.error);
        let second_id = second.result.as_ref().unwrap()["change"]["nodeId"]
            .as_str()
            .unwrap()
            .to_string();
        let mut revision = second.receipt.unwrap().entity_revision.unwrap();

        for (request_id, target) in [
            ("connect-start-a", first_id.as_str()),
            ("connect-start-b", second_id.as_str()),
        ] {
            let connected = service.handle(request(
                request_id,
                "session-a",
                Some(revision),
                AgentCommand::WorkflowEdgeAdd {
                    workflow_id: workflow.id.clone(),
                    source: WORKFLOW_START_ID.into(),
                    source_port: "media".into(),
                    target: target.into(),
                    target_port: "media".into(),
                },
            ));
            assert!(connected.ok, "{:?}", connected.error);
            revision = connected.receipt.unwrap().entity_revision.unwrap();
        }

        let chain = service.handle(request(
            "connect-a-b",
            "session-a",
            Some(revision),
            AgentCommand::WorkflowEdgeAdd {
                workflow_id: workflow.id.clone(),
                source: first_id.clone(),
                source_port: "media".into(),
                target: second_id.clone(),
                target_port: "media".into(),
            },
        ));
        assert!(chain.ok, "{:?}", chain.error);
        revision = chain.receipt.unwrap().entity_revision.unwrap();

        let cycle = service.handle(request(
            "connect-cycle",
            "session-a",
            Some(revision),
            AgentCommand::WorkflowEdgeAdd {
                workflow_id: workflow.id.clone(),
                source: second_id.clone(),
                source_port: "media".into(),
                target: first_id.clone(),
                target_port: "media".into(),
            },
        ));
        assert!(!cycle.ok);
        assert_eq!(cycle.error.unwrap().code, error_code::VALIDATION_ERROR);

        let invalid_port = service.handle(request(
            "connect-invalid-port",
            "session-a",
            Some(revision),
            AgentCommand::WorkflowEdgeAdd {
                workflow_id: workflow.id.clone(),
                source: WORKFLOW_START_ID.into(),
                source_port: "media".into(),
                target: first_id.clone(),
                target_port: "condition".into(),
            },
        ));
        assert!(!invalid_port.ok);

        let removed = service.handle(request(
            "remove-filter-a",
            "session-a",
            Some(revision),
            AgentCommand::WorkflowNodeRemove {
                workflow_id: workflow.id,
                node_id: first_id,
            },
        ));
        assert!(removed.ok, "{:?}", removed.error);
        let preset = &removed.result.as_ref().unwrap()["preset"];
        assert_eq!(
            preset
                .pointer("/params/graph/nodes")
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            preset
                .pointer("/params/graph/edges")
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn workflow_task_rejects_stale_child_revision_then_captures_child_snapshot() {
        let service = AgentService::open_in_memory();
        let encode = create_preset_of_type(
            &service,
            "create-workflow-encode",
            "session-a",
            "encode",
            "代理转码",
        );
        let workflow = create_preset_of_type(
            &service,
            "create-workflow",
            "session-a",
            "workflow",
            "代理流程",
        );
        let added_node = service.handle(request(
            "add-workflow-node",
            "session-a",
            Some(workflow.revision),
            AgentCommand::WorkflowNodeAdd {
                workflow_id: workflow.id.clone(),
                kind: "transcode".into(),
            },
        ));
        assert!(added_node.ok, "{:?}", added_node.error);
        let node_id = added_node
            .result
            .as_ref()
            .and_then(|result| result.pointer("/change/nodeId"))
            .and_then(Value::as_str)
            .unwrap()
            .to_string();
        let mut workflow_revision = added_node.receipt.unwrap().entity_revision.unwrap();

        let set_id = service.handle(request(
            "set-workflow-preset-id",
            "session-a",
            Some(workflow_revision),
            AgentCommand::WorkflowNodeSet {
                workflow_id: workflow.id.clone(),
                node_id: node_id.clone(),
                field: "presetId".into(),
                value: json!(encode.id.clone()),
            },
        ));
        assert!(set_id.ok, "{:?}", set_id.error);
        workflow_revision = set_id.receipt.unwrap().entity_revision.unwrap();

        let connected = service.handle(request(
            "connect-workflow-input",
            "session-a",
            Some(workflow_revision),
            AgentCommand::WorkflowEdgeAdd {
                workflow_id: workflow.id.clone(),
                source: WORKFLOW_START_ID.into(),
                source_port: "media".into(),
                target: node_id.clone(),
                target_port: "media".into(),
            },
        ));
        assert!(connected.ok, "{:?}", connected.error);
        workflow_revision = connected.receipt.unwrap().entity_revision.unwrap();

        let added_output = service.handle(request("add-output", "session-a", Some(workflow_revision),
            AgentCommand::WorkflowNodeAdd { workflow_id: workflow.id.clone(), kind: "output".into() }));
        assert!(added_output.ok, "{:?}", added_output.error);
        let output_id = added_output.result.as_ref().unwrap().pointer("/change/nodeId").unwrap().as_str().unwrap().to_string();
        workflow_revision = added_output.receipt.unwrap().entity_revision.unwrap();
        let connected_output = service.handle(request("connect-output", "session-a", Some(workflow_revision),
            AgentCommand::WorkflowEdgeAdd { workflow_id: workflow.id.clone(), source: node_id.clone(), source_port: "media".into(), target: output_id, target_port: "media".into() }));
        assert!(connected_output.ok, "{:?}", connected_output.error);
        workflow_revision = connected_output.receipt.unwrap().entity_revision.unwrap();

        let changed_encode = service.handle(request(
            "update-workflow-encode",
            "session-a",
            Some(encode.revision),
            AgentCommand::PresetSetField {
                preset_id: encode.id.clone(),
                field: "crf".into(),
                value: json!(20),
            },
        ));
        assert!(changed_encode.ok, "{:?}", changed_encode.error);
        let changed_encode: PresetSnapshot =
            serde_json::from_value(changed_encode.result.unwrap()).unwrap();

        let source_path =
            std::env::temp_dir().join(format!("shadowencoder-agent-{}.mov", new_id("workflow")));
        std::fs::write(&source_path, b"test-media").unwrap();
        let added = service.handle(request(
            "add-workflow-source",
            "session-a",
            None,
            AgentCommand::SourceAdd {
                path: source_path.to_string_lossy().into_owned(),
            },
        ));
        let source: SourceSnapshot = serde_json::from_value(added.result.unwrap()).unwrap();
        let selected = service.handle(request(
            "select-workflow-source",
            "session-a",
            Some(source.revision),
            AgentCommand::SourceSelect {
                source_id: source.id,
            },
        ));
        assert!(selected.ok, "{:?}", selected.error);

        let stale = service.handle(request(
            "start-stale-workflow",
            "session-a",
            Some(workflow_revision),
            AgentCommand::TaskStart {
                function: "workflow".into(),
                preset_id: workflow.id.clone(),
                scope: "selected".into(),
            },
        ));
        assert!(!stale.ok);
        assert_eq!(stale.error.unwrap().code, error_code::REVISION_CONFLICT);

        let sync_revision = service.handle(request(
            "sync-workflow-preset-revision",
            "session-a",
            Some(workflow_revision),
            AgentCommand::WorkflowNodeSet {
                workflow_id: workflow.id.clone(),
                node_id,
                field: "presetRevision".into(),
                value: json!(changed_encode.revision),
            },
        ));
        assert!(sync_revision.ok, "{:?}", sync_revision.error);
        workflow_revision = sync_revision.receipt.unwrap().entity_revision.unwrap();

        let started = service.handle(request(
            "start-synced-workflow",
            "session-a",
            Some(workflow_revision),
            AgentCommand::TaskStart {
                function: "workflow".into(),
                preset_id: workflow.id,
                scope: "selected".into(),
            },
        ));
        assert!(started.ok, "{:?}", started.error);
        let task: TaskSnapshot = serde_json::from_value(started.result.unwrap()).unwrap();
        assert_eq!(task.preset_snapshots.len(), 2);
        assert!(task.preset_snapshots.iter().any(|preset| {
            preset.id == changed_encode.id && preset.revision == changed_encode.revision
        }));

        let _ = std::fs::remove_file(source_path);
    }
}
