import { writeFile } from 'node:fs/promises';
import { explore, configurations } from '../tests/helpers/workflow-explorer.mjs';
const configurationsReport = [];
for (const config of configurations()) configurationsReport.push(await explore(config));
const report = {
  description: 'E01 exhaustive allowed-verdict exploration of the real workflow; discovered next roles come from production execution, not a duplicate FSM.',
  scenarioLimitPerConfiguration: 10000,
  totals: {
    configurations: configurationsReport.length,
    completedScenarios: configurationsReport.reduce((n, r) => n + r.completedScenarios, 0),
    truncatedBranches: configurationsReport.reduce((n, r) => n + r.truncatedBranches, 0),
  },
  configurations: configurationsReport,
};
await writeFile(new URL('../tests/evidence/exploration.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report.totals));
