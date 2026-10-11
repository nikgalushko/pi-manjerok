import test from 'node:test';
import { runScenario, assertRun, W, S, P, F, N, R, X, testOptions } from './helpers/workflow-harness.mjs';
const cases = [
  ['B01 worker limit 1', [W(), F(), S(), P(), N()], { workerAttempts: 1 }, false, 'DONE', [1, 0, 0]],
  ['B02 senior limit 1', [X(), S(), F()], { seniorAttempts: 1 }, false, 'STOPPED', [0, 1, 0]],
  ['B03 review limit 1', [W(), P(), R()], { reviewRounds: 1 }, true, 'STOPPED', [0, 0, 1]],
  ['B04 worker limit 2', [W(), F(), W(), F(), S(), P(), N()], { workerAttempts: 2 }, false, 'DONE', [2, 0, 0]],
  ['B04 worker limit 3', [W(), F(), W(), F(), W(), F(), S(), P(), N()], { workerAttempts: 3 }, false, 'DONE', [3, 0, 0]],
  ['B04 senior limit 2', [X(), S(), F(), S(), F()], { seniorAttempts: 2 }, false, 'STOPPED', [0, 2, 0]],
  ['B04 senior limit 3', [X(), S(), F(), S(), F(), S(), F()], { seniorAttempts: 3 }, false, 'STOPPED', [0, 3, 0]],
  ['B04 review limit 2', [W(), P(), R(), W(), P(), R()], { reviewRounds: 2 }, true, 'STOPPED', [0, 0, 2]],
  ['B04 review limit 3', [W(), P(), R(), W(), P(), R(), W(), P(), R()], { reviewRounds: 3 }, true, 'STOPPED', [0, 0, 3]],
  ['B05 independent limits 1/3/2', [W(), F(), S(), F(), S(), F(), S(), P(), R(), S(), F()], { workerAttempts: 1, seniorAttempts: 3, reviewRounds: 2 }, true, 'STOPPED', [1, 3, 1]],
  ['B06 worker counter survives PASS and FINDINGS', [W(), F(), W(), P(), R(), W(), F(), S(), P(), N()], {}, true, 'DONE', [2, 0, 1]],
  ['B07 senior counter survives PASS and FINDINGS', [X(), S(), F(), S(), P(), R(), S(), F()], {}, false, 'STOPPED', [0, 2, 1]],
  ['B08 reviewer budget shared across escalation', [W(), P(), R(), X(), S(), P(), R()], {}, true, 'STOPPED', [0, 0, 2]],
  ['B09 successful and ESCALATE verdicts do not consume budgets', [W(), P(), R(), X(), S(), P(), N()], { reviewRounds: 3 }, true, 'DONE', [0, 0, 1]],
  ['B09 zero counters on ESCALATE READY PASS NO_FINDINGS', [X(), S(), P(), N()], {}, false, 'DONE', [0, 0, 0]],
];
for (const [name, queue, budgets, highRisk, status, counts] of cases) {
  test(name, testOptions, async () => assertRun(await runScenario(queue, { budgets, highRisk }), queue, status, counts));
}
