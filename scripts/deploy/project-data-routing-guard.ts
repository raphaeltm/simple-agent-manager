#!/usr/bin/env tsx
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

import { PROJECT_DATA_ARCHIVE_ROUTING_VERSION } from '../../apps/api/src/services/project-data-archive-types.js';

export type RoutingGuardCounts = {
  authoritative_non_root: number;
  incompatible: number;
};

export function validateProjectDataRoutingGuard(counts: RoutingGuardCounts): void {
  if (
    !Number.isSafeInteger(counts.authoritative_non_root) ||
    counts.authoritative_non_root < 0 ||
    !Number.isSafeInteger(counts.incompatible) ||
    counts.incompatible < 0
  ) {
    throw new Error('ProjectData routing deploy guard received malformed D1 counts');
  }
  if (counts.incompatible > 0) {
    throw new Error(
      `Unsafe deploy blocked: ${counts.incompatible} authoritative ProjectData pointer(s) require a routing version other than ${PROJECT_DATA_ARCHIVE_ROUTING_VERSION}`
    );
  }
}

export function parseProjectDataRoutingGuardOutput(output: string): RoutingGuardCounts {
  const leading = output.match(/^\s*(?=[\[{])/);
  if (!leading) {
    throw new Error('ProjectData routing deploy guard output must begin with JSON');
  }
  const start = leading[0].length;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let index = start; index < output.length; index++) {
    const char = output[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '[' || char === '{') depth++;
    else if (char === ']' || char === '}') {
      depth--;
      if (depth === 0) {
        end = index + 1;
        break;
      }
    }
  }
  if (end < 0) throw new Error('ProjectData routing deploy guard received incomplete JSON output');
  const parsed = JSON.parse(output.slice(start, end)) as Array<{
    results?: Array<Record<string, unknown>>;
  }>;
  const row = parsed[0]?.results?.[0];
  const authoritative = Number(row?.authoritative_non_root);
  const incompatible = Number(row?.incompatible);
  const counts = { authoritative_non_root: authoritative, incompatible };
  validateProjectDataRoutingGuard(counts);
  return counts;
}

function argument(name: string): string {
  const prefix = `${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  const value = inline?.slice(prefix.length);
  if (!value) throw new Error(`${name}=... is required`);
  return value;
}

function main(): void {
  const environment = argument('--env');
  const database = argument('--database');
  const apiDirectory = resolve(import.meta.dirname, '../../apps/api');
  const query = `SELECT
    COUNT(*) AS authoritative_non_root,
    COALESCE(SUM(CASE WHEN routing_version != ${PROJECT_DATA_ARCHIVE_ROUTING_VERSION} THEN 1 ELSE 0 END), 0) AS incompatible
    FROM project_data_session_locations
    WHERE state IN ('archive_shard', 'direct_session')`;
  const output = execFileSync(
    'pnpm',
    [
      'exec',
      'wrangler',
      'd1',
      'execute',
      database,
      '--remote',
      '--env',
      environment,
      '--json',
      '--command',
      query,
    ],
    { cwd: apiDirectory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }
  );
  const counts = parseProjectDataRoutingGuardOutput(output);
  console.log(
    `ProjectData routing guard passed: ${counts.authoritative_non_root} authoritative non-root pointer(s), routing version ${PROJECT_DATA_ARCHIVE_ROUTING_VERSION}`
  );
}

const isDirectExecution = process.argv[1]
  ? import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href
  : false;
if (isDirectExecution) main();
