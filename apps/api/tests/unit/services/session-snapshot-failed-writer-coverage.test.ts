/**
 * `.claude/rules/44`: enumerate every writer.
 *
 * `session_snapshots.recovery_failed_at` is the anchor the wake attempt budget
 * decays from, and `sessionRecoveryBudgetAvailable` fails CLOSED when it is
 * NULL. So any writer that parks a snapshot at `recovery_status = 'failed'`
 * without also stamping the anchor strands that session permanently — the exact
 * 2026-09-09 incident, through a different door.
 *
 * PR #2054 shipped with exactly that gap: `failSessionSnapshotRecovery` set the
 * anchor and `failAndRestoreSessionRecoveryHandoff` did not. A reviewer caught
 * it. This scan makes the duty machine-checked rather than reliant on the next
 * reviewer being as thorough.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const SOURCE_ROOT = join(process.cwd(), 'src');

/** Both spellings a writer can use: raw SQL and the drizzle object form. */
const FAILED_STATUS_WRITE = /recovery_status\s*=\s*'failed'|recoveryStatus:\s*'failed'/;
const ANCHOR_WRITE = /recovery_failed_at\s*=\s*\?|recoveryFailedAt:/;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

/**
 * A writer is the statement/object literal that sets the failed status. Slice a
 * window forward from each match so an anchor written by an unrelated statement
 * elsewhere in the file cannot satisfy the assertion.
 */
const WRITER_WINDOW_CHARS = 600;

describe('recovery_status failed writers', () => {
  it('every writer also stamps the decay anchor', () => {
    const offenders: string[] = [];
    let writerCount = 0;

    for (const file of sourceFiles(SOURCE_ROOT)) {
      const source = readFileSync(file, 'utf8');
      const pattern = new RegExp(FAILED_STATUS_WRITE.source, 'g');
      for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
        writerCount += 1;
        const window = source.slice(match.index, match.index + WRITER_WINDOW_CHARS);
        if (!ANCHOR_WRITE.test(window)) {
          const line = source.slice(0, match.index).split('\n').length;
          offenders.push(`${file.replace(process.cwd(), '.')}:${line}`);
        }
      }
    }

    // A broken scan that matched nothing would otherwise pass as "all clear"
    // (`.claude/rules/02`). Both known writers must be found.
    expect(writerCount).toBeGreaterThanOrEqual(2);
    expect(offenders).toEqual([]);
  });
});
