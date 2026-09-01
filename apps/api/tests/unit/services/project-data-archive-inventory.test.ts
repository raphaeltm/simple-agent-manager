import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const sourceRoot = fileURLToPath(new URL('../../../src', import.meta.url));
const migratedTablePattern =
  /chat_messages_grouped_fts|chat_messages_grouped|tool_payload_archives|chat_messages/;

function typescriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return typescriptFiles(path);
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  });
}

describe('ProjectData archive reader/writer inventory', () => {
  it('forces every new migrated-table dependency through an explicit inventory review', () => {
    const actual = typescriptFiles(sourceRoot)
      .filter((path) => migratedTablePattern.test(readFileSync(path, 'utf8')))
      .map((path) => relative(sourceRoot, path).replaceAll('\\', '/'))
      .sort();

    expect(actual).toEqual(
      [
        'durable-objects/migrations.ts',
        'durable-objects/project-data/archive-sharding-canonical.ts',
        'durable-objects/project-data/archive-sharding.ts',
        'durable-objects/project-data/comments.ts',
        'durable-objects/project-data/grouped-fts-cleanup.ts',
        'durable-objects/project-data/materialization.ts',
        'durable-objects/project-data/messages.ts',
        'durable-objects/project-data/session-activity-reconciliation.ts',
        'durable-objects/project-data/session-state.ts',
        'durable-objects/project-data/session-summary-sync.ts',
        'durable-objects/project-data/storage-category-telemetry.ts',
        'durable-objects/project-data/storage-relief-measurement.ts',
        'durable-objects/project-data/tool-payload-archive.ts',
        'durable-objects/project-data/tool-payload-cleanup-candidates.ts',
        'routes/mcp/session-tools.ts',
        'scheduled/project-data-archive-sharding.ts',
      ].sort()
    );
  });

  it('keeps every independent snapshot wake/resumer entry point on the archive fence', () => {
    const fencedFiles = [
      'services/session-snapshot-recovery-lifecycle.ts',
      'services/session-recovery-authority.ts',
      'durable-objects/task-runner/index.ts',
      'durable-objects/task-runner/state-machine.ts',
    ];
    for (const file of fencedFiles) {
      const source = readFileSync(resolve(sourceRoot, file), 'utf8');
      expect(source, file).toMatch(
        /projectDataArchiveWakeCondition|isProjectDataSessionWakeAllowed|project_data_session_locations/
      );
    }
  });

  it('keeps durable prompt delivery and task-wait wake delivery on both routing fences', () => {
    const service = readFileSync(resolve(sourceRoot, 'services/project-data.ts'), 'utf8');
    const durableObject = readFileSync(
      resolve(sourceRoot, 'durable-objects/project-data/index.ts'),
      'utf8'
    );

    expect(service).toMatch(
      /acceptPromptDelivery[\s\S]*assertProjectDataSessionWriteAllowed[\s\S]*getStub/
    );
    expect(durableObject).toMatch(
      /acceptPromptDelivery[\s\S]*assertProjectDataSessionWriteAllowed[\s\S]*assertRootSessionWriteAllowed/
    );
    expect(durableObject).toMatch(
      /reconcileTaskWaits[\s\S]*assertProjectDataSessionWriteAllowed[\s\S]*assertRootSessionWriteAllowed/
    );
  });
});
