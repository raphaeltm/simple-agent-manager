import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const osvWorkflow = readFileSync(
  new URL('../../.github/workflows/osv-scan.yml', import.meta.url),
  'utf8'
);

describe('scheduled OSV advisory workflow contract', () => {
  it('runs only from the trusted default-branch schedule', () => {
    expect(osvWorkflow).toContain("on:\n  schedule:\n    - cron: '17 4 * * 1'\n\npermissions:");
    expect(osvWorkflow).toContain(
      'jobs:\n  scan:\n    name: Scan and Route Private Follow-up\n    if: github.event.repository.fork == false'
    );
    for (const forbiddenTrigger of [
      'workflow_dispatch:',
      'pull_request:',
      'push:',
      'workflow_call:',
      'repository_dispatch:',
    ]) {
      expect(osvWorkflow).not.toContain(forbiddenTrigger);
    }
  });

  it('fails closed unless authenticated private routing is configured', () => {
    expect(osvWorkflow).toContain('OSV_POLICY_EVENT: schedule');
    expect(osvWorkflow).toContain(
      "SAM_OSV_PRIVATE_ROUTING_CONFIGURED: ${{ secrets.SAM_OSV_WEBHOOK_URL != '' && secrets.SAM_OSV_WEBHOOK_TOKEN != '' }}"
    );
    expect(osvWorkflow).toContain('SAM_OSV_WEBHOOK_TOKEN: ${{ secrets.SAM_OSV_WEBHOOK_TOKEN }}');
    expect(osvWorkflow).toContain('SAM_OSV_WEBHOOK_URL: ${{ secrets.SAM_OSV_WEBHOOK_URL }}');
    expect(osvWorkflow).toContain('run: pnpm quality:osv-advisory');
  });

  it('keeps scanner installation pinned and privacy-safe', () => {
    expect(osvWorkflow).toContain('permissions:\n  contents: read\n\nconcurrency:');
    expect(osvWorkflow).toContain('OSV_SCANNER_VERSION: 2.5.0');
    expect(osvWorkflow).toContain('gh release download "v${OSV_SCANNER_VERSION}"');
    expect(osvWorkflow).toContain('--pattern osv-scanner_linux_amd64');
    expect(osvWorkflow).toContain('--pattern osv-scanner_SHA256SUMS');
    expect(osvWorkflow).toContain('sha256sum --ignore-missing --check osv-scanner_SHA256SUMS');
    expect(osvWorkflow).toContain('mv osv-scanner_linux_amd64 osv-scanner');
    expect(osvWorkflow).toContain(
      'SAM_OSV_SCANNER_BIN: ${{ runner.temp }}/osv-scanner/osv-scanner'
    );
    expect(osvWorkflow).not.toContain('permissions: write-all');
    expect(osvWorkflow).not.toContain('issues: write');
    expect(osvWorkflow).not.toContain('upload-artifact');
  });
});
