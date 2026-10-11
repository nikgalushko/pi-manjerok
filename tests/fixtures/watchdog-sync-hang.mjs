import test from 'node:test';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runScenario } from '../helpers/workflow-harness.mjs';

const fixtureDir = process.env.MANJEROK_WATCHDOG_FIXTURE_DIR;
if (!fixtureDir) throw new Error('Controlled fixture requires MANJEROK_WATCHDOG_FIXTURE_DIR');

test('controlled synchronous workflow hang', { timeout: 50 }, async () => {
  // A grandchild records activity independently of the blocked fixture process.
  // Its own finite lifetime is extra cleanup protection if the watchdog regresses.
  const heartbeat = spawn(process.execPath, ['--input-type=module', '-e', `
    import { appendFileSync } from 'node:fs';
    const tick = () => appendFileSync(process.argv[1], 'tick\\n');
    tick();
    setInterval(tick, 20);
    setTimeout(() => process.exit(0), 2500);
  `, join(fixtureDir, 'heartbeat')], { stdio: 'ignore' });
  writeFileSync(join(fixtureDir, 'ready.json'), JSON.stringify({
    runnerPid: process.ppid, fixturePid: process.pid, heartbeatPid: heartbeat.pid,
  }));
  await runScenario([], {}, { script: 'while (true) {}', timeoutMs: 25 });
});
