// Executed by pi-subagents; keep runtime imports out of this module.
// Sandbox: top-level await, no nested async functions or host globals, frozen args,
// unique keys, single-item runs.all so child failures can arrive as result data.
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
  if (scoutOut.output) pushEvidence("scout", scoutOut.output);
  note("SCOUT", scoutOut.verdict, scoutOut.detail || (scoutOut.verdict === "BLOCKED" ? "scout blocked" : "context gathered"));
  if (scoutOut.verdict === "BLOCKED") return report("BLOCKED", "scout stage: " + (scoutOut.detail || scoutOut.output));
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

