<!-- mancode:start -->
<!-- Managed by mancode. Do not edit this block manually. -->

# mancode for GitHub Copilot

## mancode Project Context

- Platform adapter: GitHub Copilot
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

## mancode Prompt Conventions

GitHub Copilot does not provide native mancode slash commands, hooks, or isolated subagents. Treat these names as user prompt conventions:

- man: use progressive research, planning, implementation, verification, and bounded risk-based review.
- manba: diagnose bugs and validate real user flows or regressions.
- manteam: read team memory and write handoff-friendly summaries.
- manps: prefer `mancode manps [area]` before cleanup.
- mansolo: exit any active mode and return to default solo behavior.

These correspond to prompt files in `.github/prompts/`. Select the matching prompt to activate a mode.
<!-- mancode:end -->
