import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const osvWorkflow = readFileSync(
  new URL('../../.github/workflows/osv-scan.yml', import.meta.url),
  'utf8'
);

describe('scheduled OSV advisory workflow contract', () => {
  it('runs only from the trusted default-branch schedule', () => {
    expect(osvWorkflow).toContain('schedule:');
    expect(osvWorkflow).not.toContain('workflow_dispatch:');
    expect(osvWorkflow).not.toContain('pull_request:');
    expect(osvWorkflow).toContain('if: github.event.repository.fork == false');
  });

  it('fails closed unless authenticated private routing is configured', () => {
    expect(osvWorkflow).toContain('OSV_POLICY_EVENT: schedule');
    expect(osvWorkflow).toContain('SAM_OSV_PRIVATE_ROUTING_CONFIGURED:');
    expect(osvWorkflow).toContain('SAM_OSV_WEBHOOK_TOKEN: ${{ secrets.SAM_OSV_WEBHOOK_TOKEN }}');
    expect(osvWorkflow).toContain('SAM_OSV_WEBHOOK_URL: ${{ secrets.SAM_OSV_WEBHOOK_URL }}');
    expect(osvWorkflow).toContain('run: pnpm quality:osv-advisory');
  });

  it('keeps scanner installation pinned and privacy-safe', () => {
    expect(osvWorkflow).toContain('OSV_SCANNER_VERSION: 2.5.0');
    expect(osvWorkflow).toContain('sha256sum --ignore-missing --check osv-scanner_SHA256SUMS');
    expect(osvWorkflow).not.toContain('issues: write');
    expect(osvWorkflow).not.toContain('upload-artifact');
  });
});
