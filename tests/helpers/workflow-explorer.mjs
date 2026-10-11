import assert from 'node:assert/strict';
import { allowed, compileWorkflow, makeArgs } from './workflow-harness.mjs';
class Frontier extends Error {
  constructor(role) { super(`unexplored ${role}`); this.role = role; }
}
export function childRunBound(config) {
  const { workerAttempts: W, seniorAttempts: S, reviewRounds: R } = config.budgets;
  return (config.scoutEnabled ? 1 : 0) + 2 * W + 2 * S + 3 * R - 2;
}
function invariants(report, calls, config) {
  let seniorSeen = false, lastImplementer, findingsIndex = -1;
  let workerFailures = 0, seniorFailures = 0, findings = 0;
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i];
    if (call.role === 'senior') seniorSeen = true;
    if (call.role === 'worker') assert.equal(seniorSeen, false, 'worker returned after senior');
    if (['worker', 'senior'].includes(call.role)) lastImplementer = call.role;
    if (call.role === 'reviewer') {
      assert.equal(calls[i - 1]?.role, 'verifier', 'reviewer needs preceding verifier');
      assert.equal(calls[i - 1]?.token, 'CHECKS_PASSED', 'reviewer needs successful verifier');
      if (findingsIndex >= 0) {
        const since = calls.slice(findingsIndex + 1, i);
        assert.ok(since.some(c => ['worker', 'senior'].includes(c.role)), 'new implementation after FINDINGS');
        assert.ok(since.some(c => c.role === 'verifier' && c.token === 'CHECKS_PASSED'), 'new successful verification after FINDINGS');
      }
      if (call.token === 'FINDINGS') { findings++; findingsIndex = i; }
    }
    if (call.role === 'verifier' && call.token === 'FAIL') {
      if (lastImplementer === 'worker') workerFailures++; else seniorFailures++;
    }
    if (call.token === 'BLOCKED' || (call.role === 'senior' && call.token === 'STOPPED') || (call.role === 'reviewer' && call.token === 'NO_FINDINGS')) {
      assert.equal(i, calls.length - 1, 'launch after terminal child response');
    }
  }
  assert.deepEqual(report.attempts, { worker: workerFailures, senior: seniorFailures, reviewRounds: findings }, 'observed failures match counters');
  assert.ok(report.attempts.worker <= config.budgets.workerAttempts);
  assert.ok(report.attempts.senior <= config.budgets.seniorAttempts);
  assert.ok(report.attempts.reviewRounds <= config.budgets.reviewRounds);
  if (report.status === 'DONE' && (config.highRisk || seniorSeen)) {
    assert.equal(calls.at(-1)?.role, 'reviewer', 'DONE requires review');
    assert.equal(calls.at(-1)?.token, 'NO_FINDINGS', 'DONE requires NO_FINDINGS');
  }
  assert.equal(report.childRuns.length, calls.length);
}
export async function explore(config, scenarioLimit = 10000) {
  const args = makeArgs(config), execute = compileWorkflow();
  const maxChildRuns = childRunBound(args);
  const branches = [[]];
  const families = { DONE: 0, STOPPED: 0, BLOCKED: 0, escalation: 0, repeatedReview: 0 };
  let completed = 0, visited = 0, longest = 0;
  while (branches.length && visited < scenarioLimit) {
    const prefix = branches.shift(), calls = [];
    visited++;
    try {
      const report = await execute(args, { all: async items => {
        assert.equal(items.length, 1);
        assert.ok(calls.length < maxChildRuns, 'E01 attempted launch beyond budget-derived bound');
        const role = Object.keys(args.roles).find(r => args.roles[r].agent === items[0].agent);
        if (calls.length === prefix.length) throw new Frontier(role);
        const choice = prefix[calls.length];
        assert.equal(choice.role, role, 'exploration prefix role');
        calls.push(choice);
        return [{ key: items[0].key, runId: `enumerated-${calls.length}`, ok: true, output: `VERDICT: ${choice.token}` }];
      } }, () => {}, { log() {} });
      assert.equal(calls.length, prefix.length, 'terminal report left responses unused');
      invariants(report, calls, args);
      completed++;
      longest = Math.max(longest, calls.length);
      families[report.status]++;
      if (report.transitions.some(t => t.step === 'ESCALATE')) families.escalation++;
      if (calls.filter(c => c.role === 'reviewer').length > 1) families.repeatedReview++;
      const count = calls.length;
      await Promise.resolve();
      assert.equal(calls.length, count, 'new launch after workflow report');
    } catch (error) {
      if (error instanceof Frontier) {
        for (const token of allowed[error.role]) branches.push([...prefix, { role: error.role, token }]);
      } else {
        error.message += `\nE01 config=${JSON.stringify(config)}\nresponses=${JSON.stringify(prefix)}`;
        throw error;
      }
    }
  }
  for (const family of ['DONE', 'STOPPED', 'BLOCKED', 'escalation']) assert.ok(families[family] > 0, `E01 missing ${family}: ${JSON.stringify(config)}`);
  if (args.budgets.reviewRounds === 2) assert.ok(families.repeatedReview > 0, `E01 missing repeated review: ${JSON.stringify(config)}`);
  return { config: { budgets: args.budgets, highRisk: args.highRisk, scoutEnabled: args.scoutEnabled }, maxChildRuns, visitedPrefixes: visited, completedScenarios: completed, truncatedBranches: branches.length, longestCompleted: longest, families };
}
export function configurations() {
  const result = [];
  for (const workerAttempts of [1, 2]) for (const seniorAttempts of [1, 2]) for (const reviewRounds of [1, 2]) for (const highRisk of [false, true]) for (const scoutEnabled of [false, true]) {
    result.push({ budgets: { workerAttempts, seniorAttempts, reviewRounds }, highRisk, scoutEnabled });
  }
  return result;
}
