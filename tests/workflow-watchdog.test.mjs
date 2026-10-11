import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { testOptions } from './helpers/workflow-harness.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const runner = join(root, 'scripts/run-tests.mjs');

test('test watchdog preserves success and assertion failure exit codes', testOptions, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'manjerok-watchdog-exits-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [name, body, status] of [['pass', '', 0], ['fail', "assert.fail('EXPECTED_FIXTURE_FAILURE');", 1]]) {
    const fixture = join(dir, `${name}.test.mjs`);
    await writeFile(fixture, `import test from 'node:test'; import assert from 'node:assert/strict'; test('${name}', () => { ${body} });`);
    const result = spawnSync(process.execPath, [runner, '--timeout-ms=1000', fixture], { cwd: root, encoding: 'utf8', timeout: 3000 });
    assert.equal(result.error, undefined, 'independent control deadline must not terminate the wrapper');
    assert.equal(result.signal, null);
    assert.equal(result.status, status, result.stdout + result.stderr);
    if (status === 1) assert.match(result.stdout + result.stderr, /EXPECTED_FIXTURE_FAILURE/);
    assert.ok(!result.stderr.includes('watchdog expired'), 'normal completion must not use watchdog');
  }
});

test('test watchdog kills synchronous workflow hang and Node runner descendants', testOptions, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'manjerok-watchdog-hang-'));
  t.after(async () => {
    // The outer spawnSync deadline also bounds a broken watchdog. Remove the
    // controlled fixture's process group/children before reporting any failure.
    const ready = await readFile(join(dir, 'ready.json'), 'utf8').then(JSON.parse).catch(() => null);
    if (ready) {
      const pids = process.platform === 'win32' ? [] : [-ready.runnerPid, ready.fixturePid, ready.heartbeatPid];
      for (const pid of pids) {
        try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
      if (process.platform === 'win32') {
        for (const pid of [ready.runnerPid, ready.fixturePid, ready.heartbeatPid]) spawnSync('taskkill', ['/pid', String(pid), '/T', '/F']);
      }
    }
    await rm(dir, { recursive: true, force: true });
  });
  const result = spawnSync(process.execPath, [runner, '--timeout-ms=500', join(root, 'tests/fixtures/watchdog-sync-hang.mjs')], {
    cwd: root, encoding: 'utf8', timeout: 3500,
    env: { ...process.env, MANJEROK_WATCHDOG_FIXTURE_DIR: dir },
  });
  assert.equal(result.error, undefined, 'external control deadline must not be the hang detector');
  assert.equal(result.signal, null, 'wrapper must report watchdog failure itself');
  assert.equal(result.status, 124, result.stdout + result.stderr);
  assert.match(result.stderr, /Test process watchdog expired after 500 ms/);
  const ready = JSON.parse(await readFile(join(dir, 'ready.json'), 'utf8'));
  assert.notEqual(ready.runnerPid, ready.fixturePid, 'fixture must execute in a Node runner child');
  await delay(50);
  const before = await readFile(join(dir, 'heartbeat'), 'utf8');
  assert.ok(before.length > 0, 'grandchild must have started and written activity');
  await delay(100);
  assert.equal(await readFile(join(dir, 'heartbeat'), 'utf8'), before, 'watchdog must stop the grandchild heartbeat');
});
