---
name: shadowencoder-cli
description: Operate a running ShadowEncoder instance through its reversible, user-visible local CLI. Use it to inspect media queues, edit presets one field at a time, compose DIT workflows, request supported non-destructive jobs, monitor events, and undo Agent operations.
version: 2
---

# ShadowEncoder Agent CLI

Use `shadowencoder-cli` only with an already running ShadowEncoder application. The Rust command service is the single state authority, while the GUI stays visible, reflects Agent changes, and lets the user interrupt work. Except for `help` and `--version`, commands return `APP_NOT_RUNNING` when the application is closed.

## Mandatory Rules

1. Run `shadowencoder-cli status --json` before the first operation.
2. Run the relevant `show --json` command before a mutation and use its exact current `revision`.
3. Change exactly one field, one list item, one source, one workflow node, or one workflow edge per command.
4. Never look for batch mutation, JSON Patch, import, whole-object replacement, arbitrary FFmpeg arguments, shell execution, overwrite, source deletion, or DIT move behavior. These capabilities are intentionally unavailable.
5. After each write, retain `operationId`, `sequence`, `entityRevision`, and `reversible` from the receipt.
6. On `REVISION_CONFLICT`, read the target again and reassess. Never retry with a guessed revision.
7. On `UNDO_CONFLICT` or `OUTPUT_CHANGED`, stop. Never force an undo over user changes.
8. Run `undo` once per operation. There is no multi-step undo flag.
9. Do not hide or bypass GUI feedback. The user can continue inspecting the queue and can cancel visible work.
10. Do not loop on `APP_NOT_RUNNING`; ask the user to start ShadowEncoder.

## Session Bootstrap

```text
shadowencoder-cli --version
shadowencoder-cli status --json
shadowencoder-cli schema list --json
```

Set one stable session ID for the collaboration:

```text
SHADOWENCODER_AGENT_SESSION=<stable-session-id>
```

When it is absent, the CLI uses a stable current-user default session. Explicit session IDs are preferred when multiple Agents may operate the same application.

## Read Commands

```text
shadowencoder-cli help
shadowencoder-cli help command <command>
shadowencoder-cli --version
shadowencoder-cli status --json
shadowencoder-cli watch --jsonl [--after <sequence>]
shadowencoder-cli schema list --json
shadowencoder-cli schema show <function> --json
shadowencoder-cli preset list [--type <type>] --json
shadowencoder-cli preset show <preset-id> --json
shadowencoder-cli source list --json
shadowencoder-cli task list --json
shadowencoder-cli task show <task-id> --json
shadowencoder-cli history list --json
```

## Preset Commands

```text
shadowencoder-cli preset create --type <type> --name <name>
shadowencoder-cli preset rename <preset-id> <name> --revision <n>
shadowencoder-cli preset set <preset-id> <field> <value> --revision <n>
shadowencoder-cli preset item-add <preset-id> <field> <value> --revision <n>
shadowencoder-cli preset item-remove <preset-id> <field> <item-id> --revision <n>
shadowencoder-cli preset delete <preset-id> --revision <n>
```

`preset set` accepts only a string, number, or boolean. It rejects arrays, objects, and unknown fields. For booleans, pass the unquoted lowercase JSON literals `true` or `false`; `1`, `0`, and quoted `"true"`/`"false"` are not booleans. Read `fieldDefinitions` from `schema show` for each field's exact type, range, unit, and allowed values. Use `item-add` or `item-remove` for one allowed list item. `preset show` exposes stable item IDs for list fields.

## Source Commands

```text
shadowencoder-cli source add <path>
shadowencoder-cli source remove <source-id> --revision <n>
shadowencoder-cli source select <source-id> --revision <n>
shadowencoder-cli source unselect <source-id> --revision <n>
```

Add one existing path per command. Do not use globs or multiple paths. A task captures the selection visible in the GUI at the instant `task start` succeeds, so later queue edits do not silently change that task's inputs.

## Workflow Commands

```text
shadowencoder-cli preset create --type workflow --name <name>
shadowencoder-cli workflow node-add <workflow-id> <kind> --revision <n>
shadowencoder-cli workflow node-set <workflow-id> <node-id> <field> <value> --revision <n>
shadowencoder-cli workflow node-remove <workflow-id> <node-id> --revision <n>
shadowencoder-cli workflow edge-add <workflow-id> <source> <source-port> <target> <target-port> --revision <n>
shadowencoder-cli workflow edge-remove <workflow-id> <edge-id> --revision <n>
```

Node kinds are:

- Actions: `backup`, `transcode`, `mix`, `check`
- Filter: `filter`
- Probes: `long_edge`, `frame_rate`, `list_index`, `reverse_index`
- Logic: `count`, `math`, `compare`, `boolean`
- Routing/output: `gate`, `output`

Read `workflowNodeFields`, `workflowEdgeFields`, and `scriptContract` from `schema show workflow`. The default input has ID `__workflow_start__` and output port `media`. It can be removed with `workflow node-remove` and restored with `workflow node-set <workflow-id> __workflow_start__ enabled true --revision <n>`. Edge creation rejects unknown or mismatched ports, duplicate edges, self-connections, and cycles.

### Advanced Custom Scripts

Create a `script` node with `workflow node-add`. Read it using `preset show`, write one UTF-8 JavaScript function body using `workflow script-set <workflow-id> <node-id> --file <path.js> --revision <n>`, then check connections with `workflow validate <workflow-id>`. Validation checks graph structure; the editor checks script syntax, and a task run checks execution. Mutations use the existing revision and undo history.

Create a `material` node and set its `path` field to process an individual file. It has one `media` output and no inputs. Agent task runs require that each material path is selected in the visible material list. Connect material -> script -> transcode (select an encode preset with presetId/presetRevision) -> output. Multiple media connections merge in connection insertion order, preserving each incoming list order. Change the order explicitly in the script by indexing `inputs` and choosing FFmpeg input labels.

Scripts receive `inputs: Array<{name,index,width,height,fps,duration}>`. Return only `{filterComplex, duration}`, with duration 0.1 to 86400 seconds and final video label `[out]`. Encoding parameters, format, output paths and preset IDs in results are rejected. Scripts only prepare media filters; the downstream transcode node applies its preset in the same FFmpeg run with no intermediate video. Audio follows the encode preset and comes from the first input. Video stream copy and audio-only presets cannot consume a video preprocessing plan. Encode before another script or media probe. Scripts run in a network-disabled worker with no app IPC, shell or filesystem access, with a 3-second planning timeout, at most 32 input files, and 64K characters of code. Pure media filters are allowlisted by the native runner; file/network/plugin/command filters and file-backed options are rejected.

Create `outputOverride` before a transcode or mix node to override output settings on that branch without changing the preset. Set one scalar at a time: `override.location` (`inherit|source|subdir|fixed`), `override.directory`, `override.subdirectory`, `override.naming` (`inherit|default|template`), and `override.nameTemplate`. Later explicit settings win independently; inherit preserves earlier overrides or the preset. It does not relocate files already produced. Unify conflicting overrides before merging composition inputs, or put the override after the script. Read `outputOverrideContract` in the workflow schema.

Example function body for two ordered inputs:

```js
if (inputs.length !== 2) throw new Error('Select exactly two materials');
return {
  filterComplex: '[0:v]scale=640:360,setsar=1[a];[1:v]scale=640:360,setsar=1[b];[a][b]hstack=inputs=2[out]',
  duration: 10
};
```

## Task Commands

```text
shadowencoder-cli task start <function> --preset <preset-id> --scope selected --revision <n>
shadowencoder-cli task cancel <task-id>
shadowencoder-cli task show <task-id> --json
shadowencoder-cli watch --jsonl
```

Supported task functions are `encode`, `mix`, `check`, `alpha`, `backup`, and `workflow`. Backup presets using move are denied. Agent workflows must use a manual trigger and cannot reference a move preset. Player-dependent screenshot, GIF, WebP, and clip jobs are not exposed because their current time/range/crop state is not represented by this protocol.

Require a terminal task state; do not infer completion from CLI process exit. Outputs must be newly created. A completed task can be undone only while every owned output still exists and matches its completion hash.

## Undo

```text
shadowencoder-cli history list --json
shadowencoder-cli undo
```

The application persists the latest 20 successful Agent operations globally. `undo` targets the latest eligible operation in the current Agent session.

- Field undo checks only that field, so unrelated user edits are preserved.
- List undo verifies the stable list item identity.
- A running task undo requests cancellation.
- A completed task undo verifies every output hash before removing any output.
- User changes always win; conflicts are reported instead of overwritten.

## Required Mutation Sequence

1. Show the target.
2. Show its function schema.
3. Submit one mutation with the exact current revision.
4. Check `ok`, the receipt, and the returned revision.
5. Show the target again before a dependent mutation.

Example:

```text
shadowencoder-cli preset show preset-123 --json
shadowencoder-cli schema show encode --json
shadowencoder-cli preset set preset-123 crf 20 --revision 7
shadowencoder-cli preset show preset-123 --json
shadowencoder-cli preset set preset-123 preset slow --revision 8
```

The two fields are intentionally separate commands.

## Error Handling

- `APP_NOT_RUNNING`: ask the user to start ShadowEncoder; do not retry in a loop.
- `PROTOCOL_MISMATCH`: stop and report GUI and CLI versions.
- `VALIDATION_ERROR`: reread schema and fix only the rejected value.
- `REVISION_CONFLICT`: reread the target and reassess.
- `UNDO_CONFLICT`: stop; later state would be overwritten.
- `HISTORY_EMPTY`: there is nothing to undo.
- `TASK_BUSY`: wait or ask whether the visible task should be canceled.
- `DESTRUCTIVE_COMMAND_DENIED`: choose a non-destructive operation.
- `OUTPUT_CHANGED`: do not delete the modified output.
- `PERMISSION_DENIED`: report the exact resource and permission failure.

## Completion Reporting

Report what changed or ran, affected preset/source/workflow/task IDs, terminal task status, output paths, the latest reversible `operationId`, and any conflict or validation that prevented an action.
