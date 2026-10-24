/**
 * Nothing SAM generates for idea work may name a slash command, a SAM-repository skill,
 * or any other instruction that only exists in this repository (policy 69acc166).
 *
 * This is a source scan rather than a behavioural test on purpose: the risk is a future
 * change re-introducing `/do` into a generated string, and the only way to catch that is
 * to look at every string these modules can emit. The behavioural half — that the idea
 * reaches the agent as structured context instead of prompt text — is covered by
 * `mcp-instruction-idea-block.test.ts` and `task-submit-source-idea.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { ideaInstructionLines } from '../../../src/routes/mcp/instruction-idea-context';

/**
 * Every module that produces text an agent sees when it starts work on an idea.
 *
 * Hand-maintained: nothing forces a new generator to add itself here. Add the file when
 * you write one, and prefer putting generated agent-visible text in one of these rather
 * than in a new module, so the guard keeps covering it.
 */
const GENERATED_TEXT_SOURCES = [
  '../../../src/routes/mcp/instruction-idea-context.ts',
  '../../../src/operations/start-work-core.ts',
  '../../../src/operations/untrusted-text.ts',
  '../../../../web/src/components/ideas/StartWorkSheet.tsx',
  '../../../../web/src/components/ideas/useStartWork.ts',
] as const;

/**
 * A slash command in prose: `/do`, `/speckit.plan`, `/compact`. A trailing `/` or `$`
 * means the match is the first segment of a path or a template URL, not a command.
 */
const SLASH_COMMAND = /(^|[\s"'`(])\/[a-z][a-z0-9.-]{1,30}\b(?![/$])/gim;

function sourceOf(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
}

describe('idea work is repository agnostic', () => {
  it.each(GENERATED_TEXT_SOURCES)('%s names no slash command', (relativePath) => {
    const source = sourceOf(relativePath);
    const matches = [...source.matchAll(SLASH_COMMAND)].map((match) => match[0].trim());
    expect(matches, `found slash commands: ${matches.join(', ')}`).toEqual([]);
  });

  it.each(GENERATED_TEXT_SOURCES)('%s names no SAM-repository skill', (relativePath) => {
    const source = sourceOf(relativePath).toLowerCase();
    for (const banned of ['/do skill', 'the do skill', 'speckit', 'claude.md', 'agents.md'])
      expect(source, `mentions "${banned}"`).not.toContain(banned);
  });

  // The guard above only proves the sources are clean. This proves the text the agent
  // actually receives is clean too, for both relations.
  it.each(['works_on', 'discusses'] as const)(
    'the %s instruction lines carry no slash command',
    (relation) => {
      const lines = ideaInstructionLines({
        ideaId: 'idea-1',
        title: 'Retry failed webhook deliveries',
        relation,
        status: 'draft',
        content: null,
      }).join('\n');
      expect([...lines.matchAll(SLASH_COMMAND)]).toEqual([]);
      expect(lines).toContain('repository');
      // It points at SAM's own tools, which exist for every project, not at a workflow
      // that only exists here.
      expect(lines).toContain('get_idea');
    }
  );

  // A discriminating control: the matcher must actually fire on the string this test
  // exists to keep out, or every assertion above is vacuous.
  it('the slash-command matcher catches the text this rule removed', () => {
    const removed =
      'Read idea {ideaId} using the get_idea tool for full context, then execute it using the /do skill.';
    expect([...removed.matchAll(SLASH_COMMAND)].map((match) => match[0].trim())).toEqual(['/do']);
  });
});
