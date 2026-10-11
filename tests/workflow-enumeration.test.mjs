import test from 'node:test';
import assert from 'node:assert/strict';
import { explore, configurations } from './helpers/workflow-explorer.mjs';
for (const config of configurations()) test(`E01 finite exploration ${JSON.stringify(config)}`, { timeout: 10000 }, async t => {
  const result = await explore(config);
  assert.ok(result.longestCompleted <= result.maxChildRuns);
  t.diagnostic(JSON.stringify(result));
});
