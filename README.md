# pi-manjerok

A [pi](https://github.com/earendil-works/pi) package that ports the codex-routing multi-agent state machine onto [pi-subagents](https://github.com/nicobailon/pi-subagents) scripted workflows.

In the original bash/Codex setup the state machine lived inside prompts and was executed by an LLM on trust ("budgets are procedural rules, not a hard runtime counter"). Here the machine lives in a `workflowScript`: transitions, budgets, and attempt counters are hard-enforced by JavaScript in the workflow sandbox. LLMs only produce verdicts; the code decides what happens next.

## What it does

```
/manjerok add a --dry-run flag to the deploy command with tests
/manjerok migrate the config loader to the new schema --high-risk
/manjerok fix the flaky timer test --no-scout
```

Pipeline (each arrow is a fresh subagent run):

```
[scout] → worker ⇄ verifier → (escalate) → senior ⇄ verifier → [--high-risk or escalated] → reviewer → DONE
```

- **worker ⇄ verifier** — at most `budgets.workerAttempts` failed verification rounds, then escalation.
- **senior ⇄ verifier** — at most `budgets.seniorAttempts` failed rounds, then `STOPPED` with a diagnosis for the human.
- **reviewer** — only on `--high-risk` or after any senior involvement; `FINDINGS` send the current implementer back to work (at most `budgets.reviewRounds` rounds), `NO_FINDINGS` ends in `DONE`.
- `BLOCKED` (infrastructure/permission/environment) at any step halts the machine as `BLOCKED`. A missing or unparseable verdict line is also `BLOCKED` with a `malformed verdict` note — the machine never guesses.
- When the workflow finishes, the parent pi session receives an evidence report (final status, transition chain, key verdicts, attempt counts, child run ids) and is woken for the final primary review: check the actual code, not just the summaries.

## Requirements

- pi 0.83+ (`pi --version`)
- the **pi-subagents** package installed and loaded (peer dependency, discovered at runtime through the `subagents:rpc:v1` in-process RPC bridge):

```bash
pi install npm:pi-subagents
```

If pi-subagents is missing, `/manjerok` tells you so honestly instead of pretending to work.

## Install

From a local checkout:

```bash
pi install /path/to/pi-manjerok
```

or from git:

```bash
pi install git:github.com/<you>/pi-manjerok@v0.1.0
```

To try the extension without installing (the packaged agents will not resolve this way — install for the full pipeline):

```bash
pi -e /path/to/pi-manjerok/extensions/manjerok/index.ts
```

## Roles

| Role     | Agent                | Source                              | Write tools | Notes |
|----------|----------------------|-------------------------------------|-------------|-------|
| scout    | `scout`              | builtin (pi-subagents)              | `write` for `context.md` only | optional stage (`--no-scout`, `roles.scout.enabled`) |
| worker   | `worker`             | builtin                             | yes         | the only writer on tier 1 |
| verifier | `manjerok-verifier`  | **this package** (`agents/`)        | **no** (`read, grep, find, ls, bash`) | always a fresh context; "never fix what you are verifying" |
| senior   | `manjerok-senior`    | **this package** (`agents/`)        | yes         | escalation tier, `thinking: high`, `STOPPED` with diagnosis |
| reviewer | `reviewer`           | builtin                             | no          | its native `Merge verdict: BLOCK/OK/OK with notes` maps to `FINDINGS`/`NO_FINDINGS` |
| primary  | the parent pi session | you + the main agent               | —           | final acceptance review of the evidence report |

The builtin agents keep their stock system prompts; the verdict protocol is injected per run through the task's work packet (goal, scope, acceptance criteria, evidence from previous steps, `attempts_used`, and the required final `VERDICT: ...` line).

## Configuration

Layered, later wins (deep merge):

1. defaults compiled into the extension
2. `~/.pi/agent/manjerok.json` (global)
3. `.pi/manjerok.json` (project)

See [`manjerok.example.json`](./manjerok.example.json) for every key.

```json
{
  "roles": {
    "scout":    { "agent": "scout",             "model": null, "thinking": "low",  "enabled": true },
    "worker":   { "agent": "worker",            "model": null, "thinking": null },
    "verifier": { "agent": "manjerok-verifier", "model": null, "thinking": "medium" },
    "senior":   { "agent": "manjerok-senior",   "model": null, "thinking": "high" },
    "reviewer": { "agent": "reviewer",          "model": null, "thinking": "high" }
  },
  "budgets": { "workerAttempts": 2, "seniorAttempts": 2, "reviewRounds": 2 },
  "prompts": { "verifier": null, "senior": null },
  "timeoutMs": 1800000
}
```

### Changing models

- `roles.<role>.model` — an exact `provider/id` (bare ids resolve only if unique). Passed as a per-run parameter; it overrides for that child run and changes nothing in your settings. `null` (default) means native pi-subagents resolution: agent frontmatter → `subagents.agentOverrides.<agent>.model` → `subagents.defaultModel` → the parent session model.
- `roles.<role>.thinking` — pi-subagents applies thinking as a `:level` suffix on the model string, so a config `thinking` only takes effect per run **when `model` is also set**. With `model: null`, set thinking natively via `subagents.agentOverrides.<agent>.thinking` in `settings.json` (the extension prints a warning in this case instead of silently pretending). The packaged `manjerok-verifier`/`manjerok-senior` already declare their default thinking levels in frontmatter.

### Changing prompts

Two ways:

1. **Native (recommended):** `subagents.agentOverrides.manjerok-verifier.systemPrompt` in `~/.pi/agent/settings.json` or `.pi/settings.json`, or shadow the agent file with `.pi/agents/manjerok-verifier.md`. Works for builtin roles too (`scout`, `worker`, `reviewer`).
2. **`prompts.verifier` / `prompts.senior`:** a path to a markdown file (relative paths resolve against the directory of the config file that set it). On `/manjerok` invocation the extension registers a runtime agent `manjerok-<role>-custom` with that prompt through `pi-subagents:runtime-agent-register:v1` and points the workflow at it. Runtime registration cannot reuse a file-backed agent name (pi-subagents rejects configured/runtime collisions), which is why a distinct name is used. If the mechanism is unavailable in the installed pi-subagents version, the extension warns, falls back to the packaged agent, and prints the native override instructions.

### Budgets and timeout

- `budgets.workerAttempts` / `budgets.seniorAttempts` — failed verification rounds tolerated per tier (cross-run counters, not reset by re-spawning an agent).
- `budgets.reviewRounds` — reviewer `FINDINGS` loops tolerated before `STOPPED`.
- `timeoutMs` — deadline for the whole workflow run (default 30 min).

## Hard vs soft enforcement

Hard-enforced by code (the workflow sandbox):

- transition graph and termination (`DONE` / `STOPPED` / `BLOCKED`)
- attempt budgets and review-round budgets (JS counters)
- verifier ≠ implementer, and every verifier/reviewer pass is a fresh child run (`context: "fresh"`)
- one writer at a time (the pipeline is sequential)
- children cannot spawn children (pi-subagents default)
- tool allowlists of the packaged agents (verifier has no `edit`/`write`)
- verdict parsing: `/^VERDICT:\s*([A-Z_]+)/m`, reviewer fallback `Merge verdict: BLOCK → FINDINGS`, `OK | OK with notes → NO_FINDINGS`, anything else → `BLOCKED` (malformed)

Soft (prompt-level, inherited honesty of the original):

- "never weaken tests / hide failures"
- "trace the root cause before another fix" (senior)
- "review the real code, not the summaries" (primary review instruction to the parent session)
- quality of the `STOPPED` diagnosis

## Observability

- The FSM emits every transition via `emit({type: "manjerok:transition", ...})` and `console.log`; both are visible in `subagent({action: "status"})` / `/subagents` run details (`Latest emit`, workflow trace, console).
- On completion, the extension reads the workflow's return value from the run's `status.json` and posts the full evidence report into the parent session (`triggerTurn: true`) for the final primary review. If the report cannot be read, the message says `UNVERIFIED` and points at the run directory instead of claiming success.

## Deliberately dropped from the original script

- git machinery (branches, worktrees, commits, backups) — pi-subagents has its own optional worktree isolation; manjerok does not manage VCS state
- the transactional installer, tmux orchestration, OS notifications
- smoke-test documents
- the `default`/routing-guard role — routing lives in code now, not on an LLM's conscience

## Development

No build step: pi loads `extensions/manjerok/index.ts` through jiti. The workflow script is a plain string constant (`WORKFLOW_SCRIPT`) validated by the pi-subagents sandbox rules: top-level `await`, no nested async functions, no filesystem access, config injected via frozen `args`.
