// pi-manjerok — deterministic multi-agent routing state machine on top of pi-subagents.
//
// Ports the codex-routing FSM (scout → worker ⇄ verifier → senior ⇄ verifier → reviewer)
// into a pi-subagents workflowScript: transitions, budgets, and attempt counters are
// hard-enforced by JavaScript in the workflow sandbox, not by prompt instructions.
//
// Transport: pi-subagents in-process RPC (subagents:rpc:v1). Completion is tracked via
// the native `subagent:async-complete` event; the full evidence report is read from the
// run's status.json and injected into the parent session for the final primary review.

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
const RPC_REPLY_PREFIX = "subagents:rpc:v1:reply:";
const ASYNC_COMPLETE_EVENT = "subagent:async-complete";
const RUNTIME_AGENT_REGISTER_EVENT = "pi-subagents:runtime-agent-register:v1";

const CONFIG_FILE = "manjerok.json";
const PING_TIMEOUT_MS = 5_000;
const SPAWN_TIMEOUT_MS = 30_000;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type ThinkingLevel = (typeof THINKING_LEVELS)[number];

const ROLE_NAMES = ["scout", "worker", "verifier", "senior", "reviewer"] as const;
type RoleName = (typeof ROLE_NAMES)[number];

interface RoleConfig {
	agent: string;
	model: string | null;
	thinking: ThinkingLevel | null;
	enabled?: boolean;
}

interface ManjerokConfig {
	roles: Record<RoleName, RoleConfig>;
	budgets: { workerAttempts: number; seniorAttempts: number; reviewRounds: number };
	prompts: { verifier: string | null; senior: string | null };
	timeoutMs: number;
}

const DEFAULT_CONFIG: ManjerokConfig = {
	roles: {
		scout: { agent: "scout", model: null, thinking: "low", enabled: true },
		worker: { agent: "worker", model: null, thinking: null },
		verifier: { agent: "manjerok-verifier", model: null, thinking: "medium" },
		senior: { agent: "manjerok-senior", model: null, thinking: "high" },
		reviewer: { agent: "reviewer", model: null, thinking: "high" },
	},
	budgets: { workerAttempts: 2, seniorAttempts: 2, reviewRounds: 2 },
	prompts: { verifier: null, senior: null },
	timeoutMs: 1_800_000,
};

interface LoadedConfig {
	config: ManjerokConfig;
	warnings: string[];
	/** Field paths explicitly set by user config files (vs defaults). */
	explicit: Set<string>;
	/** Directory of the config file that last set prompts.verifier / prompts.senior. */
	promptBaseDirs: { verifier?: string; senior?: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepMergeConfig(base: ManjerokConfig, override: Record<string, unknown>, sourceDir: string, out: LoadedConfig): void {
	const cfg = out.config;
	const mark = (field: string) => out.explicit.add(field);
	if (isRecord(override.roles)) {
		for (const role of ROLE_NAMES) {
			const r = override.roles[role];
			if (!isRecord(r)) continue;
			const target = cfg.roles[role];
			if (typeof r.agent === "string" && r.agent.trim()) {
				target.agent = r.agent.trim();
				mark(`roles.${role}.agent`);
			}
			if (r.model !== undefined) {
				target.model = typeof r.model === "string" && r.model.trim() ? r.model.trim() : null;
				mark(`roles.${role}.model`);
			}
			if (r.thinking !== undefined) {
				if (typeof r.thinking === "string" && (THINKING_LEVELS as readonly string[]).includes(r.thinking)) {
					target.thinking = r.thinking as ThinkingLevel;
				} else if (r.thinking === null) {
					target.thinking = null;
				} else {
					out.warnings.push(`roles.${role}.thinking must be one of ${THINKING_LEVELS.join("/")} or null; ignoring ${JSON.stringify(r.thinking)}.`);
				}
				mark(`roles.${role}.thinking`);
			}
			if (r.enabled !== undefined) {
				target.enabled = r.enabled !== false;
				mark(`roles.${role}.enabled`);
				if (role !== "scout" && target.enabled === false) {
					out.warnings.push(`roles.${role}.enabled=false is ignored: only the scout stage is optional.`);
				}
			}
		}
	}
	if (isRecord(override.budgets)) {
		for (const key of ["workerAttempts", "seniorAttempts", "reviewRounds"] as const) {
			const value = override.budgets[key];
			if (value === undefined) continue;
			if (Number.isInteger(value) && (value as number) >= 1) {
				cfg.budgets[key] = value as number;
			} else {
				out.warnings.push(`budgets.${key} must be an integer >= 1; ignoring ${JSON.stringify(value)}.`);
			}
			mark(`budgets.${key}`);
		}
	}
	if (isRecord(override.prompts)) {
		for (const key of ["verifier", "senior"] as const) {
			const value = override.prompts[key];
			if (value === undefined) continue;
			if (typeof value === "string" && value.trim()) {
				cfg.prompts[key] = value.trim();
				out.promptBaseDirs[key] = sourceDir;
			} else if (value === null) {
				cfg.prompts[key] = null;
			} else {
				out.warnings.push(`prompts.${key} must be a path string or null; ignoring ${JSON.stringify(value)}.`);
			}
			mark(`prompts.${key}`);
		}
	}
	if (override.timeoutMs !== undefined) {
		if (Number.isInteger(override.timeoutMs) && (override.timeoutMs as number) >= 10_000) {
			cfg.timeoutMs = override.timeoutMs as number;
		} else {
			out.warnings.push(`timeoutMs must be an integer >= 10000; ignoring ${JSON.stringify(override.timeoutMs)}.`);
		}
		mark("timeoutMs");
	}
}

function readConfigFile(file: string): Record<string, unknown> | null {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf-8");
	} catch {
		return null;
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		return isRecord(parsed) ? parsed : null;
	} catch (error) {
		console.warn(`[manjerok] failed to parse ${file}: ${error instanceof Error ? error.message : String(error)}`);
		return null;
	}
}

function loadConfig(cwd: string): LoadedConfig {
	const out: LoadedConfig = {
		config: structuredClone(DEFAULT_CONFIG),
		warnings: [],
		explicit: new Set(),
		promptBaseDirs: {},
	};
	const globalFile = path.join(getAgentDir(), CONFIG_FILE);
	const projectFile = path.join(cwd, ".pi", CONFIG_FILE);
	const globalConfig = readConfigFile(globalFile);
	if (globalConfig) deepMergeConfig(out.config, globalConfig, path.dirname(globalFile), out);
	const projectConfig = readConfigFile(projectFile);
	if (projectConfig) deepMergeConfig(out.config, projectConfig, path.dirname(projectFile), out);
	return out;
}

// Per-run thinking cannot be passed without a model in pi-subagents (the `thinking`
// dispatch field is ignored; thinking rides as a `:level` suffix on the model string).
function modelParamFor(role: RoleName, loaded: LoadedConfig): string | null {
	const { model, thinking } = loaded.config.roles[role];
	if (!model) {
		if (thinking && loaded.explicit.has(`roles.${role}.thinking`)) {
			loaded.warnings.push(
				`roles.${role}.thinking has no per-run effect without roles.${role}.model ` +
				`(pi-subagents applies thinking as a model suffix). Set roles.${role}.model, or use ` +
				`subagents.agentOverrides.${loaded.config.roles[role].agent}.thinking in settings.json.`,
			);
		}
		return null;
	}
	const suffixMatch = model.match(/:([a-z]+)$/);
	if (suffixMatch && (THINKING_LEVELS as readonly string[]).includes(suffixMatch[1]!)) return model;
	return thinking ? `${model}:${thinking}` : model;
}

// ---------------------------------------------------------------------------
// Runtime prompt overrides (prompts.verifier / prompts.senior)
// ---------------------------------------------------------------------------

const CUSTOM_AGENT_NAMES: Record<"verifier" | "senior", string> = {
	verifier: "manjerok-verifier-custom",
	senior: "manjerok-senior-custom",
};

interface RuntimeRegistration {
	dispose(): void;
}

// Runtime registration cannot reuse a file-backed agent name (pi-subagents rejects
// configured/runtime collisions), so overrides register under a distinct name.
function registerPromptOverride(
	pi: ExtensionAPI,
	role: "verifier" | "senior",
	promptFile: string,
	baseDir: string | undefined,
	loaded: LoadedConfig,
	registrations: Map<string, { hash: string; registration: RuntimeRegistration }>,
): string | null {
	const resolved = path.isAbsolute(promptFile) ? promptFile : path.resolve(baseDir ?? process.cwd(), promptFile);
	let systemPrompt: string;
	try {
		systemPrompt = fs.readFileSync(resolved, "utf-8");
	} catch {
		loaded.warnings.push(
			`prompts.${role} file not readable: ${resolved}. Falling back to the packaged ${loaded.config.roles[role].agent}.`,
		);
		return null;
	}
	if (!systemPrompt.trim()) {
		loaded.warnings.push(`prompts.${role} file is empty: ${resolved}. Falling back to the packaged agent.`);
		return null;
	}
	const roleCfg = loaded.config.roles[role];
	const name = CUSTOM_AGENT_NAMES[role];
	const definition = {
		description: `manjerok ${role} with project-supplied system prompt (${resolved})`,
		systemPrompt,
		tools: role === "verifier" ? ["read", "grep", "find", "ls", "bash"] : ["read", "grep", "find", "ls", "bash", "edit", "write"],
		thinking: roleCfg.thinking ?? (role === "verifier" ? "medium" : "high"),
		systemPromptMode: "replace",
		inheritProjectContext: true,
		inheritGlobalContext: false,
		inheritSkills: false,
		...(role === "verifier" ? { completionGuard: false } : {}),
	};
	const hash = `${name}:${systemPrompt.length}:${definition.thinking}`;
	const existing = registrations.get(name);
	if (existing && existing.hash === hash) return name;
	const request: { version: 1; name: string; definition: typeof definition; result?: unknown } = {
		version: 1,
		name,
		definition,
	};
	try {
		pi.events.emit(RUNTIME_AGENT_REGISTER_EVENT, request);
	} catch (error) {
		loaded.warnings.push(
			`runtime agent registration failed for ${name}: ${error instanceof Error ? error.message : String(error)}. ` +
			`Falling back to the packaged agent. Alternative: set subagents.agentOverrides.${roleCfg.agent}.systemPrompt in settings.json.`,
		);
		return null;
	}
	const result = request.result as { ok: true; registration: RuntimeRegistration } | { ok: false; error: Error } | undefined;
	if (result === undefined) {
		loaded.warnings.push(
			`pi-subagents does not support runtime agent registration in this process (no listener for ${RUNTIME_AGENT_REGISTER_EVENT}). ` +
			`Falling back to the packaged agent. To override its prompt, set subagents.agentOverrides.${roleCfg.agent}.systemPrompt in settings.json ` +
			`or shadow it with .pi/agents/${roleCfg.agent}.md.`,
		);
		return null;
	}
	if (result.ok !== true) {
		loaded.warnings.push(
			`runtime agent registration rejected for ${name}: ${result.error.message}. Falling back to the packaged agent.`,
		);
		return null;
	}
	try {
		existing?.registration.dispose();
	} catch {
		// Disposal of a superseded registration is best-effort.
	}
	registrations.set(name, { hash, registration: result.registration });
	return name;
}

// ---------------------------------------------------------------------------
// RPC client
// ---------------------------------------------------------------------------

interface RpcReplyEnvelope {
	success?: boolean;
	data?: unknown;
	error?: { code?: string; message?: string };
}

let rpcSeq = 0;

function rpcCall(pi: ExtensionAPI, method: string, params: unknown, timeoutMs: number): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const requestId = `manjerok-${process.pid}-${++rpcSeq}-${Date.now()}`;
		const replyEvent = `${RPC_REPLY_PREFIX}${requestId}`;
		let unsubscribe: (() => void) | undefined;
		const cleanup = () => {
			clearTimeout(timer);
			try {
				unsubscribe?.();
			} catch {
				// Unsubscribe is best-effort.
			}
		};
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error(`pi-subagents RPC '${method}' gave no reply within ${timeoutMs}ms — the pi-subagents package is required. Install it (pi install npm:pi-subagents), reload pi, and retry.`));
		}, timeoutMs);
		unsubscribe = pi.events.on(replyEvent, (raw) => {
			cleanup();
			const reply = raw as RpcReplyEnvelope | undefined;
			if (reply && reply.success === true) {
				resolve(reply.data);
			} else {
				reject(new Error(`pi-subagents RPC '${method}' failed: ${reply?.error?.message ?? "malformed reply"}.`));
			}
		}) as (() => void) | undefined;
		pi.events.emit(RPC_REQUEST_EVENT, {
			version: 1,
			requestId,
			method,
			...(params !== undefined ? { params } : {}),
			source: { extension: "pi-manjerok" },
		});
	});
}

// ---------------------------------------------------------------------------
// Workflow script (runs inside the pi-subagents sandbox; config via frozen `args`)
// ---------------------------------------------------------------------------

// Sandbox rules honored here: top-level await only, no nested async functions or
// async arrows, no filesystem/host globals, plain-JSON `args`, unique run keys,
// single-item runs.all so child failures arrive as data instead of throwing.
// Exported (named) only so tests can compile-check it with the same wrapper the
// sandbox uses; pi itself consumes just the default export.
export const WORKFLOW_SCRIPT = `
const roles = args.roles;
const budgets = args.budgets;
const task = args.task;
const highRisk = args.highRisk === true;
const EVIDENCE_LIMIT = 6000;
const transitions = [];
const evidence = [];
const childRuns = [];
let seq = 0;
let workerAttempts = 0;
let seniorAttempts = 0;
let reviewRoundsUsed = 0;
let tier = "worker";

function trunc(value, n) {
  const s = typeof value === "string" ? value : String(value == null ? "" : value);
  return s.length > n ? s.slice(0, n) + "\\n…[truncated]" : s;
}

function note(step, verdict, detail) {
  const entry = { step: step, verdict: verdict, detail: trunc(detail || "", 300) };
  transitions.push(entry);
  emit({ type: "manjerok:transition", step: entry.step, verdict: entry.verdict, detail: entry.detail });
  console.log("[manjerok] " + entry.step + " -> " + entry.verdict + (entry.detail ? " — " + trunc(entry.detail, 160) : ""));
}

function pushEvidence(source, text) {
  evidence.push({ source: source, text: trunc(text, EVIDENCE_LIMIT) });
  while (evidence.length > 8) evidence.shift();
}

// Verdict contract, hard-enforced: a verdict is a full line "VERDICT: <TOKEN>"
// with nothing after the token; of all such lines only the LAST counts, and only
// whitespace may follow it — the documented "verdict is the last line" rule.
// Hedged ("VERDICT: FAIL because…") or mid-text-only verdicts are malformed.
function lastVerdictLine(text, re, roleName, label) {
  let m, token = null, tail = "";
  while ((m = re.exec(text)) !== null) { token = m[1]; tail = text.slice(re.lastIndex); }
  if (token === null) return { token: null, detail: "malformed verdict from " + roleName + ": no clean " + label + " line" };
  if (tail.trim() !== "") return { token: null, detail: "malformed verdict from " + roleName + ": content after the " + label + " line ('" + trunc(tail.trim(), 120) + "') — the verdict must be the last line" };
  return { token: token, detail: "" };
}

function parseVerdict(output, allowed, roleName) {
  const text = typeof output === "string" ? output : "";
  const r = lastVerdictLine(text, /^VERDICT:[ \\t]*([A-Z_]+)[ \\t\\r]*$/gm, roleName, "VERDICT:");
  if (r.detail) return { verdict: "BLOCKED", detail: r.detail };
  if (allowed.indexOf(r.token) === -1) return { verdict: "BLOCKED", detail: "malformed verdict from " + roleName + ": '" + r.token + "' not in " + allowed.join("|") };
  return { verdict: r.token, detail: "" };
}

function parseReviewerVerdict(output) {
  const text = typeof output === "string" ? output : "";
  const direct = lastVerdictLine(text, /^VERDICT:[ \\t]*([A-Z_]+)[ \\t\\r]*$/gm, "reviewer", "VERDICT:");
  if (!direct.detail) {
    if (["FINDINGS", "NO_FINDINGS", "BLOCKED"].indexOf(direct.token) === -1) return { verdict: "BLOCKED", detail: "malformed verdict from reviewer: '" + direct.token + "'" };
    return { verdict: direct.token, detail: "" };
  }
  const merge = lastVerdictLine(text, /^Merge verdict:[ \\t]*(.+?)[ \\t\\r]*$/gm, "reviewer", "Merge verdict:");
  if (!merge.detail) {
    const mv = merge.token.toUpperCase();
    if (mv === "BLOCK") return { verdict: "FINDINGS", detail: "mapped from 'Merge verdict: BLOCK'" };
    if (mv === "OK" || mv === "OK WITH NOTES") return { verdict: "NO_FINDINGS", detail: "mapped from 'Merge verdict: " + merge.token + "'" };
    return { verdict: "BLOCKED", detail: "malformed verdict from reviewer: '" + merge.token + "'" };
  }
  return { verdict: "BLOCKED", detail: "malformed verdict from reviewer: no usable verdict line (" + trunc(direct.detail.replace("malformed verdict from reviewer: ", ""), 120) + "; " + trunc(merge.detail.replace("malformed verdict from reviewer: ", ""), 120) + ")" };
}

function evidenceBlock() {
  if (evidence.length === 0) return "";
  const parts = ["", "## Evidence from previous steps (oldest first)"];
  for (let i = 0; i < evidence.length; i++) {
    parts.push("", "### " + evidence[i].source, evidence[i].text);
  }
  return parts.join("\\n");
}

function workPacket(role, attemptsUsed, attemptsBudget, instructions, verdicts) {
  const lines = [
    "## Work packet",
    "",
    "Goal: " + task,
    "",
    "Role: " + role + ". Attempts used on this tier: " + attemptsUsed + " of " + attemptsBudget + ".",
    "Risk profile: " + (highRisk ? "HIGH — final reviewer pass is mandatory." : "normal."),
    "",
    instructions,
  ];
  const ev = evidenceBlock();
  if (ev) lines.push("", ev);
  lines.push(
    "",
    "## Protocol",
    "The last line of your final response must be exactly one of: " + verdicts.map(function (v) { return "VERDICT: " + v; }).join(" | "),
    "The verdict line must contain nothing after the token, and only whitespace may follow it in the",
    "response. If several VERDICT lines appear, only the last one counts.",
    "BLOCKED is reserved for infrastructure/permission/environment failure, never for task difficulty.",
    "A missing, hedged, or misplaced verdict line is treated as BLOCKED with a malformed-verdict note."
  );
  return lines.join("\\n");
}

function launch(role, packetText, labelText) {
  seq += 1;
  const roleCfg = roles[role];
  const item = { key: role + "-" + seq, agent: roleCfg.agent, task: packetText, label: labelText };
  if (typeof roleCfg.modelParam === "string" && roleCfg.modelParam) item.model = roleCfg.modelParam;
  if (role === "verifier" || role === "reviewer") item.context = "fresh";
  return runs.all([item]);
}

function outcome(step, results, allowed, roleName) {
  const run = results[0];
  childRuns.push({ step: step, key: run && run.key ? run.key : step, runId: run && run.runId ? run.runId : null, ok: run ? run.ok === true : false });
  if (!run) return { verdict: "BLOCKED", detail: "no child result returned", output: "" };
  if (run.stopped === true) return { verdict: "BLOCKED", detail: "child run stopped (deadline or stop request)", output: trunc(run.output, EVIDENCE_LIMIT) };
  if (run.ok !== true) return { verdict: "BLOCKED", detail: "child run failed: " + trunc(run.error || run.output, 400), output: trunc(run.output, EVIDENCE_LIMIT) };
  const parsed = roleName === "reviewer" ? parseReviewerVerdict(run.output) : parseVerdict(run.output, allowed, roleName);
  return { verdict: parsed.verdict, detail: parsed.detail, output: trunc(run.output, EVIDENCE_LIMIT) };
}

function report(status, reason) {
  return {
    schema: "manjerok-report/v1",
    status: status,
    reason: trunc(reason || "", 600),
    task: trunc(task, 500),
    highRisk: highRisk,
    attempts: { worker: workerAttempts, senior: seniorAttempts, reviewRounds: reviewRoundsUsed },
    budgets: budgets,
    transitions: transitions,
    evidence: evidence.slice(-6),
    childRuns: childRuns
  };
}

if (args.scoutEnabled) {
  note("SCOUT", "START", roles.scout.agent);
  const scoutPacket = workPacket("scout", 0, 0, [
    "Gather the minimum context an implementer needs for this goal: relevant files, entry points,",
    "key types, data flow, likely change sites, constraints, and risks. Do not implement anything.",
    "End with VERDICT: COMPLETE when the context is sufficient, VERDICT: NEEDS_ANALYSIS when you",
    "gathered context but deeper analysis is still required (say what), or VERDICT: BLOCKED."
  ].join("\\n"), ["COMPLETE", "NEEDS_ANALYSIS", "BLOCKED"]);
  const scoutRes = await launch("scout", scoutPacket, "Scout the codebase");
  const scoutOut = outcome("SCOUT", scoutRes, ["COMPLETE", "NEEDS_ANALYSIS", "BLOCKED"], "scout");
  note("SCOUT", scoutOut.verdict, scoutOut.detail || "context gathered");
  if (scoutOut.verdict === "BLOCKED") return report("BLOCKED", "scout stage: " + scoutOut.detail);
  if (scoutOut.output) pushEvidence("scout", scoutOut.output);
}

let phase = "IMPLEMENT";
while (true) {
  if (phase === "IMPLEMENT") {
    const role = tier;
    const budget = tier === "worker" ? budgets.workerAttempts : budgets.seniorAttempts;
    const used = tier === "worker" ? workerAttempts : seniorAttempts;
    const isSenior = tier === "senior";
    const instructions = isSenior ? [
      "You are the escalation tier. The evidence below shows exactly why the worker tier failed.",
      "Trace the root cause before changing any code, and state it in your final response.",
      "Do not retry an approach that already failed with the same evidence. If the task needs a",
      "human decision or the loop will not converge, end with VERDICT: STOPPED plus a diagnosis and",
      "a concrete proposed next decision for the operator."
    ].join("\\n") : [
      "Implement the goal with narrow, coherent edits. You are the only writer right now.",
      "State the acceptance criteria you targeted explicitly in your final response;",
      "an independent verifier will check them against the actual diff and checks."
    ].join("\\n");
    const verdicts = isSenior ? ["READY_FOR_VERIFICATION", "STOPPED", "BLOCKED"] : ["READY_FOR_VERIFICATION", "ESCALATE", "BLOCKED"];
    const packetText = workPacket(role, used, budget, instructions, verdicts);
    note(role.toUpperCase(), "START", "tier=" + tier + " attempts_used=" + used + "/" + budget);
    const implRes = await launch(role, packetText, isSenior ? "Senior escalation pass" : "Implement task");
    const implOut = outcome(role.toUpperCase(), implRes, verdicts, role);
    if (implOut.output) pushEvidence(role + " (attempt " + (used + 1) + ")", implOut.output);
    note(role.toUpperCase(), implOut.verdict, implOut.detail);
    if (implOut.verdict === "BLOCKED") return report("BLOCKED", role + ": " + implOut.detail);
    if (!isSenior && implOut.verdict === "ESCALATE") {
      tier = "senior";
      note("ESCALATE", "worker->senior", "worker requested escalation");
      continue;
    }
    if (isSenior && implOut.verdict === "STOPPED") return report("STOPPED", "senior stopped deliberately. Diagnosis: " + trunc(implOut.output, 800));
    if (implOut.verdict === "READY_FOR_VERIFICATION") {
      phase = "VERIFY";
      continue;
    }
    return report("BLOCKED", role + ": unreachable verdict '" + implOut.verdict + "'");
  }
  if (phase === "VERIFY") {
    const verifyInstructions = [
      "Independently verify the current working tree against the goal and the implementer's",
      "claimed acceptance criteria (in the evidence below). Inspect the diff, read the changed",
      "files, and run the relevant checks yourself. Never fix what you are verifying.",
      "Distinguish pre-existing failures from ones introduced by this change.",
      "CHECKS_PASSED means the checks you ran passed — it is not proof of correctness."
    ].join("\\n");
    const packetText = workPacket("verifier", 0, 0, verifyInstructions, ["CHECKS_PASSED", "FAIL", "BLOCKED"]);
    note("VERIFIER", "START", roles.verifier.agent);
    const verifyRes = await launch("verifier", packetText, "Verify implementation");
    const verifyOut = outcome("VERIFIER", verifyRes, ["CHECKS_PASSED", "FAIL", "BLOCKED"], "verifier");
    if (verifyOut.output) pushEvidence("verifier", verifyOut.output);
    note("VERIFIER", verifyOut.verdict, verifyOut.detail);
    if (verifyOut.verdict === "BLOCKED") return report("BLOCKED", "verifier: " + verifyOut.detail);
    if (verifyOut.verdict === "FAIL") {
      if (tier === "worker") {
        workerAttempts += 1;
        if (workerAttempts >= budgets.workerAttempts) {
          tier = "senior";
          note("ESCALATE", "worker->senior", "worker attempt budget exhausted (" + workerAttempts + "/" + budgets.workerAttempts + ")");
          phase = "IMPLEMENT";
          continue;
        }
        phase = "IMPLEMENT";
        continue;
      }
      seniorAttempts += 1;
      if (seniorAttempts >= budgets.seniorAttempts) {
        return report("STOPPED", "senior tier exhausted its verification budget (" + seniorAttempts + "/" + budgets.seniorAttempts + "). Last verifier report: " + trunc(verifyOut.output, 800));
      }
      phase = "IMPLEMENT";
      continue;
    }
    if (highRisk || tier === "senior") {
      phase = "REVIEW";
      continue;
    }
    return report("DONE", "checks passed by independent verifier");
  }
  if (phase === "REVIEW") {
    const reviewInstructions = [
      "Final independent review on the " + (highRisk ? "high-risk" : "post-escalation") + " pipeline.",
      "The change already passed independent verification (report in evidence). Review the actual",
      "diff for correctness, scope discipline, edge cases, and risk. Do not edit files.",
      "End with VERDICT: FINDINGS or VERDICT: NO_FINDINGS. Your native 'Merge verdict: BLOCK' and",
      "'Merge verdict: OK / OK with notes' lines are also accepted and mapped to FINDINGS/NO_FINDINGS."
    ].join("\\n");
    const packetText = workPacket("reviewer", reviewRoundsUsed, budgets.reviewRounds, reviewInstructions, ["FINDINGS", "NO_FINDINGS", "BLOCKED"]);
    note("REVIEWER", "START", "round " + (reviewRoundsUsed + 1) + "/" + budgets.reviewRounds);
    const reviewRes = await launch("reviewer", packetText, "Final review");
    const reviewOut = outcome("REVIEWER", reviewRes, [], "reviewer");
    if (reviewOut.output) pushEvidence("reviewer", reviewOut.output);
    note("REVIEWER", reviewOut.verdict, reviewOut.detail);
    if (reviewOut.verdict === "BLOCKED") return report("BLOCKED", "reviewer: " + reviewOut.detail);
    if (reviewOut.verdict === "NO_FINDINGS") return report("DONE", "verifier passed and reviewer found no issues");
    reviewRoundsUsed += 1;
    if (reviewRoundsUsed >= budgets.reviewRounds) {
      return report("STOPPED", "review round budget exhausted (" + reviewRoundsUsed + "/" + budgets.reviewRounds + "). Last reviewer findings: " + trunc(reviewOut.output, 800));
    }
    phase = "IMPLEMENT";
    continue;
  }
  return report("BLOCKED", "unknown FSM phase '" + phase + "'");
}
`;

// ---------------------------------------------------------------------------
// Workflow args
// ---------------------------------------------------------------------------

interface WorkflowRoleArg {
	agent: string;
	modelParam: string | null;
}

function buildWorkflowArgs(
	loaded: LoadedConfig,
	roleAgents: Record<RoleName, string>,
	task: string,
	highRisk: boolean,
	scoutEnabled: boolean,
): Record<string, unknown> {
	const roles = {} as Record<RoleName, WorkflowRoleArg>;
	for (const role of ROLE_NAMES) {
		roles[role] = { agent: roleAgents[role], modelParam: modelParamFor(role, loaded) };
	}
	return {
		task,
		highRisk,
		scoutEnabled,
		roles,
		budgets: { ...loaded.config.budgets },
	};
}

// ---------------------------------------------------------------------------
// Completion handling: full evidence report into the parent session
// ---------------------------------------------------------------------------

interface PendingRun {
	task: string;
	asyncDir?: string;
	startedAt: number;
}

interface ManjerokReport {
	schema?: string;
	status?: string;
	reason?: string;
	task?: string;
	highRisk?: boolean;
	attempts?: { worker?: number; senior?: number; reviewRounds?: number };
	budgets?: { workerAttempts?: number; seniorAttempts?: number; reviewRounds?: number };
	transitions?: Array<{ step?: string; verdict?: string; detail?: string }>;
	evidence?: Array<{ source?: string; text?: string }>;
	childRuns?: Array<{ step?: string; key?: string; runId?: string | null; ok?: boolean }>;
}

function readWorkflowReport(asyncDir: string | undefined): { report?: ManjerokReport; state?: string; error?: string } {
	if (!asyncDir) return { error: "no asyncDir known for this run" };
	let raw: string;
	try {
		raw = fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8");
	} catch (error) {
		return { error: `status.json unreadable: ${error instanceof Error ? error.message : String(error)}` };
	}
	try {
		const status = JSON.parse(raw) as { state?: string; error?: string; workflow?: { value?: unknown; trace?: unknown[] } };
		const value = status.workflow?.value;
		return {
			...(isRecord(value) && value.schema === "manjerok-report/v1" ? { report: value as ManjerokReport } : {}),
			...(typeof status.state === "string" ? { state: status.state } : {}),
			...(typeof status.error === "string" ? { error: status.error } : {}),
		};
	} catch (error) {
		return { error: `status.json unparseable: ${error instanceof Error ? error.message : String(error)}` };
	}
}

function formatTransitionLine(entry: { step?: string; verdict?: string; detail?: string }): string {
	const head = `${entry.step ?? "?"} -> ${entry.verdict ?? "?"}`;
	return entry.detail ? `${head} — ${entry.detail}` : head;
}

function formatEvidenceMessage(runId: string, pending: PendingRun, outcome: { report?: ManjerokReport; state?: string; error?: string }): string {
	const lines: string[] = [];
	const report = outcome.report;
	if (report) {
		const status = report.status ?? "UNVERIFIED";
		lines.push(`[manjerok] Workflow ${runId} finished: ${status}`);
		lines.push("");
		lines.push(`Task: ${report.task ?? pending.task}`);
		if (report.reason) lines.push(`Reason: ${report.reason}`);
		const a = report.attempts ?? {};
		const b = report.budgets ?? {};
		lines.push(`Attempts: worker ${a.worker ?? 0}/${b.workerAttempts ?? "?"}, senior ${a.senior ?? 0}/${b.seniorAttempts ?? "?"}, review rounds ${a.reviewRounds ?? 0}/${b.reviewRounds ?? "?"} (hard-enforced by the workflow script)`);
		if (report.transitions?.length) {
			lines.push("", "Transition chain:");
			for (const t of report.transitions) lines.push(`- ${formatTransitionLine(t)}`);
		}
		if (report.evidence?.length) {
			lines.push("", "Key evidence (latest, truncated):");
			for (const e of report.evidence.slice(-3)) {
				lines.push("", `--- ${e.source ?? "evidence"} ---`, (e.text ?? "").slice(0, 1500));
			}
		}
		if (report.childRuns?.length) {
			const ids = report.childRuns.filter((c) => c.runId).map((c) => `${c.key}=${c.runId}`);
			if (ids.length) lines.push("", `Child runs: ${ids.join(", ")}`);
		}
	} else {
		lines.push(`[manjerok] Workflow ${runId} finished but its evidence report is UNVERIFIED.`);
		lines.push("");
		lines.push(`Task: ${pending.task}`);
		if (outcome.state) lines.push(`Workflow state: ${outcome.state}`);
		if (outcome.error) lines.push(`Detail: ${outcome.error}`);
		if (pending.asyncDir) lines.push(`Inspect the run directory for the trace and artifacts: ${pending.asyncDir}`);
	}
	lines.push(
		"",
		"---",
		"Primary review: you are the final acceptance gate. Review the actual code changes and the evidence above — not just the summaries. " +
			"If the status is STOPPED or BLOCKED, the diagnosis above is for you: decide the next step or ask the operator. " +
			"If it is DONE, verify the diff yourself before telling the user the task is complete.",
	);
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Command argument parsing
// ---------------------------------------------------------------------------

function parseCommandArgs(raw: string): { task: string; highRisk: boolean; noScout: boolean } | { error: string } {
	// Only the two known flags are parsed; every other token (including `--foo`
	// strings, which are common in coding task prose) belongs to the task text.
	const tokens = raw.split(/\s+/).filter(Boolean);
	let highRisk = false;
	let noScout = false;
	const taskTokens: string[] = [];
	for (const token of tokens) {
		if (token === "--high-risk") highRisk = true;
		else if (token === "--no-scout") noScout = true;
		else taskTokens.push(token);
	}
	const task = taskTokens.join(" ").trim();
	if (!task) return { error: "missing task text" };
	return { task, highRisk, noScout };
}

const USAGE = "Usage: /manjerok <task description> [--high-risk] [--no-scout]";

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	const pendingRuns = new Map<string, PendingRun>();
	const registrations = new Map<string, { hash: string; registration: RuntimeRegistration }>();

	pi.events.on(ASYNC_COMPLETE_EVENT, (payload) => {
		// Emitters disagree on the field: result-watcher sets `id` (falling back to
		// runId), detach-reconcile sets both — accept whichever tracks a pending run.
		const event = payload as { id?: string; runId?: string; asyncDir?: string } | undefined;
		const runId = [event?.id, event?.runId].find((c): c is string => typeof c === "string" && pendingRuns.has(c));
		if (!runId) return;
		const pending = pendingRuns.get(runId)!;
		pendingRuns.delete(runId);
		const outcome = readWorkflowReport(pending.asyncDir ?? event?.asyncDir);
		const content = formatEvidenceMessage(runId, pending, outcome);
		try {
			pi.sendMessage(
				{ customType: "manjerok:report", content, display: true, details: { runId, ...outcome } },
				{ triggerTurn: true },
			);
		} catch (error) {
			console.warn(`[manjerok] failed to deliver evidence report for ${runId}: ${error instanceof Error ? error.message : String(error)}`);
		}
	});

	pi.on("session_shutdown", () => {
		pendingRuns.clear();
		for (const entry of registrations.values()) {
			try {
				entry.registration.dispose();
			} catch {
				// Best-effort cleanup.
			}
		}
		registrations.clear();
	});

	pi.registerCommand("manjerok", {
		description: "Run the manjerok routed workflow (worker ⇄ verifier ⇄ senior ⇄ reviewer). " + USAGE,
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const parsed = parseCommandArgs(args ?? "");
			if ("error" in parsed) {
				ctx.ui.notify(`${parsed.error}. ${USAGE}`, "warning");
				return;
			}

			const loaded = loadConfig(ctx.cwd);

			// Dependency check: pi-subagents RPC bridge must answer a ping.
			try {
				const pong = await rpcCall(pi, "ping", undefined, PING_TIMEOUT_MS);
				if (!isRecord(pong) || pong.version !== 1) {
					ctx.ui.notify("[manjerok] pi-subagents answered with an unexpected RPC protocol — results UNVERIFIED. Consider updating pi-subagents.", "warning");
				}
			} catch (error) {
				ctx.ui.notify(`[manjerok] ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}

			// Optional prompt overrides for the custom roles.
			const roleAgents = {} as Record<RoleName, string>;
			for (const role of ROLE_NAMES) roleAgents[role] = loaded.config.roles[role].agent;
			for (const role of ["verifier", "senior"] as const) {
				const promptFile = loaded.config.prompts[role];
				if (!promptFile) continue;
				const custom = registerPromptOverride(pi, role, promptFile, loaded.promptBaseDirs[role], loaded, registrations);
				if (custom) roleAgents[role] = custom;
			}

			const scoutEnabled = parsed.noScout ? false : loaded.config.roles.scout.enabled !== false;
			const workflowArgs = buildWorkflowArgs(loaded, roleAgents, parsed.task, parsed.highRisk, scoutEnabled);

			let data: unknown;
			try {
				data = await rpcCall(
					pi,
					"spawn",
					{ workflowScript: WORKFLOW_SCRIPT, args: workflowArgs, timeoutMs: loaded.config.timeoutMs },
					SPAWN_TIMEOUT_MS,
				);
			} catch (error) {
				ctx.ui.notify(`[manjerok] spawn failed: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}

			const details = isRecord(data) && isRecord(data.details) ? (data.details as Record<string, unknown>) : {};
			const runId = typeof details.runId === "string" ? details.runId : typeof details.asyncId === "string" ? details.asyncId : undefined;
			const asyncDir = typeof details.asyncDir === "string" ? details.asyncDir : undefined;
			if (runId) {
				pendingRuns.set(runId, { task: parsed.task, ...(asyncDir ? { asyncDir } : {}), startedAt: Date.now() });
			}

			const roleSummary = ROLE_NAMES.map((role) => {
				const modelParam = (workflowArgs.roles as Record<RoleName, WorkflowRoleArg>)[role]!.modelParam;
				return `${role}=${roleAgents[role]}${modelParam ? ` (${modelParam})` : ""}`;
			}).join(", ");
			console.log(`[manjerok] workflow args: highRisk=${parsed.highRisk} scout=${scoutEnabled} budgets=${JSON.stringify(workflowArgs.budgets)} timeoutMs=${loaded.config.timeoutMs} roles: ${roleSummary}`);
			for (const warning of loaded.warnings) console.warn(`[manjerok] config: ${warning}`);

			if (!runId) {
				ctx.ui.notify("[manjerok] spawn succeeded but returned no run id — completion tracking is UNVERIFIED; watch /subagents status.", "warning");
				return;
			}
			ctx.ui.notify(
				`[manjerok] workflow started: ${runId}. Pipeline: ${scoutEnabled ? "scout → " : ""}worker ⇄ verifier${parsed.highRisk ? " → reviewer (high-risk)" : ""}. The evidence report arrives here when it finishes.`,
				"info",
			);
			if (loaded.warnings.length > 0) {
				ctx.ui.notify(`[manjerok] ${loaded.warnings.length} config warning(s) — see console output.`, "warning");
			}
		},
	});
}
