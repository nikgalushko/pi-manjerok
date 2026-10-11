import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, cp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { compileWorkflow } from '../tests/helpers/workflow-harness.mjs';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = await readFile(join(root, 'extensions/manjerok/workflow.js'), 'utf8');
const files = (await readdir(join(root, 'tests'))).filter(f => f.endsWith('.test.mjs')).map(f => `tests/${f}`);
const baseline = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], { cwd: root, encoding: 'utf8', timeout: 15000 });
assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
function replaceOnce(text, from, to) {
  assert.equal(text.split(from).length - 1, 1, `mutation anchor must be unique: ${from}`);
  return text.replace(from, to);
}
const cases = [
  {
    mutation: 'M01.1 worker budget >= becomes >', file: 'workflow-budgets.test.mjs', test: 'B01 worker limit 1', expectation: 'queued role order',
    change: s => replaceOnce(s, 'workerAttempts >= budgets.workerAttempts', 'workerAttempts > budgets.workerAttempts'),
    violated: 'First FAIL at worker limit 1 must launch senior, not another worker.',
  },
  {
    mutation: 'M01.2 remove mandatory senior review', file: 'workflow-transitions.test.mjs', test: 'T07 explicit route', expectation: 'unused queued response',
    change: s => replaceOnce(s, 'if (highRisk || tier === "senior")', 'if (highRisk)'),
    violated: 'Successful senior verification must consume the queued reviewer before DONE.',
  },
  {
    mutation: 'M01.3 FINDINGS goes straight to reviewer', file: 'workflow-transitions.test.mjs', test: 'T12 explicit route', expectation: 'queued role order',
    change: s => replaceOnce(s, '    phase = "IMPLEMENT";\n    continue;\n  }\n  return report', '    phase = "REVIEW";\n    continue;\n  }\n  return report'),
    violated: 'FINDINGS must launch the current implementer before any next review.',
  },
  {
    mutation: 'M01.4 reset verification counters on PASS', file: 'workflow-budgets.test.mjs', test: 'B06 worker counter', expectation: 'queued role order',
    change: s => replaceOnce(s, '    if (highRisk || tier === "senior")', '    workerAttempts = 0; seniorAttempts = 0;\n    if (highRisk || tier === "senior")'),
    violated: 'Worker FAIL counter survives PASS and review; the second FAIL reaches its limit.',
  },
  {
    mutation: 'M01.5 reset shared review counter on escalation', file: 'workflow-budgets.test.mjs', test: 'B08 reviewer budget', expectation: 'child-call bound exceeded',
    change: s => s.replaceAll('tier = "senior";', 'tier = "senior"; reviewRoundsUsed = 0;'),
    violated: 'Second FINDINGS exhausts the shared limit even after changing implementer; no extra child may launch.',
  },
  {
    mutation: 'M01.6 malformed verifier verdict becomes success', file: 'workflow-verdicts.test.mjs', test: 'V04 missing verifier-worker', expectation: 'terminal status',
    change: s => replaceOnce(s, 'return { verdict: parsed.verdict, detail: parsed.detail, output:', 'return { verdict: roleName === "verifier" && parsed.detail ? "CHECKS_PASSED" : parsed.verdict, detail: parsed.detail, output:'),
    violated: 'Missing verifier verdict is BLOCKED, never DONE.',
  },
  {
    mutation: 'M01.7 remove fresh context', file: 'workflow-contracts.test.mjs', test: 'C03 repeated', expectation: 'C03 fresh context',
    change: s => replaceOnce(s, '  if (role === "verifier" || role === "reviewer") item.context = "fresh";\n', ''),
    violated: 'Every verifier and reviewer launch explicitly requests fresh context.',
  },
  {
    mutation: 'M01.8 zero accumulated counters on BLOCKED', file: 'workflow-failures.test.mjs', test: 'F07 accumulated counters: F01', expectation: 'attempt counters',
    change: s => replaceOnce(s, 'function report(status, reason) {', 'function report(status, reason) {\n  if (status === "BLOCKED") { workerAttempts = 0; seniorAttempts = 0; reviewRoundsUsed = 0; }'),
    violated: 'BLOCKED preserves accumulated worker/senior/review counters 1/1/1.',
  },
  {
    mutation: 'M01.9 omit latest implementation from verifier packet', file: 'workflow-transitions.test.mjs', test: 'T01 explicit route', expectation: 'verifier missing worker (attempt 1) evidence T01-worker',
    change: s => replaceOnce(s, '    const packetText = workPacket("verifier", 0, 0, verifyInstructions, ["CHECKS_PASSED", "FAIL", "BLOCKED"]);', '    const hidden = evidence.pop();\n    const packetText = workPacket("verifier", 0, 0, verifyInstructions, ["CHECKS_PASSED", "FAIL", "BLOCKED"]);\n    if (hidden) evidence.push(hidden);'),
    violated: 'Verifier receives the latest worker implementation output with its source.',
  },
  {
    mutation: 'M01.10 omit latest PASS report from reviewer packet', file: 'workflow-transitions.test.mjs', test: 'T02 explicit route', expectation: 'reviewer missing verifier evidence T02-pass',
    change: s => replaceOnce(s, '    const packetText = workPacket("reviewer", reviewRoundsUsed, budgets.reviewRounds, reviewInstructions, ["FINDINGS", "NO_FINDINGS", "BLOCKED"]);', '    const hidden = evidence.pop();\n    const packetText = workPacket("reviewer", reviewRoundsUsed, budgets.reviewRounds, reviewInstructions, ["FINDINGS", "NO_FINDINGS", "BLOCKED"]);\n    if (hidden) evidence.push(hidden);'),
    violated: 'Reviewer receives the latest successful verifier report with its source.',
  },
  {
    mutation: 'M01.11 restore lost BLOCKED scout output', file: 'workflow-scout-regression.test.mjs', test: 'F01/C11 scout', expectation: 'blocked scout diagnostic marker preserved',
    change: s => replaceOnce(replaceOnce(s, '  if (scoutOut.output) pushEvidence("scout", scoutOut.output);', '  if (scoutOut.verdict !== "BLOCKED" && scoutOut.output) pushEvidence("scout", scoutOut.output);'), '"scout stage: " + (scoutOut.detail || scoutOut.output)', '"scout stage: " + scoutOut.detail'),
    violated: 'Blocked scout diagnostic output must remain in reason or evidence.',
  },
  ...['worker', 'verifier'].map(role => ({
    mutation: `M01.${role === 'worker' ? 12 : 13} omit ${role} explicit model`,
    file: 'workflow-contracts.test.mjs', test: `C01/C02 ${role} nonempty`, expectation: `C01 exact model for ${role}`,
    change: s => replaceOnce(s, 'if (typeof roleCfg.modelParam === "string" && roleCfg.modelParam) item.model = roleCfg.modelParam;', `if (role !== "${role}" && typeof roleCfg.modelParam === "string" && roleCfg.modelParam) item.model = roleCfg.modelParam;`),
    violated: `The configured ${role} model, including its thinking suffix, must be passed unchanged.`,
  })),
];
const results = [];
for (const entry of cases) {
  const copy = await mkdtemp(join(tmpdir(), 'manjerok-mutation-'));
  try {
    await cp(join(root, 'tests'), join(copy, 'tests'), { recursive: true });
    await cp(join(root, 'extensions'), join(copy, 'extensions'), { recursive: true });
    await cp(join(root, 'package.json'), join(copy, 'package.json'));
    const changed = entry.change(source);
    assert.notEqual(changed, source, 'mutation must change source');
    await writeFile(join(copy, 'extensions/manjerok/workflow.js'), changed);
    const { WORKFLOW_SCRIPT } = await import(pathToFileURL(join(copy, 'extensions/manjerok/workflow.js')));
    compileWorkflow(WORKFLOW_SCRIPT); // syntax/import errors cannot count as detection
    const command = ['--test', '--test-reporter=tap', '--test-name-pattern', entry.test, `tests/${entry.file}`];
    const result = spawnSync(process.execPath, command, { cwd: copy, encoding: 'utf8', timeout: 10000 });
    const output = result.stdout + result.stderr;
    assert.equal(result.error, undefined, 'timeout/spawn failure is not semantic detection');
    assert.equal(result.signal, null, 'killed process is not semantic detection');
    assert.equal(result.status, 1, `mutant survived: ${entry.mutation}\n${output}`);
    assert.ok(output.includes(entry.expectation), `wrong failure for ${entry.mutation}\n${output}`);
    assert.ok(output.includes("code: 'ERR_ASSERTION'"), `expected assertion failure for ${entry.mutation}`);
    assert.ok(!/SyntaxError|ERR_MODULE_NOT_FOUND|testTimeoutFailure|harness deadline exceeded/.test(output), 'nonsemantic failure cannot count');
    const failure = output.split('\n').filter(line => /not ok|error:|code:|# fail/.test(line) || line.includes(entry.expectation)).join('\n');
    results.push({ ...entry, change: undefined, compiled: true, detected: true, failure });
    console.log(`${entry.mutation} -> ${entry.test} -> ${entry.expectation}`);
  } finally { await rm(copy, { recursive: true, force: true }); }
}
const summary = `# M01 semantic mutation evidence\n\nBaseline: all ${files.length} test files pass before mutations on ${process.version}. Each mutation was applied in a separate temporary copy, imported, compiled as the real async workflow body, and executed by the named test. Copies were removed. Detection requires exit 1 and the expected ERR_ASSERTION; import, syntax, timer, and process errors are rejected.\n\nRegenerate with \`npm run test:mutations\`.\n\n`;
const body = results.map(r => `## ${r.mutation}\n\n- Test: \`${r.test}\` in \`tests/${r.file}\`\n- Violated expectation: ${r.violated}\n- Compiled: yes; detected: yes\n\n\`\`\`text\n${r.failure}\n\`\`\`\n`).join('\n');
await writeFile(join(root, 'tests/evidence/mutations.md'), summary + body);
