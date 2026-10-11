import test from 'node:test';
import assert from 'node:assert/strict';
import { runScenario, step, assertRun, testOptions } from './helpers/workflow-harness.mjs';

test('F01/C11 scout BLOCKED preserves diagnostic output', testOptions, async () => {
  const queue = [step('scout', 'BLOCKED', 'SCOUT_PERMISSION_MARKER')];
  const run = await runScenario(queue, { scoutEnabled: true });
  assertRun(run, queue, 'BLOCKED');
  assert.ok(JSON.stringify([run.report.reason, run.report.evidence]).includes('SCOUT_PERMISSION_MARKER'), 'blocked scout diagnostic marker preserved');
  assert.notEqual(run.report.transitions.at(-1).detail, 'context gathered', 'blocked scout must not claim success');
});
