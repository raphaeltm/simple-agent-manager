#!/usr/bin/env tsx
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parseWranglerJsonOutput } from './d1-migration-safety.js';

class ProjectDataArchiveRoutingGuardError extends Error {}

type DatabaseTarget = {
  binding: string;
  name: string;
};

function parseArgs(argv: string[]): { environment: string; databases: DatabaseTarget[] } {
  let environment = '';
  const databases: DatabaseTarget[] = [];
  for (const arg of argv) {
    if (arg.startsWith('--env=')) {
      environment = arg.slice('--env='.length);
      continue;
    }
    if (arg === '--env') {
      throw new ProjectDataArchiveRoutingGuardError('Use --env=<environment>');
    }
    if (arg.startsWith('--database=')) {
      const value = arg.slice('--database='.length);
      const [binding, name] = value.split(':');
      if (!binding || !name) {
        throw new ProjectDataArchiveRoutingGuardError(
          `Invalid --database value "${value}". Expected BINDING:name`
        );
      }
      databases.push({ binding, name });
    }
  }
  if (!environment) throw new ProjectDataArchiveRoutingGuardError('Missing --env=<environment>');
  if (databases.length === 0) {
    throw new ProjectDataArchiveRoutingGuardError(
      'At least one --database=BINDING:name is required'
    );
  }
  return { environment, databases };
}

function parseCount(output: unknown, db: DatabaseTarget): number {
  if (!Array.isArray(output)) {
    throw new ProjectDataArchiveRoutingGuardError('Wrangler output was not a JSON array');
  }
  const rows = (output[0] as { results?: unknown } | undefined)?.results;
  if (!Array.isArray(rows)) {
    throw new ProjectDataArchiveRoutingGuardError('Wrangler output did not contain result rows');
  }
  const value = (rows[0] as { count?: unknown } | undefined)?.count;
  const count = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new ProjectDataArchiveRoutingGuardError(
      `Invalid non-root pointer count for ${db.binding}.${db.name}: ${String(value)}`
    );
  }
  return count;
}

function queryNonRootPointers(environment: string, db: DatabaseTarget): number {
  const output = execFileSync(
    'pnpm',
    [
      'exec',
      'wrangler',
      'd1',
      'execute',
      db.name,
      '--remote',
      '--env',
      environment,
      '--command',
      "SELECT COUNT(*) AS count FROM project_data_session_locations WHERE location_state != 'root'",
      '--json',
    ],
    { cwd: resolve(import.meta.dirname, '../../apps/api'), encoding: 'utf8' }
  );
  return parseCount(parseWranglerJsonOutput(output), db);
}

function assertRoutingBridgePresent(): void {
  const root = resolve(import.meta.dirname, '../..');
  const contractPath = resolve(root, 'apps/api/src/project-data-archive/contract.ts');
  const servicePath = resolve(root, 'apps/api/src/services/project-data.ts');
  const doPath = resolve(root, 'apps/api/src/durable-objects/project-data/index.ts');
  for (const path of [contractPath, servicePath, doPath]) {
    if (!existsSync(path)) {
      throw new ProjectDataArchiveRoutingGuardError(
        `ProjectData archive routing guard failed: missing ${path}`
      );
    }
  }
  const contract = readFileSync(contractPath, 'utf8');
  const service = readFileSync(servicePath, 'utf8');
  const durableObject = readFileSync(doPath, 'utf8');
  for (const [path, content, needle] of [
    [contractPath, contract, 'PROJECT_DATA_ARCHIVE_ROUTING_SCHEMA_VERSION'],
    [servicePath, service, 'resolveExactReadOwner'],
    [servicePath, service, 'assertExactWriteAllowed'],
    [doPath, durableObject, 'archiveTargetGetMessages'],
    [doPath, durableObject, 'archiveSourceGetMessages'],
  ] as const) {
    if (!content.includes(needle)) {
      throw new ProjectDataArchiveRoutingGuardError(
        `ProjectData archive routing guard failed: ${path} does not include ${needle}`
      );
    }
  }
}

async function main(): Promise<void> {
  const { environment, databases } = parseArgs(process.argv.slice(2));
  let nonRootPointers = 0;
  for (const db of databases) {
    if (db.binding !== 'DATABASE') continue;
    nonRootPointers += queryNonRootPointers(environment, db);
  }
  if (nonRootPointers > 0) assertRoutingBridgePresent();
  console.log(
    `ProjectData archive routing guard passed: nonRootPointers=${nonRootPointers}, environment=${environment}`
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
