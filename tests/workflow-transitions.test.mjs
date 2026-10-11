import test from 'node:test';
import assert from 'node:assert/strict';
import { runScenario, assertRun, step, W, S, P, F, N, R, X, expectEvidence as e, testOptions } from './helpers/workflow-harness.mjs';

const cases = [
  ['T01', [W('T01-worker'), e(P('T01-pass'), [['worker (attempt 1)', 'T01-worker']])], {}, 'DONE', [0, 0, 0], ['WORKER:READY_FOR_VERIFICATION', 'VERIFIER:CHECKS_PASSED']],
  ['T02', [W('T02-worker'), P('T02-pass'), e(N('T02-review'), [['verifier', 'T02-pass']])], { highRisk: true }, 'DONE', [0, 0, 0], ['WORKER:READY_FOR_VERIFICATION', 'VERIFIER:CHECKS_PASSED', 'REVIEWER:NO_FINDINGS']],
  ['T03', [step('scout', 'COMPLETE', 'T03-scout'), e(W('T03-worker'), [['scout', 'T03-scout']]), P()], { scoutEnabled: true }, 'DONE', [0, 0, 0], ['SCOUT:COMPLETE', 'WORKER:READY_FOR_VERIFICATION', 'VERIFIER:CHECKS_PASSED']],
  ['T04', [step('scout', 'NEEDS_ANALYSIS', 'T04-scout'), e(W('T04-worker'), [['scout', 'T04-scout']]), P()], { scoutEnabled: true }, 'DONE', [0, 0, 0], ['SCOUT:NEEDS_ANALYSIS', 'WORKER:READY_FOR_VERIFICATION', 'VERIFIER:CHECKS_PASSED']],
  ['T05', [W('T05-worker'), P()], {}, 'DONE', [0, 0, 0], ['WORKER:READY_FOR_VERIFICATION', 'VERIFIER:CHECKS_PASSED']],
  ['T06', [W('T06-first'), F('T06-fail'), e(W('T06-second'), [['verifier', 'T06-fail']]), e(P('T06-pass'), [['worker (attempt 2)', 'T06-second']])], {}, 'DONE', [1, 0, 0], ['WORKER:READY_FOR_VERIFICATION', 'VERIFIER:FAIL', 'WORKER:READY_FOR_VERIFICATION', 'VERIFIER:CHECKS_PASSED']],
  ['T07', [W('T07-first'), F('T07-fail-1'), W('T07-second'), F('T07-fail-2'), e(S('T07-senior'), [['worker (attempt 1)', 'T07-first'], ['worker (attempt 2)', 'T07-second'], ['verifier', 'T07-fail-1'], ['verifier', 'T07-fail-2']]), e(P('T07-pass'), [['senior (attempt 1)', 'T07-senior']]), e(N('T07-review'), [['verifier', 'T07-pass']])], {}, 'DONE', [2, 0, 0], ['WORKER:READY_FOR_VERIFICATION', 'VERIFIER:FAIL', 'WORKER:READY_FOR_VERIFICATION', 'VERIFIER:FAIL', 'ESCALATE:worker->senior', 'SENIOR:READY_FOR_VERIFICATION', 'VERIFIER:CHECKS_PASSED', 'REVIEWER:NO_FINDINGS']],
  ['T08', [X('T08-escalation-reason'), e(S('T08-senior'), [['worker (attempt 1)', 'T08-escalation-reason']]), P(), N()], {}, 'DONE', [0, 0, 0], ['WORKER:ESCALATE', 'ESCALATE:worker->senior', 'SENIOR:READY_FOR_VERIFICATION', 'VERIFIER:CHECKS_PASSED', 'REVIEWER:NO_FINDINGS']],
  ['T09', [X(), S('T09-first'), F('T09-fail'), e(S('T09-second'), [['verifier', 'T09-fail']]), e(P('T09-pass'), [['senior (attempt 2)', 'T09-second']]), N()], {}, 'DONE', [0, 1, 0], ['WORKER:ESCALATE', 'ESCALATE:worker->senior', 'SENIOR:READY_FOR_VERIFICATION', 'VERIFIER:FAIL', 'SENIOR:READY_FOR_VERIFICATION', 'VERIFIER:CHECKS_PASSED', 'REVIEWER:NO_FINDINGS']],
  ['T10', [X(), S(), F(), S(), F()], {}, 'STOPPED', [0, 2, 0], ['WORKER:ESCALATE', 'ESCALATE:worker->senior', 'SENIOR:READY_FOR_VERIFICATION', 'VERIFIER:FAIL', 'SENIOR:READY_FOR_VERIFICATION', 'VERIFIER:FAIL']],
  ['T11', [X(), step('senior', 'STOPPED', 'T11_ROOT_CAUSE_DECISION')], {}, 'STOPPED', [0, 0, 0], ['WORKER:ESCALATE', 'ESCALATE:worker->senior', 'SENIOR:STOPPED']],
  ['T12', [W('T12-first'), P('T12-pass-1'), e(R('T12-findings'), [['verifier', 'T12-pass-1']]), e(W('T12-fixed'), [['reviewer', 'T12-findings']]), e(P('T12-pass-2'), [['worker (attempt 1)', 'T12-fixed']]), e(N('T12-review-2'), [['verifier', 'T12-pass-2']])], { highRisk: true }, 'DONE', [0, 0, 1], ['WORKER:READY_FOR_VERIFICATION', 'VERIFIER:CHECKS_PASSED', 'REVIEWER:FINDINGS', 'WORKER:READY_FOR_VERIFICATION', 'VERIFIER:CHECKS_PASSED', 'REVIEWER:NO_FINDINGS']],
  ['T13', [X(), S('T13-first'), P('T13-pass-1'), e(R('T13-findings'), [['verifier', 'T13-pass-1']]), e(S('T13-fixed'), [['reviewer', 'T13-findings']]), e(P('T13-pass-2'), [['senior (attempt 1)', 'T13-fixed']]), e(N('T13-review-2'), [['verifier', 'T13-pass-2']])], {}, 'DONE', [0, 0, 1], ['WORKER:ESCALATE', 'ESCALATE:worker->senior', 'SENIOR:READY_FOR_VERIFICATION', 'VERIFIER:CHECKS_PASSED', 'REVIEWER:FINDINGS', 'SENIOR:READY_FOR_VERIFICATION', 'VERIFIER:CHECKS_PASSED', 'REVIEWER:NO_FINDINGS']],
  ['T14', [W(), P(), R(), W(), P(), R()], { highRisk: true }, 'STOPPED', [0, 0, 2], ['WORKER:READY_FOR_VERIFICATION', 'VERIFIER:CHECKS_PASSED', 'REVIEWER:FINDINGS', 'WORKER:READY_FOR_VERIFICATION', 'VERIFIER:CHECKS_PASSED', 'REVIEWER:FINDINGS']],
  ['T15', [W('T15-first'), P(), R('T15-findings'), e(W('T15-fix'), [['reviewer', 'T15-findings']]), F('T15-fail'), e(W('T15-retry'), [['verifier', 'T15-fail'], ['reviewer', 'T15-findings']]), P(), N()], { highRisk: true }, 'DONE', [1, 0, 1], ['WORKER:READY_FOR_VERIFICATION', 'VERIFIER:CHECKS_PASSED', 'REVIEWER:FINDINGS', 'WORKER:READY_FOR_VERIFICATION', 'VERIFIER:FAIL', 'WORKER:READY_FOR_VERIFICATION', 'VERIFIER:CHECKS_PASSED', 'REVIEWER:NO_FINDINGS']],
];
for (const [id, queue, config, status, counts, verdicts] of cases) {
  test(`${id} explicit route and C07 evidence transfer`, testOptions, async () => {
    const run = await runScenario(queue, config);
    assertRun(run, queue, status, counts);
    assert.deepEqual(run.report.transitions.filter(t => t.verdict !== 'START').map(t => `${t.step}:${t.verdict}`), verdicts, 'substantive transition sequence');
    if (id === 'T05') {
      assert.ok(!run.calls.some(c => c.role === 'scout'));
      assert.ok(!run.report.evidence.some(e => e.source === 'scout'));
      assert.ok(run.calls.every(c => !c.task.includes('### scout')));
    }
    if (id === 'T11') assert.ok(run.report.reason.includes('T11_ROOT_CAUSE_DECISION'));
    if (id === 'T07') assert.deepEqual(run.report.transitions.map(t => [t.step, t.verdict]), [
      ['WORKER', 'START'], ['WORKER', 'READY_FOR_VERIFICATION'], ['VERIFIER', 'START'], ['VERIFIER', 'FAIL'],
      ['WORKER', 'START'], ['WORKER', 'READY_FOR_VERIFICATION'], ['VERIFIER', 'START'], ['VERIFIER', 'FAIL'],
      ['ESCALATE', 'worker->senior'], ['SENIOR', 'START'], ['SENIOR', 'READY_FOR_VERIFICATION'],
      ['VERIFIER', 'START'], ['VERIFIER', 'CHECKS_PASSED'], ['REVIEWER', 'START'], ['REVIEWER', 'NO_FINDINGS'],
    ], 'full structural transition sequence');
  });
}
