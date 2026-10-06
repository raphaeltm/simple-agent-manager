import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

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
  /\bgh\s+api\b/i,
  /api\.github\.com\/repos\/[^\s]+\/(?:issues|pulls)(?:\/|\b)/,
  /\b(?:GH_TOKEN|GITHUB_TOKEN)\b/,
  /\${{\s*(?:github\.token|secrets(?:\.GITHUB_TOKEN|\[['"]GITHUB_TOKEN['"]\]))\s*}}/,
  /\b(?:pull-request-comment|comment-on-pr)\b/i,
] as const;

type PermissionMap = Record<string, string>;
type YamlRecord = Record<string, unknown>;

function asRecord(value: unknown): YamlRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as YamlRecord)
    : undefined;
}

function parseWorkflow(workflow: string, errors: string[]): YamlRecord | undefined {
  try {
    const parsed = asRecord(parse(workflow));
    if (!parsed) errors.push('workflow YAML must parse to a mapping');
    return parsed;
  } catch {
    errors.push('workflow YAML must be structurally parseable');
    return undefined;
  }
}

function permissionMap(value: unknown): PermissionMap | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  return Object.fromEntries(
    Object.entries(record).map(([scope, access]) => [scope, String(access)])
  );
}

function jobPermissionValues(workflow: YamlRecord | undefined): unknown[] {
  const jobs = asRecord(workflow?.jobs);
  if (!jobs) return [];
  return Object.values(jobs).flatMap((job) => {
    const jobRecord = asRecord(job);
    return jobRecord && Object.hasOwn(jobRecord, 'permissions') ? [jobRecord.permissions] : [];
  });
}

function isExactPermissionMap(actual: PermissionMap | undefined, expected: PermissionMap): boolean {
  if (!actual) return false;
  const actualEntries = Object.entries(actual).sort(([left], [right]) => left.localeCompare(right));
  const expectedEntries = Object.entries(expected).sort(([left], [right]) =>
    left.localeCompare(right)
  );
  return JSON.stringify(actualEntries) === JSON.stringify(expectedEntries);
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
  const stagingConfig = parseWorkflow(staging, errors);
  const reusableConfig = parseWorkflow(reusable, errors);
  const rootPermissions = permissionMap(stagingConfig?.permissions);

  if (!isExactPermissionMap(rootPermissions, REQUIRED_STAGING_PERMISSIONS)) {
    errors.push('staging root permissions must match the exact least-privilege allowlist');
  }

  const nestedPermissionValues = [
    ...jobPermissionValues(stagingConfig),
    ...(reusableConfig && Object.hasOwn(reusableConfig, 'permissions')
      ? [reusableConfig.permissions]
      : []),
    ...jobPermissionValues(reusableConfig),
  ];
  if (nestedPermissionValues.length > 0) {
    errors.push('nested or reusable permission overrides are forbidden');
  }

  const permissionValues = [stagingConfig?.permissions, ...nestedPermissionValues];
  for (const value of permissionValues) {
    const permissions = permissionMap(value);
    if (!permissions) {
      if (value !== undefined) errors.push('broad or inline permission grants are forbidden');
      continue;
    }
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

  it.each([
    '      pull-requests : write',
    '      "pull-requests": "write"',
    "      'pull-requests': 'write'",
    '    "\\u0070ermissions":\n      pull-requests: write',
  ])('rejects alternate valid YAML spelling of job-level PR authority: %s', (permissionLine) => {
    const permissionBlock = permissionLine.startsWith('    ')
      ? permissionLine
      : `    permissions:\n${permissionLine}`;
    const alternateSpelling = stagingWorkflow.replace(
      /^  smoke-tests:\s*$/m,
      (jobHeader) => `${jobHeader}\n${permissionBlock}`
    );

    expect(stagingPermissionContractErrors(alternateSpelling, reusableWorkflow)).not.toEqual([]);
  });

  it('rejects a reusable job override that silently removes checkout authority', () => {
    const checkoutBreakingOverride = reusableWorkflow.replace(
      /^  deploy:\s*$/m,
      '  deploy:\n    permissions:\n      deployments: none\n      id-token: none'
    );

    expect(stagingPermissionContractErrors(stagingWorkflow, checkoutBreakingOverride)).toContain(
      'nested or reusable permission overrides are forbidden'
    );
  });

  it('accepts the exact root permission map regardless of key order', () => {
    const reorderedRoot = stagingWorkflow.replace(
      /permissions:\n(?:  [a-z-]+: [a-z-]+\n)+/,
      'permissions:\n  id-token: none\n  contents: read\n  deployments: none\n'
    );

    expect(stagingPermissionContractErrors(reorderedRoot, reusableWorkflow)).toEqual([]);
  });

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

  it('rejects a token-backed GitHub API mutation hidden in a shell step', () => {
    const apiMutationConsumer = [
      reusableWorkflow,
      '      - env:',
      `          "GH_TOKEN": \${{ secrets['GITHUB_TOKEN'] }}`,
      '        run: |',
      '          gh api \\',
      '            --method POST \\',
      '            "repos/$GITHUB_REPOSITORY/issues/123/comments" \\',
      '            -f body=test',
    ].join('\n');

    expect(stagingPermissionContractErrors(stagingWorkflow, apiMutationConsumer)).toEqual(
      expect.arrayContaining([expect.stringContaining('pull-request write consumer is present')])
    );
  });

  it('rejects introducing a third-party pull-request commenting action', () => {
    const commentingAction = `${reusableWorkflow}\n      - uses: marocchino/sticky-pull-request-comment@773744901bac0e8cbb5a0dc842800d45e9b2b101\n`;

    expect(stagingPermissionContractErrors(stagingWorkflow, commentingAction)).toContain(
      'pull-request write consumer is present: \\b(?:pull-request-comment|comment-on-pr)\\b'
    );
  });
});
