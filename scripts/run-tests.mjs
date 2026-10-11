// An independent parent process guards node --test and its worker processes.
// It never imports or executes workflow code in its own event loop.
import { spawn, spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
let timeoutMs = 10000;
const files = [];
for (const arg of args) {
  if (arg.startsWith('--timeout-ms=')) {
    timeoutMs = Number(arg.slice('--timeout-ms='.length));
  } else {
    files.push(arg);
  }
}
if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
  throw new Error('--timeout-ms must be a positive safe integer');
}
if (!files.length) {
  files.push(...(await readdir(join(root, 'tests'))).filter(file => file.endsWith('.test.mjs')).sort().map(file => `tests/${file}`));
}
if (!files.length) throw new Error('No .test.mjs files found');

const isWindows = process.platform === 'win32';
// Regression tests invoke this entry point from an existing node:test child.
// Start an independent test runner rather than inheriting its child marker.
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;
const child = spawn(process.execPath, ['--test', ...files], {
  cwd: root, stdio: 'inherit', detached: !isWindows, env,
});
let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  console.error(`Test process watchdog expired after ${timeoutMs} ms; terminating Node test runner and children.`);
  if (isWindows) {
    const killed = spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { encoding: 'utf8' });
    if (killed.status !== 0) {
      console.error('Could not terminate the full test process tree:', killed.error?.message ?? killed.stderr);
      child.kill('SIGKILL');
    }
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (error) {
      if (error.code !== 'ESRCH') {
        console.error('Could not terminate the full test process group:', error.message);
        child.kill('SIGKILL');
      }
    }
  }
}, timeoutMs);
child.once('error', error => {
  clearTimeout(timer);
  console.error('Unable to start Node test runner:', error.message);
  process.exitCode = 1;
});
child.once('close', (code, signal) => {
  clearTimeout(timer);
  process.exitCode = timedOut ? 124 : (code ?? 1);
  if (!timedOut && signal) console.error(`Node test runner terminated by ${signal}`);
});
