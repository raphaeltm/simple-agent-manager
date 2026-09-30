// Run against the exact adapters installed in the VM image. For a local run:
// CLAUDE_ACP_PACKAGE_DIR=/path/to/claude-agent-acp CODEX_ACP_PACKAGE_DIR=/path/to/codex-acp \
//   node packages/shared/scripts/verify-pinned-acp-form-fixtures.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const fixturePath = new URL('../test-fixtures/acp-forms.json', import.meta.url);
const fixtures = JSON.parse(readFileSync(fixturePath, 'utf8'));
const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
const claudeDir = process.env.CLAUDE_ACP_PACKAGE_DIR ?? join(globalRoot, '@agentclientprotocol/claude-agent-acp');
const codexDir = process.env.CODEX_ACP_PACKAGE_DIR ?? join(globalRoot, '@agentclientprotocol/codex-acp');

function assertPinned(dir, version) {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  assert.equal(manifest.version, version, `expected ${version} at ${dir}`);
}

function methodBody(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `missing pinned adapter method ${signature}`);
  const open = source.indexOf('{', start + signature.length - 1);
  let depth = 0;
  for (let offset = open; offset < source.length; offset++) {
    if (source[offset] === '{') depth++;
    if (source[offset] === '}' && --depth === 0) return source.slice(open, offset + 1);
  }
  throw new Error(`unterminated pinned adapter method ${signature}`);
}

assertPinned(claudeDir, '0.81.2');
assertPinned(codexDir, '1.13.1');

const claude = await import(pathToFileURL(join(claudeDir, 'dist/elicitation.js')).href);
const mcp = claude.mcpElicitationToCreateRequest({
  mode: 'form',
  message: 'Configure the export',
  requestedSchema: fixtures[0].schema,
}, 'pinned-session');
assert.equal(mcp.mode, 'form');
assert.deepEqual(mcp.requestedSchema, fixtures[0].schema);

const ask = claude.askUserQuestionsToCreateRequest([
  {
    question: 'Choose a store', header: 'Store', multiSelect: false,
    options: [
      { label: 'D1', description: 'Managed SQL', preview: 'SQL tables and transactions' },
      { label: 'KV' },
    ],
  },
  {
    question: 'Choose regions', header: 'Regions', multiSelect: true,
    options: [{ label: 'EU', description: 'Europe' }, { label: 'US', description: 'United States' }],
  },
], 'pinned-session', 'tool-1');
assert.equal(ask.mode, 'form');
assert.deepEqual(ask.requestedSchema, fixtures[1].schema);

// codex-acp publishes one executable bundle and no importable builder export.
// Evaluate the unmodified builder method from that exact pinned bundle with its
// two pure local constants/helpers. A changed builder fails this comparison.
const codexSource = readFileSync(join(codexDir, 'dist/index.js'), 'utf8');
const helper = methodBody(codexSource, 'function userInputNoteFieldId(questionId, questionIds) {');
const builder = methodBody(codexSource, '  buildUserInputRequest(params) {');
const build = new Function('params', `
  const USER_INPUT_OTHER_OPTION = 'None of the above';
  const USER_INPUT_NOTE_FIELD_SUFFIX = '_note';
  function userInputNoteFieldId(questionId, questionIds) ${helper}
  ${builder}
`);
const codex = build({
  threadId: 'pinned-session', itemId: 'tool-1', autoResolutionMs: 30000,
  questions: [{
    id: 'question', question: 'Which path?', isOther: true, isSecret: false,
    options: [{ label: 'Fast' }],
  }],
});
assert.equal(codex.mode, 'form');
assert.deepEqual(codex.requestedSchema, fixtures[2].schema);

console.log('Pinned Claude 0.81.2 and Codex 1.13.1 form fixtures match adapter output.');
