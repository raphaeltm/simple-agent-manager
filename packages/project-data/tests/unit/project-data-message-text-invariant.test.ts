import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The absolute product invariant for the ProjectData storage-relief work: message TEXT
 * (`chat_messages.content`) is never rewritten by any cleanup, archive or relief
 * path. Canonical ingest alone may append a verified new suffix or update an identified tool snapshot;
 * real workerd tests cover receipts, archive fences and historical search refresh.
 * Only `tool_metadata` may be stripped, and only after a verified archive.
 *
 * The behavioural tests cover the paths that DO write (they assert `content` survives a
 * successful strip), but ~17 fail-closed tests never reach a write at all, so a future
 * regression that widened the archive UPDATE's column list would sail past them. This is
 * a deliberate structural check over the whole module directory (rule 02 permits
 * source-contract tests for structural verification) so a NEW writer cannot be added
 * without tripping it.
 */
const MODULE_DIR = new URL('../../src/do/', import.meta.url).pathname;

function sourceFiles(): string[] {
  return readdirSync(MODULE_DIR)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => join(MODULE_DIR, name));
}

/** Statements that mutate chat_messages, normalised to one line. */
function chatMessageMutations(source: string): string[] {
  const normalized = source.replace(/\s+/g, ' ');
  const statements: string[] = [];
  const pattern = /\b(UPDATE\s+chat_messages\b|DELETE\s+FROM\s+chat_messages\b)/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(normalized)) !== null) {
    statements.push(normalized.slice(match.index, match.index + 400));
  }
  return statements;
}

describe('ProjectData message-text invariant', () => {
  const files = sourceFiles();

  it('scans a non-trivial number of ProjectData modules', () => {
    // Guards against a broken glob silently reporting "all clear" (rule 02).
    expect(files.length).toBeGreaterThan(20);
  });

  it('permits only canonical ingest suffix appends and tool snapshots to write chat_messages.content', () => {
    const offenders: string[] = [];
    let canonicalAppends = 0;
    let canonicalTools = 0;
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const statement of chatMessageMutations(source)) {
        // `SET content` / `content =` in the SET list is the regression we are pinning.
        // A `content` reference inside a WHERE predicate is a read and is fine.
        const setClause = /\bSET\b(.*?)(\bWHERE\b|$)/i.exec(statement)?.[1] ?? '';
        if (/\bcontent\s*=/i.test(setClause)) {
          if (
            file.endsWith('/message-stream-ingest.ts') &&
            /^\s*content\s*=\s*content\s*\|\|\s*\?\s*$/i.test(setClause) &&
            /WHERE id = \? AND session_id = \? RETURNING id/.test(statement)
          ) {
            canonicalAppends++;
            continue;
          }
          if (
            file.endsWith('/tool-call-merge.ts') &&
            /^\s*content\s*=\s*\?,\s*tool_metadata\s*=\s*\?\s*$/i.test(setClause) &&
            /WHERE id = \? AND session_id = \?/.test(statement)
          ) {
            canonicalTools++;
            continue;
          }
          offenders.push(`${file}: ${statement.slice(0, 160)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
    expect(canonicalAppends).toBe(1);
    expect(canonicalTools).toBe(1);
  });

  it('never deletes chat_messages rows outside the explicitly archived session path', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const statement of chatMessageMutations(source)) {
        if (!/^DELETE/i.test(statement)) continue;
        // Session-archive sharding is the one sanctioned deleter, and it is disabled by
        // default and gated on a verified R2 recovery manifest.
        if (file.endsWith('archive-sharding.ts')) continue;
        offenders.push(`${file}: ${statement.slice(0, 160)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
