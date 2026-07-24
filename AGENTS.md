<!-- mancode:start -->
<!-- Managed by mancode. Do not edit this block manually. -->

# mancode Configuration

## mancode Project Context

- Platform adapter: Codex (ChatGPT desktop/CLI)
- Current mode: solo
- Tech stack: Unknown
- UI library: None
- Project profile: unknown; validation: inspect project
- At the start of each session, read `.mancode/state.json` to check the current mode and project context.
- Read `.mancode/project-profile.json` before choosing tools or validation. Only for a UI task in a profile with detected UI assets, read `.mancode/aesthetics/style-tokens.json`.

## mancode Practice Rules

Before writing new code, check this YAGNI ladder:

1. Reuse existing project code.
2. Use the standard library.
3. Use platform-native behavior.
4. Use already installed dependencies.
5. Prefer a one-line fix when it is enough.
6. Only then write the smallest new implementation.

For every task, consider: why this change, what already exists, and what is the smallest useful diff?

In solo mode, use the narrowest meaningful validation and one bounded self-check limited to the current diff. Do not start another reviewer or repeat the review. Only recommend man for auth, payment, sensitive data, migrations/deletion, public APIs, untrusted input, concurrency, or infrastructure risk.

## mancode Modes

- solo: default lightweight mode. Invoke mode skills with `$man`, `$manba`, `$manteam`, `$manps`, `$mansolo`.
- man: progressive governance workflow with planning and optional full execution.
- manba: diagnose bugs and validate real user flows or regressions.
- manteam: use team memory and leave handoff-friendly summaries.
- manps: run project health and cleanup scans before remediation.
- mansolo: return to solo mode.

## mancode Platform Downgrade

- This platform does not provide the full Claude Code hook/subagent model.
- Session and prompt-submit hooks are represented as persistent instructions.
- Simulate the coaching staff in sequence inside the same conversation: Scout, Plan Coach, Head Coach, Film Analyst Offense, Film Analyst Defense.
<!-- mancode:end -->

<!-- mancode:zcode:start -->
<!-- Managed by mancode. Do not edit this block manually. -->

# mancode Configuration

## mancode Project Context

- Platform adapter: ZCode
- Current mode: solo
- Tech stack: Unknown
- UI library: None
- Project profile: unknown; validation: inspect project
- At the start of each session, read `.mancode/state.json` to check the current mode and project context.
- Read `.mancode/project-profile.json` before choosing tools or validation. Only for a UI task in a profile with detected UI assets, read `.mancode/aesthetics/style-tokens.json`.

## mancode Practice Rules

Before writing new code, check this YAGNI ladder:

1. Reuse existing project code.
2. Use the standard library.
3. Use platform-native behavior.
4. Use already installed dependencies.
5. Prefer a one-line fix when it is enough.
6. Only then write the smallest new implementation.

For every task, consider: why this change, what already exists, and what is the smallest useful diff?

In solo mode, use the narrowest meaningful validation and one bounded self-check limited to the current diff. Do not start another reviewer or repeat the review. Only recommend man for auth, payment, sensitive data, migrations/deletion, public APIs, untrusted input, concurrency, or infrastructure risk.

## mancode Modes

- solo: default lightweight mode. Invoke mode skills with `$man`, `$manba`, `$manteam`, `$manps`, `$mansolo`.
- man: progressive governance workflow with planning and optional full execution.
- manba: diagnose bugs and validate real user flows or regressions.
- manteam: use team memory and leave handoff-friendly summaries.
- manps: run project health and cleanup scans before remediation.
- mansolo: return to solo mode.

## mancode Platform Downgrade

- This platform does not provide the full Claude Code hook/subagent model.
- Session and prompt-submit hooks are represented as persistent instructions.
- Simulate the coaching staff in sequence inside the same conversation: Scout, Plan Coach, Head Coach, Film Analyst Offense, Film Analyst Defense.
<!-- mancode:zcode:end -->

# ShadowEncoder Project Rules

## Default validation (UI / frontend)

After any UI or frontend change that can be seen in the running app:

1. Prefer **starting the app** and doing a visual/smoke check over only `tsc` / unit checks.
2. Start command (from repo): `app\dev-tauri.bat`  
   - Sets MSVC env, Cargo PATH, ffmpeg PATH, then `npm run tauri dev` in `app/`.
3. If a Tauri/Vite dev process is already running, reuse it; only restart when native/backend code or deps changed.
4. Report what you launched and what you checked (layout, tabs, shared file list, progress, etc.).
5. Typecheck (`cd app && npx tsc --noEmit`) is secondary; do not treat it as a substitute for launching the app when UI changed.
