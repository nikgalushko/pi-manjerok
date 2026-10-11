import test from 'node:test';
import assert from 'node:assert/strict';
import { runScenario, assertRun, targets, allowed, successfulSuffix, testOptions } from './helpers/workflow-harness.mjs';
async function check(target, output, expected, name) {
  const queue = [...target.prefix, { role: target.role, output }, ...successfulSuffix(target.role, expected, target)];
  const run = await runScenario(queue, target.config);
  const status = expected === 'BLOCKED' ? 'BLOCKED' : expected === 'STOPPED' ? 'STOPPED' : 'DONE';
  const counts = expected === 'FAIL' ? (target.name === 'verifier-senior' ? [0, 1, 0] : [1, 0, 0]) : expected === 'FINDINGS' ? [0, 0, 1] : [0, 0, 0];
  assertRun(run, queue, status, counts);
  const transition = run.report.transitions.filter(t => t.step === target.role.toUpperCase() && t.verdict !== 'START')[target.role === 'worker' && target.prefix.length ? 1 : 0];
  assert.equal(transition.verdict, expected, name);
  return run;
}
for (const target of targets) {
  for (const token of allowed[target.role]) {
    test(`V01 ${target.name} accepts ${token}`, testOptions, () => check(target, `VERDICT: ${token}`, token));
    for (const newline of ['\n', '\r\n']) test(`V02 ${target.name} ${token} ${JSON.stringify(newline)}`, testOptions,
      () => check(target, `Explanation${newline}VERDICT:\t${token} \t${newline}\t${newline}`, token));
  }
  const invalid = [
    ['V04 missing', 'No final verdict'], ['V04 empty', ''], ['V04 nonstring', { verdict: 'BLOCKED' }], ['V04 null', null],
    ['V05 hedged', 'VERDICT: FAIL because uncertain'], ['V05 embedded', 'My VERDICT: BLOCKED'],
    ['V06 text after', 'VERDICT: BLOCKED\npostscript'], ['V06 closing fence', '```\nVERDICT: BLOCKED\n```'],
    ['V07 unknown', 'VERDICT: MADE_UP'], ['V07 other role', `VERDICT: ${target.role === 'senior' ? 'ESCALATE' : target.role === 'worker' ? 'STOPPED' : 'READY_FOR_VERIFICATION'}`],
    ['V08 prefix case', 'verdict: BLOCKED'], ['V08 token case', 'VERDICT: blocked'], ['V08 indentation', ' VERDICT: BLOCKED'],
  ];
  for (const [name, output] of invalid) test(`${name} ${target.name}`, testOptions, async () => {
    const run = await check(target, output, 'BLOCKED', name);
    assert.match(run.report.reason, /malformed verdict/);
  });
  const success = target.role === 'scout' ? 'COMPLETE' : ['worker', 'senior'].includes(target.role) ? 'READY_FOR_VERIFICATION' : target.role === 'verifier' ? 'CHECKS_PASSED' : 'NO_FINDINGS';
  test(`V13 ${target.name} parses complete output before evidence truncation`, testOptions,
    () => check(target, 'LONG_OUTPUT'.repeat(800) + `\nVERDICT: ${success}`, success));
}
for (const target of targets.filter(t => t.role === 'verifier')) {
  test(`V03 ${target.name} FAIL then PASS`, testOptions, () => check(target, 'VERDICT: FAIL\nVERDICT: CHECKS_PASSED', 'CHECKS_PASSED'));
  test(`V03 ${target.name} PASS then FAIL`, testOptions, () => check(target, 'VERDICT: CHECKS_PASSED\nVERDICT: FAIL', 'FAIL'));
}
for (const target of targets.filter(t => t.role === 'reviewer')) {
  const cases = [
    ['V03 native BLOCK then OK', 'Merge verdict: BLOCK\nMerge verdict: OK', 'NO_FINDINGS'],
    ['V03 native OK then BLOCK', 'Merge verdict: OK\nMerge verdict: BLOCK', 'FINDINGS'],
    ['V09 native BLOCK', 'Merge verdict: BLOCK', 'FINDINGS'],
    ['V10 OK', 'Merge verdict: OK', 'NO_FINDINGS'], ['V10 notes', 'Merge verdict: OK with notes', 'NO_FINDINGS'],
    ['V10 lowercase', 'Merge verdict: ok with notes', 'NO_FINDINGS'], ['V10 mixed case', 'Merge verdict: oK WiTh NoTeS', 'NO_FINDINGS'],
    ['V11 unknown', 'Merge verdict: MAYBE', 'BLOCKED'], ['V11 text tail', 'Merge verdict: OK\nmore', 'BLOCKED'],
    ['V11 inline tail', 'Merge verdict: OK because yes', 'BLOCKED'], ['V11 prefix case', 'merge verdict: OK', 'BLOCKED'],
    ['V12 native then final direct', 'Merge verdict: BLOCK\nVERDICT: NO_FINDINGS', 'NO_FINDINGS'],
    ['V12 direct then final native', 'VERDICT: FINDINGS\nMerge verdict: OK', 'NO_FINDINGS'],
    ['V12 unusable direct then final native BLOCK', 'VERDICT: WRONG because hedged\nMerge verdict: BLOCK', 'FINDINGS'],
    ['V12 final invalid direct prevents earlier native', 'Merge verdict: OK\nVERDICT: FAIL', 'BLOCKED'],
    ['V09 direct BLOCKED stays infrastructure', 'VERDICT: BLOCKED', 'BLOCKED'],
  ];
  for (const [name, output, expected] of cases) test(`${name} ${target.name}`, testOptions, () => check(target, output, expected, name));
}
