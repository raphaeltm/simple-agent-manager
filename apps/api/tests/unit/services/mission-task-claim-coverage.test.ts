/**
 * Every task INSERT that puts a task in a mission must also commit its chat session.
 *
 * The ProjectOrchestrator auto-starts mission tasks whose `chat_session_id` is
 * NULL. On 2026-10-10 `dispatch_task` inserted mission tasks unclaimed and
 * linked the session seconds later, so an orchestrator cycle started them a
 * second time (idea 01M4KKNAZY6KSSCXR610T01E11; 11 of 123 production mission
 * tasks had two sessions). Creators now commit a pre-allocated session id in
 * the INSERT. This scan keeps the next creator (a new dispatch tool, the /sam
 * rebuild) from reintroducing the race without a red build.
 *
 * Structural by design: the behaviour is covered through the real paths in
 * tests/workers/mission-dispatch-single-start.test.ts.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { collectSourceFiles, SRC_ROOT } from '../../helpers/source-tree';

interface TaskInsert {
  location: string;
  setsMission: boolean;
  setsChatSession: boolean;
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

/** Text from an opening bracket to its matching close, or null when unbalanced. */
function balancedFrom(source: string, openIndex: number, open: string, close: string) {
  let depth = 0;
  for (let i = openIndex; i < source.length; i += 1) {
    if (source[i] === open) depth += 1;
    if (source[i] === close) {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex, i + 1);
    }
  }
  return null;
}

function findTaskInserts(source: string, file: string): TaskInsert[] {
  const inserts: TaskInsert[] = [];
  // Raw SQL with an inline column list: `INSERT INTO tasks (id, ..., mission_id, ...)`.
  for (const match of source.matchAll(/INSERT INTO tasks\s*\(/g)) {
    const columns = balancedFrom(source, match.index + match[0].length - 1, '(', ')') ?? '';
    inserts.push({
      location: `${file}:${lineOf(source, match.index)}`,
      setsMission: /\bmission_id\b/.test(columns),
      setsChatSession: /\bchat_session_id\b/.test(columns),
    });
  }
  // Drizzle: `db.insert(schema.tasks).values({ ..., missionId, ... })`.
  for (const match of source.matchAll(/insert\(\s*schema\.tasks\s*\)\s*\.values\(\s*\{/g)) {
    const values = balancedFrom(source, match.index + match[0].length - 1, '{', '}') ?? '';
    inserts.push({
      location: `${file}:${lineOf(source, match.index)}`,
      setsMission: /\bmissionId\b/.test(values),
      setsChatSession: /\bchatSessionId\b/.test(values),
    });
  }
  return inserts;
}

describe('mission task creators claim their session in the task INSERT', () => {
  const inserts = collectSourceFiles(SRC_ROOT).flatMap((file) =>
    findTaskInserts(
      readFileSync(file, 'utf8'),
      path.relative(SRC_ROOT, file).split(path.sep).join('/')
    )
  );
  const missionCreators = inserts.filter((insert) => insert.setsMission);

  it('finds the task inserts and the known mission creators (guards against a no-op scan)', () => {
    expect(inserts.length).toBeGreaterThanOrEqual(15);
    const creatorFiles = missionCreators.map((insert) => insert.location.split(':')[0]);
    expect(creatorFiles).toEqual(
      expect.arrayContaining([
        'routes/mcp/dispatch-tool.ts',
        'durable-objects/sam-session/tools/dispatch-task.ts',
        'durable-objects/sam-session/tools/retry-subtask.ts',
      ])
    );
  });

  it('every insert that sets mission_id also commits chat_session_id', () => {
    const unclaimed = missionCreators
      .filter((insert) => !insert.setsChatSession)
      .map((insert) => insert.location);

    expect(
      unclaimed,
      'These task INSERTs put a task in a mission without its chat session. The ProjectOrchestrator ' +
        'treats chat_session_id IS NULL as "not started" and will start the task a second time. ' +
        'Pre-allocate the session id, insert it as chat_session_id, then create the ProjectData ' +
        'session with createSession(..., reservedSessionId).'
    ).toEqual([]);
  });

  it('the scan flags an unclaimed mission insert in both SQL and Drizzle form', () => {
    const raw = 'await db.prepare(`INSERT INTO tasks (id, mission_id, title) VALUES (?, ?, ?)`)';
    const drizzle = 'await db.insert(schema.tasks).values({ id, missionId, title: { text } });';
    const claimed = 'await db.insert(schema.tasks).values({ id, missionId, chatSessionId });';

    expect(findTaskInserts(raw, 'raw.ts')).toEqual([
      { location: 'raw.ts:1', setsMission: true, setsChatSession: false },
    ]);
    expect(findTaskInserts(drizzle, 'drizzle.ts')).toEqual([
      { location: 'drizzle.ts:1', setsMission: true, setsChatSession: false },
    ]);
    expect(findTaskInserts(claimed, 'claimed.ts')[0]?.setsChatSession).toBe(true);
  });
});
