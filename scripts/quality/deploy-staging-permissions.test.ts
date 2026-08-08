import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const stagingWorkflow = readFileSync(
  new URL('../../.github/workflows/deploy-staging.yml', import.meta.url),
  'utf8'
);
const reusableWorkflow = readFileSync(
  new URL('../../.github/workflows/deploy-reusable.yml', import.meta.url),
  'utf8'
);

const REQUIRED_STAGING_PERMISSIONS = {
  contents: 'read',
  deployments: 'none',
  'id-token': 'none',
} as const;

const PR_WRITE_CONSUMERS = [
  /actions\/github-script@/,
  /github\.rest\.(?:issues|pulls)/,
  /\bgh\s+pr\s+(?:comment|edit|review|close|merge|ready|reopen)\b/,
  /api\.github\.com\/repos\/[^\s]+\/(?:issues|pulls)(?:\/|\b)/,
  /\bcomment-on-pr\s*:/,
] as const;

type PermissionMap = Record<string, string>;

function permissionMaps(workflow: string): Array<{ indent: number; permissions: PermissionMap }> {
  const lines = workflow.split('\n');
  const maps: Array<{ indent: number; permissions: PermissionMap }> = [];

  for (let index = 0; index < lines.length; index += 1) {
    const header = lines[index]?.match(/^(\s*)permissions:\s*(.*?)\s*$/);
    if (!header) continue;

    const indent = header[1]?.length ?? 0;
    const inline = header[2];
    if (inline) {
      maps.push({ indent, permissions: { '*': inline } });
      continue;
    }

    const permissions: PermissionMap = {};
    for (let childIndex = index + 1; childIndex < lines.length; childIndex += 1) {
      const child = lines[childIndex];
      if (!child?.trim() || child.trimStart().startsWith('#')) continue;

      const childIndent = child.match(/^\s*/)?.[0].length ?? 0;
      if (childIndent <= indent) break;

      const entry = child.match(/^\s+([a-z-]+):\s*([a-z-]+)\s*(?:#.*)?$/);
      if (entry?.[1] && entry[2]) permissions[entry[1]] = entry[2];
    }
    maps.push({ indent, permissions });
  }

  return maps;
}

function block(workflow: string, start: RegExp, nextTopLevelKey: RegExp): string {
  const startMatch = start.exec(workflow);
  if (!startMatch) return '';

  const suffix = workflow.slice(startMatch.index);
  const nextMatch = nextTopLevelKey.exec(suffix.slice(startMatch[0].length));
  return nextMatch ? suffix.slice(0, startMatch[0].length + nextMatch.index) : suffix;
}

function stagingPermissionContractErrors(staging: string, reusable: string): string[] {
  const errors: string[] = [];
  const stagingMaps = permissionMaps(staging);
  const rootPermissions = stagingMaps.find(({ indent }) => indent === 0)?.permissions;

  if (JSON.stringify(rootPermissions) !== JSON.stringify(REQUIRED_STAGING_PERMISSIONS)) {
    errors.push('staging root permissions must match the exact least-privilege allowlist');
  }

  for (const { permissions } of [...stagingMaps, ...permissionMaps(reusable)]) {
    if ('*' in permissions) {
      errors.push('broad or inline permission grants are forbidden');
      continue;
    }

    for (const [scope, access] of Object.entries(permissions)) {
      const expected =
        REQUIRED_STAGING_PERMISSIONS[scope as keyof typeof REQUIRED_STAGING_PERMISSIONS];
      if (expected === undefined || access !== expected) {
        errors.push(`unexpected permission grant: ${scope}: ${access}`);
      }
    }
  }

  const combinedWorkflows = `${staging}\n${reusable}`;
  for (const consumer of PR_WRITE_CONSUMERS) {
    if (consumer.test(combinedWorkflows)) {
      errors.push(`pull-request write consumer is present: ${consumer.source}`);
    }
  }

  const deployCall = block(staging, /^  deploy:\s*$/m, /^  [a-zA-Z0-9_-]+:\s*$/m);
  for (const requiredCallLine of [
    'uses: ./.github/workflows/deploy-reusable.yml',
    'environment: staging',
    'skip_agent: false',
    'dry_run: ${{ inputs.dry_run || false }}',
    'secrets: inherit',
  ]) {
    if (!deployCall.includes(requiredCallLine)) {
      errors.push(`reusable staging call lost contract line: ${requiredCallLine}`);
    }
  }

  const dryRunInput = block(reusable, /^      dry_run:\s*$/m, /^      [a-zA-Z0-9_-]+:\s*$/m);
  for (const requiredInputLine of ['required: false', 'type: boolean', 'default: false']) {
    if (!dryRunInput.includes(requiredInputLine)) {
      errors.push(`reusable dry-run input lost contract line: ${requiredInputLine}`);
    }
  }

  return errors;
}

describe('staging deployment permission contract', () => {
  it('passes only the minimum token scopes to the reusable dry-run-capable deployment', () => {
    expect(stagingPermissionContractErrors(stagingWorkflow, reusableWorkflow)).toEqual([]);
  });

  it('rejects the historical workflow-wide pull-request write authority', () => {
    const historicalGrant = stagingWorkflow.replace(
      /permissions:\n(?:  [a-z-]+: [a-z-]+\n)+/,
      'permissions:\n  contents: read\n  pull-requests: write\n'
    );

    expect(stagingPermissionContractErrors(historicalGrant, reusableWorkflow)).toContain(
      'unexpected permission grant: pull-requests: write'
    );
  });

  it.each(['deploy', 'smoke-tests'])(
    'rejects pull-request authority relocated to the %s job',
    (jobName) => {
      const relocatedGrant = stagingWorkflow.replace(
        new RegExp(`^  ${jobName}:\\s*$`, 'm'),
        `  ${jobName}:\n    permissions:\n      pull-requests: write`
      );

      expect(stagingPermissionContractErrors(relocatedGrant, reusableWorkflow)).toContain(
        'unexpected permission grant: pull-requests: write'
      );
    }
  );

  it.each(Object.keys(REQUIRED_STAGING_PERMISSIONS))(
    'rejects removal of the explicit %s scope declaration',
    (scope) => {
      const missingScope = stagingWorkflow.replace(new RegExp(`^  ${scope}: [a-z-]+\\n`, 'm'), '');

      expect(stagingPermissionContractErrors(missingScope, reusableWorkflow)).toContain(
        'staging root permissions must match the exact least-privilege allowlist'
      );
    }
  );

  it('rejects broad write-all authority', () => {
    const broadGrant = stagingWorkflow.replace(
      /permissions:\n(?:  [a-z-]+: [a-z-]+\n)+/,
      'permissions: write-all\n'
    );

    expect(stagingPermissionContractErrors(broadGrant, reusableWorkflow)).toContain(
      'broad or inline permission grants are forbidden'
    );
  });

  it('rejects reintroducing the removed PR-commenting capability', () => {
    const prCommentConsumer = `${reusableWorkflow}\n      - uses: actions/github-script@pinned\n`;

    expect(stagingPermissionContractErrors(stagingWorkflow, prCommentConsumer)).toContain(
      'pull-request write consumer is present: actions\\/github-script@'
    );
  });
});
