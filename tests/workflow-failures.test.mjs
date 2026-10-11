import test from 'node:test';
import assert from 'node:assert/strict';
import { runScenario, assertRun, targets, W, S, P, F, R, X, testOptions } from './helpers/workflow-harness.mjs';
function failures(role) {
  const success = role === 'scout' ? 'COMPLETE' : ['worker', 'senior'].includes(role) ? 'READY_FOR_VERIFICATION' : role === 'verifier' ? 'CHECKS_PASSED' : 'NO_FINDINGS';
  const base = { key: 'failure-returned-key', runId: 'failure-returned-id' };
  return [
    ['F01 explicit BLOCKED', [{ ...base, ok: true, output: 'PERMISSION_DIAGNOSTIC_MARKER\nVERDICT: BLOCKED' }], /PERMISSION_DIAGNOSTIC_MARKER/],
    ['F02 empty array', [], /no child result/], ['F02 missing first', [undefined], /no child result/],
    ['F03 error', [{ ...base, ok: false, error: 'INFRA_ERROR_MARKER', output: '' }], /INFRA_ERROR_MARKER/],
    ['F04 missing ok', [{ ...base, output: `VERDICT: ${success}` }], /child run failed/],
    ...[false, 1, 'true', null].map(ok => [`F04 nontrue ok ${JSON.stringify(ok)}`, [{ ...base, ok, output: `VERDICT: ${success}` }], /child run failed/]),
    ['F05 stopped plus success', [{ ...base, ok: true, stopped: true, output: `VERDICT: ${success}` }], /child run stopped/],
    ['F05 stopped plus failure', [{ ...base, ok: false, stopped: true, error: 'ERROR', output: '' }], /child run stopped/],
    ['F06 malformed', [{ ...base, ok: true, output: 'MALFORMED_MARKER' }], /malformed verdict/],
  ];
}
for (const target of targets) {
  for (const [name, results, diagnostic] of failures(target.role)) test(`${name} ${target.name}`, testOptions, async () => {
    const queue = [...target.prefix, { role: target.role, results }];
    const run = await runScenario(queue, target.config);
    assertRun(run, queue, 'BLOCKED');
    if (name.startsWith('F01')) assert.match(JSON.stringify([run.report.reason, run.report.evidence]), diagnostic);
    else assert.match(run.report.reason, diagnostic);
  });
}
for (const [name, results, diagnostic] of failures('senior')) test(`F07 accumulated counters: ${name}`, testOptions, async () => {
  const queue = [W(), F(), W(), P(), R(), X(), S(), F(), { role: 'senior', results }];
  const run = await runScenario(queue, { highRisk: true });
  assertRun(run, queue, 'BLOCKED', [1, 1, 1]);
  assert.equal(run.report.childRuns.length, 9);
  assert.match(JSON.stringify([run.report.reason, run.report.evidence]), diagnostic);
});
for (const identifiers of [{}, { key: 'just-key' }, { runId: 'just-id' }, { key: 'both-key', runId: 'both-id' }]) {
  test(`C04/C11 raw child identifier fallback ${JSON.stringify(identifiers)}`, testOptions, async () => {
    const queue = [{ role: 'worker', results: [{ ...identifiers, ok: true, output: 'RAW_MARKER\nVERDICT: BLOCKED' }] }];
    assertRun(await runScenario(queue), queue, 'BLOCKED');
  });
}
test('F rejection propagates from runs.all instead of returning DONE', testOptions, async () => {
  const rejection = new Error('CHILD_REJECTION_MARKER');
  await assert.rejects(runScenario([{ role: 'worker', reject: rejection }]), error => error === rejection);
});
