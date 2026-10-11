import assert from 'node:assert/strict';
import { WORKFLOW_SCRIPT } from '../../extensions/manjerok/workflow.js';

export const ROLES = ['scout', 'worker', 'senior', 'verifier', 'reviewer'];
export const allowed = {
  scout: ['COMPLETE', 'NEEDS_ANALYSIS', 'BLOCKED'],
  worker: ['READY_FOR_VERIFICATION', 'ESCALATE', 'BLOCKED'],
  senior: ['READY_FOR_VERIFICATION', 'STOPPED', 'BLOCKED'],
  verifier: ['CHECKS_PASSED', 'FAIL', 'BLOCKED'],
  reviewer: ['FINDINGS', 'NO_FINDINGS', 'BLOCKED'],
};
export const testOptions = { timeout: 5000 };
export function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}
export function makeArgs(overrides = {}) {
  return deepFreeze({
    task: 'Implement the original acceptance criteria TASK_MARKER',
    highRisk: false,
    scoutEnabled: false,
    ...overrides,
    budgets: { workerAttempts: 2, seniorAttempts: 2, reviewRounds: 2, ...overrides.budgets },
    roles: Object.fromEntries(ROLES.map(role => [role, {
      agent: `configured-${role}`, modelParam: null, ...overrides.roles?.[role],
    }])),
  });
}
export function step(role, verdict, marker = `${role}_${verdict}`) {
  return { role, marker, output: `${marker}\nVERDICT: ${verdict}` };
}
export const W = marker => step('worker', 'READY_FOR_VERIFICATION', marker);
export const S = marker => step('senior', 'READY_FOR_VERIFICATION', marker);
export const P = marker => step('verifier', 'CHECKS_PASSED', marker);
export const F = marker => step('verifier', 'FAIL', marker);
export const N = marker => step('reviewer', 'NO_FINDINGS', marker);
export const R = marker => step('reviewer', 'FINDINGS', marker);
export const X = marker => step('worker', 'ESCALATE', marker);
export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
export function compileWorkflow(script = WORKFLOW_SCRIPT) {
  return new AsyncFunction('args', 'runs', 'emit', 'console', script);
}
// The queue specifies roles and responses, never predicts production routing.
// Raw results are deliberately untouched: missing envelope fields remain missing.
export async function runScenario(queue, overrides = {}, options = {}) {
  const args = options.args ?? makeArgs(overrides);
  const before = JSON.stringify(args);
  const calls = [], events = [], logs = [];
  const limit = options.maxCalls ?? Math.max(queue.length, 1);
  const runs = { all: async items => {
    assert.ok(Array.isArray(items));
    assert.equal(items.length, 1, 'one child per runs.all');
    assert.ok(calls.length < limit, 'child-call bound exceeded');
    const fixture = queue[calls.length];
    assert.ok(fixture, 'unexpected child launch');
    const item = items[0];
    const role = ROLES.find(name => args.roles[name].agent === item.agent);
    assert.equal(role, fixture.role, 'queued role order');
    const call = { role, ...structuredClone(item) };
    calls.push(call);
    fixture.inspect?.(call, calls);
    if (fixture.reject) throw fixture.reject;
    if (fixture.wait) await fixture.wait;
    const result = Object.hasOwn(fixture, 'results') ? fixture.results : [{
      key: `returned-${calls.length}`, runId: `child-${calls.length}`,
      ok: true, output: fixture.output,
    }];
    call.results = result;
    return result;
  } };
  let timer;
  const execution = compileWorkflow(options.script)(args, runs, e => events.push(structuredClone(e)), { log: (...xs) => logs.push(xs.join(' ')) });
  try {
    const report = await Promise.race([execution, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('harness deadline exceeded (not the production timeout)')), options.timeoutMs ?? 2000);
    })]);
    assert.equal(calls.length, queue.length, 'unused queued response');
    assert.equal(JSON.stringify(args), before, 'workflow changed frozen args');
    return { report, calls, events, logs, args };
  } finally { clearTimeout(timer); }
}
export function assertRun(run, queue, status, counts = [0, 0, 0]) {
  assert.deepEqual(run.calls.map(c => c.role), queue.map(s => s.role), 'exact role sequence');
  assert.equal(run.report.status, status, 'terminal status');
  assert.deepEqual(run.report.attempts, { worker: counts[0], senior: counts[1], reviewRounds: counts[2] }, 'attempt counters');
  assert.equal(run.report.schema, 'manjerok-report/v1');
  assert.equal(run.report.highRisk, run.args.highRisk);
  assert.deepEqual(run.report.budgets, run.args.budgets);
  assert.equal(run.report.childRuns.length, run.calls.length, 'one childRuns record per returned array');
  assert.deepEqual(run.events, run.report.transitions.map(entry => ({ type: 'manjerok:transition', ...entry })), 'C12 transition events');
  assert.equal(run.logs.length, run.events.length);
  const keys = run.calls.map(c => c.key);
  assert.equal(new Set(keys).size, keys.length, 'C04 unique request keys');
  run.calls.forEach((call, i) => {
    const result = call.results[0];
    assert.deepEqual(run.report.childRuns[i], {
      step: call.role.toUpperCase(), key: result?.key || call.role.toUpperCase(),
      runId: result?.runId || null, ok: result?.ok === true,
    }, 'childRuns preserves strict ok and result identifiers/fallbacks');
    assert.equal(call.agent, run.args.roles[call.role].agent, 'C01 role agent');
    if (['verifier', 'reviewer'].includes(call.role)) assert.equal(call.context, 'fresh', 'C03 fresh context');
    else assert.equal(Object.hasOwn(call, 'context'), false, 'C03 other contexts absent');
    if (run.args.roles[call.role].modelParam) assert.equal(call.model, run.args.roles[call.role].modelParam, `C01 exact model for ${call.role}`);
    else assert.equal(Object.hasOwn(call, 'model'), false, 'C02 absent model');
  });
}
export function evidenceEntries(packet) {
  const text = packet.split('## Evidence from previous steps (oldest first)')[1]?.split('\n## Protocol')[0] ?? '';
  return [...text.matchAll(/\n### ([^\n]+)\n([\s\S]*?)(?=\n### |$)/g)].map(m => ({ source: m[1], text: m[2].trim() }));
}
export function expectEvidence(fixture, expected) {
  fixture.inspect = call => {
    const entries = evidenceEntries(call.task);
    for (const [source, marker] of expected) {
      assert.ok(entries.some(e => e.source === source && e.text.includes(marker)), `${fixture.role} missing ${source} evidence ${marker}`);
    }
    if (fixture.marker) assert.ok(!call.task.includes(fixture.marker), 'C08 future response absent');
  };
  return fixture;
}
// Explicit prefixes reach each role/tier for protocol/failure matrices.
export const targets = [
  { name: 'scout', role: 'scout', prefix: [], config: { scoutEnabled: true } },
  { name: 'worker', role: 'worker', prefix: [], config: {} },
  { name: 'senior', role: 'senior', prefix: [X('prefix-escalation')], config: {} },
  { name: 'verifier-worker', role: 'verifier', prefix: [W('prefix-worker')], config: {} },
  { name: 'verifier-senior', role: 'verifier', prefix: [X('prefix-escalation'), S('prefix-senior')], config: {} },
  { name: 'reviewer-high-risk', role: 'reviewer', prefix: [W('prefix-worker'), P('prefix-pass')], config: { highRisk: true } },
  { name: 'reviewer-post-escalation', role: 'reviewer', prefix: [X('prefix-escalation'), S('prefix-senior'), P('prefix-pass')], config: {} },
];
export function successfulSuffix(role, verdict, target) {
  // These are hand-written public expected paths, not an FSM simulator.
  if (role === 'scout' && verdict !== 'BLOCKED') return [W(), P()];
  if (role === 'worker' && verdict === 'READY_FOR_VERIFICATION') return [P()];
  if (role === 'worker' && verdict === 'ESCALATE') return [S(), P(), N()];
  if (role === 'senior' && verdict === 'READY_FOR_VERIFICATION') return [P(), N()];
  if (role === 'verifier' && verdict === 'CHECKS_PASSED') return target.name === 'verifier-senior' ? [N()] : [];
  if (role === 'verifier' && verdict === 'FAIL') return target.name === 'verifier-senior' ? [S(), P(), N()] : [W(), P()];
  if (role === 'reviewer' && verdict === 'FINDINGS') return target.name === 'reviewer-post-escalation' ? [S(), P(), N()] : [W(), P(), N()];
  return [];
}
