---
name: shadowencoder-cli
description: Operate a running ShadowEncoder instance through its reversible, user-visible local CLI. Use it to inspect media queues, edit presets one field at a time, compose DIT workflows, request supported non-destructive jobs, monitor events, and undo Agent operations.
version: 1
---

# ShadowEncoder Agent CLI

Use `shadowencoder-cli` only with an already running ShadowEncoder application. The Rust command service is the single state authority, while the GUI stays visible, reflects Agent changes, and lets the user interrupt work. Except for `help` and `--version`, commands return `APP_NOT_RUNNING` when the application is closed.

## Mandatory Rules

1. Run `shadowencoder-cli status --json` before the first operation.
2. Run the relevant `show --json` command before a mutation and use its exact current `revision`.
3. Change exactly one field, one list item, one source, or one workflow step per command.
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
shadowencoder-cli workflow step-add <workflow-id> <kind> --revision <n>
shadowencoder-cli workflow step-add <workflow-id> <kind> --revision <n> --parent <condition-id> --branch then|else
shadowencoder-cli workflow step-set <workflow-id> <step-id> <field> <value> --revision <n>
shadowencoder-cli workflow step-remove <workflow-id> <step-id> --revision <n>
shadowencoder-cli workflow step-move <workflow-id> <step-id> <after-step-id> --revision <n>
```

Action kinds are `backup`, `transcode`, `mix`, and `check`. Use `condition` or `condition:<condition-kind>` for a condition node. `step-move` only reorders within one branch; use `-` as `<after-step-id>` to move to the beginning.

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
