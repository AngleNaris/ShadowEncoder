use serde_json::{json, Value};
use shadowencoder_agent_protocol::{
    error_code, local_endpoint_name, Actor, AgentCommand, AgentEvent, AgentRequest, AgentResponse,
    MAX_MESSAGE_BYTES, PROTOCOL_VERSION,
};
use std::io::{BufRead, BufReader, Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const SKILL: &str = include_str!("../resources/shadowencoder-cli-skill.md");
static REQUEST_COUNTER: AtomicU64 = AtomicU64::new(1);

enum ParsedCommand {
    Local(String),
    Request(AgentCommand, Option<i64>),
    Watch(Option<i64>),
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let parsed = match parse_args(&args) {
        Ok(parsed) => parsed,
        Err(message) => {
            print_local_error(&message);
            std::process::exit(2);
        }
    };
    match parsed {
        ParsedCommand::Local(text) => print!("{text}"),
        ParsedCommand::Request(command, expected_revision) => {
            let response = send(command, expected_revision);
            print_response(&response);
            if !response.ok {
                std::process::exit(2);
            }
        }
        ParsedCommand::Watch(after) => {
            if let Err(response) = watch(after) {
                print_response(&response);
                std::process::exit(2);
            }
        }
    }
}

fn parse_args(args: &[String]) -> Result<ParsedCommand, String> {
    if args.is_empty() || args == ["help"] {
        return Ok(ParsedCommand::Local(SKILL.to_string()));
    }
    if args == ["--version"] || args == ["version"] {
        return Ok(ParsedCommand::Local(format!(
            "shadowencoder-cli {} (protocol {})\n",
            env!("CARGO_PKG_VERSION"),
            PROTOCOL_VERSION
        )));
    }
    let args = strip_output_flags(args);
    let words = args.iter().map(String::as_str).collect::<Vec<_>>();
    match words.as_slice() {
        ["help"] => Ok(ParsedCommand::Local(SKILL.to_string())),
        ["help", "command", command @ ..] if !command.is_empty() => Ok(ParsedCommand::Local(
            command_help(&command.join(" ")).to_string(),
        )),
        ["status"] => Ok(request(AgentCommand::Status, None)),
        ["schema", "list"] => Ok(request(AgentCommand::SchemaList, None)),
        ["schema", "show", function] => Ok(request(
            AgentCommand::SchemaShow {
                function: (*function).to_string(),
            },
            None,
        )),
        ["preset", "show", preset_id] => Ok(request(
            AgentCommand::PresetShow {
                preset_id: (*preset_id).to_string(),
            },
            None,
        )),
        ["source", "list"] => Ok(request(AgentCommand::SourceList, None)),
        ["task", "list"] => Ok(request(AgentCommand::TaskList, None)),
        ["task", "show", task_id] => Ok(request(
            AgentCommand::TaskShow {
                task_id: (*task_id).to_string(),
            },
            None,
        )),
        ["history", "list"] => Ok(request(AgentCommand::HistoryList, None)),
        ["undo"] => Ok(request(AgentCommand::Undo, None)),
        ["watch", rest @ ..] => {
            let after = optional_i64_flag(rest, "--after")?;
            ensure_only_flags(rest, &["--after"])?;
            Ok(ParsedCommand::Watch(after))
        }
        ["preset", "list", rest @ ..] => {
            let preset_type = optional_flag(rest, "--type")?.map(str::to_string);
            ensure_only_flags(rest, &["--type"])?;
            Ok(request(AgentCommand::PresetList { preset_type }, None))
        }
        ["preset", "create", rest @ ..] => {
            let preset_type = required_flag(rest, "--type")?;
            let name = required_flag(rest, "--name")?;
            ensure_only_flags(rest, &["--type", "--name"])?;
            Ok(request(
                AgentCommand::PresetCreate {
                    preset_type: preset_type.to_string(),
                    name: name.to_string(),
                },
                None,
            ))
        }
        ["preset", "rename", preset_id, name, rest @ ..] => Ok(request(
            AgentCommand::PresetRename {
                preset_id: (*preset_id).to_string(),
                name: (*name).to_string(),
            },
            Some(required_revision(rest)?),
        )),
        ["preset", "set", preset_id, field, value, rest @ ..] => Ok(request(
            AgentCommand::PresetSetField {
                preset_id: (*preset_id).to_string(),
                field: (*field).to_string(),
                value: parse_scalar(value)?,
            },
            Some(required_revision(rest)?),
        )),
        ["preset", "item-add", preset_id, field, value, rest @ ..] => Ok(request(
            AgentCommand::PresetItemAdd {
                preset_id: (*preset_id).to_string(),
                field: (*field).to_string(),
                value: Value::String((*value).to_string()),
            },
            Some(required_revision(rest)?),
        )),
        ["preset", "item-remove", preset_id, field, item_id, rest @ ..] => Ok(request(
            AgentCommand::PresetItemRemove {
                preset_id: (*preset_id).to_string(),
                field: (*field).to_string(),
                item_id: (*item_id).to_string(),
            },
            Some(required_revision(rest)?),
        )),
        ["preset", "delete", preset_id, rest @ ..] => Ok(request(
            AgentCommand::PresetDelete {
                preset_id: (*preset_id).to_string(),
            },
            Some(required_revision(rest)?),
        )),
        ["source", "add", path] => Ok(request(
            AgentCommand::SourceAdd {
                path: (*path).to_string(),
            },
            None,
        )),
        ["source", "remove", source_id, rest @ ..] => Ok(request(
            AgentCommand::SourceRemove {
                source_id: (*source_id).to_string(),
            },
            Some(required_revision(rest)?),
        )),
        ["source", "select", source_id, rest @ ..] => Ok(request(
            AgentCommand::SourceSelect {
                source_id: (*source_id).to_string(),
            },
            Some(required_revision(rest)?),
        )),
        ["source", "unselect", source_id, rest @ ..] => Ok(request(
            AgentCommand::SourceUnselect {
                source_id: (*source_id).to_string(),
            },
            Some(required_revision(rest)?),
        )),
        ["workflow", "step-add", workflow_id, kind, rest @ ..] => {
            let revision = required_i64_flag(rest, "--revision")?;
            let parent_id = optional_flag(rest, "--parent")?.map(str::to_string);
            let branch = optional_flag(rest, "--branch")?.map(str::to_string);
            ensure_only_flags(rest, &["--revision", "--parent", "--branch"])?;
            Ok(request(
                AgentCommand::WorkflowStepAdd {
                    workflow_id: (*workflow_id).to_string(),
                    kind: (*kind).to_string(),
                    parent_id,
                    branch,
                },
                Some(revision),
            ))
        }
        ["workflow", "step-set", workflow_id, step_id, field, value, rest @ ..] => Ok(request(
            AgentCommand::WorkflowStepSet {
                workflow_id: (*workflow_id).to_string(),
                step_id: (*step_id).to_string(),
                field: (*field).to_string(),
                value: parse_scalar(value)?,
            },
            Some(required_revision(rest)?),
        )),
        ["workflow", "step-remove", workflow_id, step_id, rest @ ..] => Ok(request(
            AgentCommand::WorkflowStepRemove {
                workflow_id: (*workflow_id).to_string(),
                step_id: (*step_id).to_string(),
            },
            Some(required_revision(rest)?),
        )),
        ["workflow", "step-move", workflow_id, step_id, after_step_id, rest @ ..] => Ok(request(
            AgentCommand::WorkflowStepMove {
                workflow_id: (*workflow_id).to_string(),
                step_id: (*step_id).to_string(),
                after_step_id: (*after_step_id).to_string(),
            },
            Some(required_revision(rest)?),
        )),
        ["task", "start", function, rest @ ..] => {
            let preset_id = required_flag(rest, "--preset")?;
            let scope = required_flag(rest, "--scope")?;
            let revision = required_i64_flag(rest, "--revision")?;
            ensure_only_flags(rest, &["--preset", "--scope", "--revision"])?;
            Ok(request(
                AgentCommand::TaskStart {
                    function: (*function).to_string(),
                    preset_id: preset_id.to_string(),
                    scope: scope.to_string(),
                },
                Some(revision),
            ))
        }
        ["task", "cancel", task_id] => Ok(request(
            AgentCommand::TaskCancel {
                task_id: (*task_id).to_string(),
            },
            None,
        )),
        _ => Err(format!(
            "未知或不完整的命令：{}。运行 shadowencoder-cli help 查看完整 Skill。",
            args.join(" ")
        )),
    }
}

fn request(command: AgentCommand, expected_revision: Option<i64>) -> ParsedCommand {
    ParsedCommand::Request(command, expected_revision)
}

fn strip_output_flags(args: &[String]) -> Vec<String> {
    args.iter()
        .filter(|value| !matches!(value.as_str(), "--json" | "--jsonl"))
        .cloned()
        .collect()
}

fn required_flag<'a>(args: &'a [&str], flag: &str) -> Result<&'a str, String> {
    optional_flag(args, flag)?.ok_or_else(|| format!("缺少必需参数 {flag}"))
}

fn optional_flag<'a>(args: &'a [&str], flag: &str) -> Result<Option<&'a str>, String> {
    let positions = args
        .iter()
        .enumerate()
        .filter_map(|(index, value)| (*value == flag).then_some(index))
        .collect::<Vec<_>>();
    if positions.len() > 1 {
        return Err(format!("参数 {flag} 不能重复"));
    }
    let Some(index) = positions.first().copied() else {
        return Ok(None);
    };
    let value = args
        .get(index + 1)
        .copied()
        .filter(|value| !value.starts_with("--"))
        .ok_or_else(|| format!("参数 {flag} 缺少值"))?;
    Ok(Some(value))
}

fn required_i64_flag(args: &[&str], flag: &str) -> Result<i64, String> {
    required_flag(args, flag)?
        .parse::<i64>()
        .map_err(|_| format!("参数 {flag} 必须是整数"))
}

fn required_revision(args: &[&str]) -> Result<i64, String> {
    let revision = required_i64_flag(args, "--revision")?;
    ensure_only_flags(args, &["--revision"])?;
    Ok(revision)
}

fn optional_i64_flag(args: &[&str], flag: &str) -> Result<Option<i64>, String> {
    optional_flag(args, flag)?
        .map(|value| {
            value
                .parse::<i64>()
                .map_err(|_| format!("参数 {flag} 必须是整数"))
        })
        .transpose()
}

fn ensure_only_flags(args: &[&str], allowed: &[&str]) -> Result<(), String> {
    let mut index = 0;
    while index < args.len() {
        let flag = args[index];
        if !allowed.contains(&flag) {
            return Err(format!("未知参数: {flag}"));
        }
        if args.get(index + 1).is_none() {
            return Err(format!("参数 {flag} 缺少值"));
        }
        index += 2;
    }
    Ok(())
}

fn parse_scalar(raw: &str) -> Result<Value, String> {
    let value = serde_json::from_str::<Value>(raw).unwrap_or_else(|_| Value::String(raw.into()));
    if value.is_null() || value.is_array() || value.is_object() {
        return Err("一次只能设置字符串、数字或布尔值，不能传入 null、数组或对象".into());
    }
    Ok(value)
}

fn send(command: AgentCommand, expected_revision: Option<i64>) -> AgentResponse {
    let request = build_request(command, expected_revision);
    match send_request(&request) {
        Ok(response) => response,
        Err(message) => {
            AgentResponse::failure(request.request_id, error_code::APP_NOT_RUNNING, message)
        }
    }
}

fn build_request(command: AgentCommand, expected_revision: Option<i64>) -> AgentRequest {
    AgentRequest {
        protocol_version: PROTOCOL_VERSION,
        request_id: new_request_id(),
        actor: Actor::Agent,
        session_id: agent_session_id(),
        expected_revision,
        command,
    }
}

fn agent_session_id() -> String {
    std::env::var("SHADOWENCODER_AGENT_SESSION")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| format!("agent-default-{:016x}", default_identity_hash()))
}

fn default_identity_hash() -> u64 {
    let identity = format!(
        "{}|{}|{}",
        std::env::var("USERDOMAIN").unwrap_or_default(),
        std::env::var("USERNAME").unwrap_or_else(|_| std::env::var("USER").unwrap_or_default()),
        std::env::var("LOCALAPPDATA").unwrap_or_else(|_| std::env::var("HOME").unwrap_or_default()),
    );
    shadowencoder_agent_protocol::stable_hash(identity.as_bytes())
}

fn new_request_id() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let counter = REQUEST_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("req_{now:x}_{:x}_{counter:x}", std::process::id())
}

fn watch(after: Option<i64>) -> Result<(), AgentResponse> {
    let mut sequence = match after {
        Some(sequence) => sequence,
        None => {
            let response = send(AgentCommand::Status, None);
            if !response.ok {
                return Err(response);
            }
            response
                .result
                .as_ref()
                .and_then(|result| result.get("sequence"))
                .and_then(Value::as_i64)
                .unwrap_or(0)
        }
    };
    loop {
        let response = send(AgentCommand::EventsAfter { after: sequence }, None);
        if !response.ok {
            return Err(response);
        }
        let events: Vec<AgentEvent> = match response.result {
            Some(value) => serde_json::from_value(value).map_err(|error| {
                AgentResponse::failure(
                    "watch",
                    error_code::INTERNAL_ERROR,
                    format!("事件响应无效: {error}"),
                )
            })?,
            None => Vec::new(),
        };
        for event in events {
            sequence = sequence.max(event.sequence);
            println!(
                "{}",
                serde_json::to_string(&event).unwrap_or_else(|_| "{}".into())
            );
        }
        std::thread::sleep(Duration::from_millis(400));
    }
}

#[cfg(target_os = "windows")]
fn send_request(request: &AgentRequest) -> Result<AgentResponse, String> {
    use std::fs::OpenOptions;

    let endpoint = local_endpoint_name();
    let mut last_error = None;
    for _ in 0..20 {
        match OpenOptions::new().read(true).write(true).open(&endpoint) {
            Ok(mut pipe) => return exchange(&mut pipe, request),
            Err(error) => {
                last_error = Some(error);
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    }
    Err(format!(
        "ShadowEncoder 未启动或 Agent IPC 不可用 ({endpoint}): {}",
        last_error
            .map(|error| error.to_string())
            .unwrap_or_else(|| "unknown error".into())
    ))
}

#[cfg(unix)]
fn send_request(request: &AgentRequest) -> Result<AgentResponse, String> {
    use std::os::unix::net::UnixStream;

    let endpoint = local_endpoint_name();
    let mut stream = UnixStream::connect(&endpoint).map_err(|error| {
        format!("ShadowEncoder 未启动或 Agent IPC 不可用 ({endpoint}): {error}")
    })?;
    exchange(&mut stream, request)
}

fn exchange<S: Read + Write>(
    stream: &mut S,
    request: &AgentRequest,
) -> Result<AgentResponse, String> {
    serde_json::to_writer(&mut *stream, request)
        .map_err(|error| format!("请求序列化失败: {error}"))?;
    stream
        .write_all(b"\n")
        .and_then(|_| stream.flush())
        .map_err(|error| format!("请求写入失败: {error}"))?;
    let mut reader = BufReader::new(stream);
    let mut payload = Vec::new();
    reader
        .by_ref()
        .take((MAX_MESSAGE_BYTES + 1) as u64)
        .read_until(b'\n', &mut payload)
        .map_err(|error| format!("响应读取失败: {error}"))?;
    if payload.len() > MAX_MESSAGE_BYTES {
        return Err("应用返回了超过 1 MiB 限制的响应".into());
    }
    serde_json::from_slice(&payload).map_err(|error| format!("应用响应 JSON 无效: {error}"))
}

fn print_response(response: &AgentResponse) {
    println!(
        "{}",
        serde_json::to_string_pretty(response).unwrap_or_else(|_| "{}".into())
    );
}

fn print_local_error(message: &str) {
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "ok": false,
            "error": {
                "code": error_code::VALIDATION_ERROR,
                "message": message,
            }
        }))
        .unwrap()
    );
}

fn command_help(command: &str) -> &'static str {
    match command {
        "preset set" => "preset set <preset-id> <field> <value> --revision <n>\n修改一个标量字段。数组和对象会被拒绝。\n",
        "preset item-add" => "preset item-add <preset-id> <field> <value> --revision <n>\n向允许的列表字段添加一项。\n",
        "preset item-remove" => "preset item-remove <preset-id> <field> <item-id> --revision <n>\n按 preset show 返回的 itemId 移除一项。\n",
        "workflow step-add" => "workflow step-add <workflow-id> <kind> --revision <n> [--parent <condition-id> --branch then|else]\n添加一个动作或条件步骤。\n",
        "task start" => "task start <function> --preset <preset-id> --scope selected --revision <n>\n请求 GUI 执行一个非破坏任务。\n",
        "undo" => "undo\n撤回当前 Agent session 最近一个仍可安全撤回的操作。\n",
        _ => "未提供该命令的独立帮助。运行 shadowencoder-cli help 查看完整 Skill。\n",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    #[test]
    fn parser_rejects_bulk_objects() {
        let args = strings(&[
            "preset",
            "set",
            "p1",
            "params",
            "{\"crf\":20}",
            "--revision",
            "1",
        ]);
        assert!(parse_args(&args).is_err());
    }

    #[test]
    fn parser_accepts_one_scalar_field() {
        let args = strings(&["preset", "set", "p1", "crf", "20", "--revision", "7"]);
        let parsed = parse_args(&args).unwrap();
        assert!(matches!(
            parsed,
            ParsedCommand::Request(
                AgentCommand::PresetSetField {
                    value: Value::Number(_),
                    ..
                },
                Some(7)
            )
        ));
    }

    #[test]
    fn help_is_available_without_ipc() {
        let parsed = parse_args(&strings(&["help"])).unwrap();
        match parsed {
            ParsedCommand::Local(text) => assert!(text.contains("# ShadowEncoder Agent CLI")),
            _ => panic!("help must be local"),
        }
    }

    #[test]
    fn skill_commands_match_the_parser_contract() {
        let commands: &[&[&str]] = &[
            &["help"],
            &["help", "command", "preset", "set"],
            &["--version"],
            &["status", "--json"],
            &["watch", "--jsonl", "--after", "7"],
            &["schema", "list", "--json"],
            &["schema", "show", "encode", "--json"],
            &["preset", "list", "--type", "encode", "--json"],
            &["preset", "show", "preset-1", "--json"],
            &["preset", "create", "--type", "encode", "--name", "Proxy"],
            &["preset", "rename", "preset-1", "Proxy", "--revision", "1"],
            &["preset", "set", "preset-1", "crf", "20", "--revision", "1"],
            &[
                "preset",
                "item-add",
                "preset-1",
                "extensions",
                "mov",
                "--revision",
                "1",
            ],
            &[
                "preset",
                "item-remove",
                "preset-1",
                "extensions",
                "item-1",
                "--revision",
                "1",
            ],
            &["preset", "delete", "preset-1", "--revision", "1"],
            &["source", "list", "--json"],
            &["source", "add", "C:\\media\\clip.mov"],
            &["source", "remove", "source-1", "--revision", "1"],
            &["source", "select", "source-1", "--revision", "1"],
            &["source", "unselect", "source-1", "--revision", "1"],
            &[
                "workflow",
                "step-add",
                "workflow-1",
                "backup",
                "--revision",
                "1",
            ],
            &[
                "workflow",
                "step-add",
                "workflow-1",
                "check",
                "--revision",
                "1",
                "--parent",
                "condition-1",
                "--branch",
                "then",
            ],
            &[
                "workflow",
                "step-set",
                "workflow-1",
                "step-1",
                "failureMode",
                "continue",
                "--revision",
                "1",
            ],
            &[
                "workflow",
                "step-remove",
                "workflow-1",
                "step-1",
                "--revision",
                "1",
            ],
            &[
                "workflow",
                "step-move",
                "workflow-1",
                "step-2",
                "step-1",
                "--revision",
                "1",
            ],
            &[
                "task",
                "start",
                "encode",
                "--preset",
                "preset-1",
                "--scope",
                "selected",
                "--revision",
                "1",
            ],
            &["task", "cancel", "task-1"],
            &["task", "list", "--json"],
            &["task", "show", "task-1", "--json"],
            &["history", "list", "--json"],
            &["undo"],
        ];

        for command in commands {
            assert!(
                parse_args(&strings(command)).is_ok(),
                "Skill command is not accepted: {}",
                command.join(" ")
            );
        }
    }
}
