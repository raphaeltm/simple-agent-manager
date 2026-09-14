import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

import { describe, expect, it } from 'vitest';

import { generateAppCreationUrl, generateAppManifest } from '../deploy/utils/github';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const EXPECTED_PERMISSIONS = {
  actions: 'read',
  checks: 'read',
  contents: 'write',
  email_addresses: 'read',
  issues: 'read',
  metadata: 'read',
  pull_requests: 'read',
};
const EXPECTED_EVENTS = [
  'check_run',
  'check_suite',
  'issues',
  'issue_comment',
  'pull_request',
  'pull_request_review',
  'pull_request_review_comment',
  'push',
  'repository',
  'workflow_run',
].sort((left, right) => left.localeCompare(right));

function extractFunction(source: string, functionName: string): string {
  const start = source.indexOf(`function ${functionName}`);
  if (start < 0) throw new Error(`Missing ${functionName}`);
  const bodyStart = source.indexOf('{', start);
  if (bodyStart < 0) throw new Error(`Missing ${functionName} body`);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Unclosed ${functionName} body`);
}

function runPublicUrlBuilder(relativePath: string, org = ''): URL {
  const source = readFileSync(resolve(REPO_ROOT, relativePath), 'utf8');
  const context = {
    URLSearchParams,
    encodeURIComponent,
    result: '',
  };
  vm.createContext(context);
  vm.runInContext(
    `${extractFunction(source, 'buildGitHubAppUrl')}; result = buildGitHubAppUrl('example.com', 'SAM Test', ${JSON.stringify(org)});`,
    context
  );
  return new URL(context.result);
}

function permissionParams(url: URL): Record<string, string | null> {
  return Object.fromEntries(
    Object.keys(EXPECTED_PERMISSIONS)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => [key, url.searchParams.get(key)])
  );
}

function sortedEvents(url: URL): string[] {
  return url.searchParams.getAll('events[]').sort((left, right) => left.localeCompare(right));
}

describe('GitHub App setup parity', () => {
  it('keeps deploy manifest and generated setup URL permissions/events aligned', () => {
    const manifest = generateAppManifest('SAM Test', 'example.com');
    const url = new URL(generateAppCreationUrl('example.com', 'SAM Test'));

    expect(manifest.default_permissions).toEqual(EXPECTED_PERMISSIONS);
    expect(manifest.default_events.sort((left, right) => left.localeCompare(right))).toEqual(
      EXPECTED_EVENTS
    );
    expect(permissionParams(url)).toEqual(EXPECTED_PERMISSIONS);
    expect(sortedEvents(url)).toEqual(EXPECTED_EVENTS);
  });

  it('keeps public setup generators aligned with deploy manifest URL params', () => {
    const astroUrl = runPublicUrlBuilder(
      'apps/www/src/components/GitHubAppSetup.astro',
      'acme-inc'
    );
    const wizardUrl = runPublicUrlBuilder(
      'apps/www/public/scripts/self-host-wizard-helpers.js',
      'acme-inc'
    );

    expect(astroUrl.origin + astroUrl.pathname).toBe(
      'https://github.com/organizations/acme-inc/settings/apps/new'
    );
    expect(wizardUrl.origin + wizardUrl.pathname).toBe(
      'https://github.com/organizations/acme-inc/settings/apps/new'
    );
    expect(permissionParams(astroUrl)).toEqual(EXPECTED_PERMISSIONS);
    expect(permissionParams(wizardUrl)).toEqual(EXPECTED_PERMISSIONS);
    expect(sortedEvents(astroUrl)).toEqual(EXPECTED_EVENTS);
    expect(sortedEvents(wizardUrl)).toEqual(EXPECTED_EVENTS);
  });
});
