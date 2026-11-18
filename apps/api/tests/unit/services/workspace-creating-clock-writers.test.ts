/**
 * Supplemental, machine-checked enumeration of every statement that puts a workspace into
 * 'creating'. Each one must start (or deliberately keep) the per-attempt clock that the shared
 * deadline reads (`workspace-creating-deadline.ts`), or carry a reason here. A writer that forgets
 * it times its attempt from `created_at`, which is the workspace's age, not the attempt's. The
 * behavior itself is tested on real SQL in workspace-placement.test.ts, timeout.test.ts and
 * task-runner-workspace-ready-deadline.test.ts; this only stops a new writer from slipping by.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC = join(process.cwd(), 'src');
const CLOCK = /creating_started_at|creatingStartedAt/;

/** Writers that keep the attempt's existing clock on purpose, with the reason. */
const SAME_ATTEMPT_WRITERS: Record<string, string> = {
  // creating -> creating re-claim before dispatch: the same attempt picking up its node.
  'routes/workspaces/_helpers.ts': 'scheduleWorkspaceCreateOnNode re-claim keeps the attempt',
  // Restart failure after dispatch keeps 'creating' for the attempt already in flight.
  'routes/workspaces/lifecycle.ts#restart-failure':
    'an uncertain dispatch keeps the attempt that was dispatched',
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

interface CreatingWrite {
  file: string;
  statement: string;
}

/** SQL and drizzle statements that write status 'creating' to the workspaces table. */
function creatingWrites(): CreatingWrite[] {
  const writes: CreatingWrite[] = [];
  for (const path of sourceFiles(SRC)) {
    const file = relative(SRC, path);
    const text = readFileSync(path, 'utf8');
    const patterns = [
      /UPDATE workspaces\s+SET[\s\S]*?`/g,
      /INSERT INTO workspaces[\s\S]*?`/g,
      /\.(?:update|insert)\(schema\.workspaces\)[\s\S]*?\.(?:set|values)\(\{[\s\S]*?\n\s*\}\)/g,
    ];
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        const statement = match[0];
        // Only what the statement writes: a WHERE predicate on 'creating' is a read.
        const written = statement.split(/\bWHERE\b|\.where\(/)[0];
        if (/status\s*[:=]\s*'creating'|\?\s*'creating'|'creating',\s*\?/.test(written)) {
          writes.push({ file, statement: written });
        }
      }
    }
  }
  return writes;
}

describe('every writer into creating owns the attempt clock', () => {
  const writes = creatingWrites();

  it('finds the known writers (a broken scan must not pass as "all clear")', () => {
    // reservation INSERT, placeholder attach, restart, rebuild, direct-create placeholder,
    // instant insert, re-claim, restart failure.
    expect(writes.length).toBeGreaterThanOrEqual(8);
  });

  it('starts or keeps the clock, or is a documented same-attempt writer', () => {
    const unguarded = writes.filter(({ file, statement }) => {
      if (CLOCK.test(statement)) return false;
      if (file === 'routes/workspaces/_helpers.ts' && /status = 'creating'/.test(statement)) {
        return !SAME_ATTEMPT_WRITERS[file];
      }
      if (file === 'routes/workspaces/lifecycle.ts' && /runtimeDispatchStarted/.test(statement)) {
        return !SAME_ATTEMPT_WRITERS['routes/workspaces/lifecycle.ts#restart-failure'];
      }
      return true;
    });
    expect(unguarded.map(({ file, statement }) => `${file}: ${statement.slice(0, 120)}`)).toEqual(
      []
    );
  });
});
