/**
 * Prints (or with --write, rewrites) the per-file baseline for sam/no-unguarded-outbound-fetch:
 * how many unacknowledged global-fetch/socket sites each worker source file has today.
 *
 * The baseline only ever goes down. Run with --write after guarding sites to lower it; a new
 * site is acknowledged inline with an eslint-disable comment naming who chooses its URL, not by
 * raising a number here.
 *
 *   node packages/eslint-plugin-sam/scripts/outbound-fetch-baseline.mjs [--write]
 */
import { writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';

import { OUTBOUND_FETCH_GUARD_FILES } from '../outbound-fetch-scope.js';

const pluginRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = join(pluginRoot, '..', '..');
const baselinePath = join(pluginRoot, 'outbound-fetch-baseline.json');
const ruleId = 'sam/no-unguarded-outbound-fetch';

const eslint = new ESLint({
  cwd: repoRoot,
  overrideConfig: {
    files: OUTBOUND_FETCH_GUARD_FILES,
    rules: { [ruleId]: ['error', { repoRoot, baseline: {} }] },
  },
  // Only this rule matters for the count; other findings are ignored below.
  ruleFilter: ({ ruleId: id }) => id === ruleId,
});

const results = await eslint.lintFiles(OUTBOUND_FETCH_GUARD_FILES);
const baseline = {};
for (const result of results) {
  const count = result.messages.filter((message) => message.ruleId === ruleId).length;
  if (count > 0) baseline[relative(repoRoot, result.filePath).split(sep).join('/')] = count;
}
const sorted = Object.fromEntries(Object.entries(baseline).sort(([a], [b]) => a.localeCompare(b)));
const text = `${JSON.stringify(sorted, null, 2)}\n`;
if (process.argv.includes('--write')) {
  writeFileSync(baselinePath, text);
  const total = Object.values(sorted).reduce((sum, count) => sum + count, 0);
  console.log(`Wrote ${Object.keys(sorted).length} files, ${total} sites to ${baselinePath}`);
} else {
  process.stdout.write(text);
}
