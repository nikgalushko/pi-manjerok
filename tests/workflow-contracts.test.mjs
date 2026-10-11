import test from 'node:test';
import assert from 'node:assert/strict';
import { runScenario, assertRun, makeArgs, step, W, S, P, F, N, R, X, deferred, allowed, evidenceEntries, testOptions, ROLES } from './helpers/workflow-harness.mjs';

const roleModels = {
  scout: 'provider/scout:low', worker: 'provider/worker:medium', senior: 'provider/senior:high',
  verifier: 'provider/verifier:high', reviewer: 'provider/reviewer:low',
};
for (const role of ROLES) {
  for (const [name, modelParam] of [['nonempty', roleModels[role]], ['null', null], ['empty', '']]) {
    test(`C01/C02 ${role} ${name} model, other roles use distinct explicit models`, testOptions, async () => {
      // Every scenario launches all five roles. Distinct models on the other roles
      // expose accidental inheritance even when the target has no explicit model.
      const roles = Object.fromEntries(ROLES.map(name => [name, { modelParam: roleModels[name] }]));
      roles[role].modelParam = modelParam;
      const queue = [step('scout', 'COMPLETE'), X(), S(), P(), R(), S(), P(), N()];
      assertRun(await runScenario(queue, { scoutEnabled: true, roles }), queue, 'DONE', [0, 0, 1]);
    });
  }
}

test('C03 repeated verifier/reviewer calls use fresh context', testOptions, async () => {
  const queue = [W(), F(), W(), P(), R(), W(), P(), N()];
  assertRun(await runScenario(queue, { highRisk: true }), queue, 'DONE', [1, 0, 1]);
});

test('C05 pending child Promise prevents any second launch', testOptions, async t => {
  const gate = deferred(), started = deferred();
  let launches = 0;
  const queue = [
    { ...W(), wait: gate.promise, inspect: () => { launches++; started.resolve(); } },
    { ...P(), inspect: () => { launches++; } },
  ];
  t.after(() => gate.resolve());
  const execution = runScenario(queue);
  await started.promise;
  assert.equal(launches, 1, 'second launch cannot precede child completion');
  gate.resolve();
  assertRun(await execution, queue, 'DONE');
  assert.equal(launches, 2);
});

function checkPackets(queue, expected, config) {
  queue.forEach((fixture, i) => {
    fixture.inspect = call => {
      const [used, budget] = expected[i];
      assert.ok(call.task.includes('Goal: Implement the original acceptance criteria TASK_MARKER'), 'C06 original task');
      assert.ok(call.task.includes(`Role: ${fixture.role}. Attempts used on this tier: ${used} of ${budget}.`), 'C06 role/counter/budget');
      assert.ok(call.task.includes(config.highRisk ? 'Risk profile: HIGH' : 'Risk profile: normal.'), 'C06 risk profile');
      const protocolLine = call.task.split('\n').find(line => line.startsWith('The last line of your final response must be exactly one of:'));
      assert.equal(protocolLine, 'The last line of your final response must be exactly one of: ' + allowed[fixture.role].map(v => `VERDICT: ${v}`).join(' | '), 'C06 permitted verdicts');
    };
  });
  return runScenario(queue, config);
}
test('C06 direct escalation and repeated reviewer packet counters', testOptions, async () => {
  const queue = [step('scout', 'COMPLETE'), X(), S(), F(), S(), P(), R(), S(), P(), N()];
  const config = { scoutEnabled: true, highRisk: true };
  const run = await checkPackets(queue, [[0, 0], [0, 2], [0, 2], [0, 0], [1, 2], [0, 0], [0, 2], [1, 2], [0, 0], [1, 2]], config);
  assertRun(run, queue, 'DONE', [0, 1, 1]);
});
test('C06 senior packet after worker budget exhaustion', testOptions, async () => {
  const queue = [W(), F(), W(), F(), S(), P(), N()];
  const run = await checkPackets(queue, [[0, 2], [0, 0], [1, 2], [0, 0], [0, 2], [0, 0], [0, 2]], {});
  assertRun(run, queue, 'DONE', [2, 0, 0]);
});

test('C08/C09 chronological bounded evidence, eight in packets and six in report', testOptions, async () => {
  const queue = [W(), P(), R(), W(), P(), R(), W(), P(), R(), W(), P(), R(), W(), P(), N()];
  const sources = ['worker (attempt 1)', 'verifier', 'reviewer', 'worker (attempt 1)', 'verifier', 'reviewer', 'worker (attempt 1)', 'verifier', 'reviewer', 'worker (attempt 1)', 'verifier', 'reviewer', 'worker (attempt 1)', 'verifier', 'reviewer'];
  queue.forEach((fixture, i) => {
    const marker = `HISTORY_${String(i + 1).padStart(2, '0')}_MARKER`;
    fixture.output = marker + '\n' + fixture.output.split('\n').at(-1);
    fixture.inspect = call => {
      const expected = queue.slice(Math.max(0, i - 8), i).map((entry, j) => ({ source: sources[Math.max(0, i - 8) + j], text: entry.output }));
      assert.deepEqual(evidenceEntries(call.task), expected, 'oldest-first last eight prior outputs');
      assert.ok(!call.task.includes(marker), 'future output absent');
      for (const old of queue.slice(0, Math.max(0, i - 8))) assert.ok(!call.task.includes(old.output.split('\n')[0]), 'evicted output absent');
    };
  });
  const run = await runScenario(queue, { highRisk: true, budgets: { reviewRounds: 5 } });
  assertRun(run, queue, 'DONE', [0, 0, 4]);
  assert.deepEqual(run.report.evidence, queue.slice(-6).map((entry, i) => ({ source: sources[9 + i], text: entry.output })), 'report retains last six');
});

test('C10 evidence truncates at 6000 JS units and task only in report at 500', testOptions, async () => {
  const task = 'TASK_FULL_'.repeat(90);
  const output = '😀'.repeat(3100) + '\nVERDICT: READY_FOR_VERIFICATION';
  const queue = [
    { role: 'worker', output, inspect: call => assert.ok(call.task.includes(task), 'full task in first packet') },
    { ...P(), inspect: call => {
      assert.ok(call.task.includes(task), 'full task in verifier packet');
      assert.equal(evidenceEntries(call.task)[0].text, output.slice(0, 6000) + '\n…[truncated]', 'first 6000 UTF-16 units plus marker');
    } },
  ];
  const run = await runScenario(queue, { task });
  assertRun(run, queue, 'DONE');
  assert.equal(run.report.task, task.slice(0, 500) + '\n…[truncated]');
  assert.equal(run.report.evidence[0].text, output.slice(0, 6000) + '\n…[truncated]');
});

test('C10 reason truncates at 600 and transition detail at 300', testOptions, async () => {
  const diagnostic = 'DIAG_'.repeat(200);
  const scoutAgent = 'SCOUT_AGENT_'.repeat(35);
  const queue = [step('scout', 'COMPLETE'), X(), step('senior', 'STOPPED', diagnostic)];
  const run = await runScenario(queue, { scoutEnabled: true, roles: { scout: { agent: scoutAgent } } });
  assertRun(run, queue, 'STOPPED');
  const fullReason = 'senior stopped deliberately. Diagnosis: ' + (queue[2].output.slice(0, 800) + '\n…[truncated]');
  assert.equal(run.report.reason, fullReason.slice(0, 600) + '\n…[truncated]');
  assert.equal(run.report.transitions[0].detail, scoutAgent.slice(0, 300) + '\n…[truncated]');
});

for (const [status, queue, counts] of [
  ['DONE', [W(), P()], [0, 0, 0]], ['STOPPED', [X(), step('senior', 'STOPPED', 'DIAGNOSIS')], [0, 0, 0]],
  ['BLOCKED', [W(), F(), step('worker', 'BLOCKED', 'C11_BLOCKED_MARKER')], [1, 0, 0]],
]) test(`C11/C12 complete ${status} report and matching transition events`, testOptions, async () => {
  const run = await runScenario(queue);
  assertRun(run, queue, status, counts);
  assert.equal(run.report.task, run.args.task);
  assert.equal(typeof run.report.reason, 'string');
  if (status === 'BLOCKED') assert.ok(run.report.evidence.some(e => e.text.includes('C11_BLOCKED_MARKER')));
  assert.ok(!run.events.some(e => ['DONE', 'STOPPED', 'BLOCKED'].includes(e.step)), 'no invented terminal event');
});

test('C13 repeated executions start empty without modifying recursively frozen args', testOptions, async () => {
  const args = makeArgs({ highRisk: true });
  const before = structuredClone(args);
  assert.ok(Object.isFrozen(args) && Object.isFrozen(args.roles) && Object.isFrozen(args.roles.worker) && Object.isFrozen(args.budgets));
  const firstQueue = [W(), F(), W(), P(), R(), W(), P(), N()];
  assertRun(await runScenario(firstQueue, {}, { args }), firstQueue, 'DONE', [1, 0, 1]);
  const nextQueue = [W(), P(), N()];
  nextQueue[0].inspect = call => assert.deepEqual(evidenceEntries(call.task), [], 'no previous-run evidence');
  const second = await runScenario(nextQueue, {}, { args });
  assertRun(second, nextQueue, 'DONE');
  assert.equal(second.calls[0].key, 'worker-1');
  assert.deepEqual(second.report.transitions[0], { step: 'WORKER', verdict: 'START', detail: 'tier=worker attempts_used=0/2' });
  assert.deepEqual(args, before);
});
