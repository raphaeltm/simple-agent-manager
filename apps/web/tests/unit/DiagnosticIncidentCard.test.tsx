import type { DiagnosticIncidentSummary } from '@simple-agent-manager/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import canaryFixture from '../../../../tests/fixtures/diagnostic-secret-canaries.json';
import { DiagnosticIncidentCard } from '../../src/components/admin/DiagnosticIncidentCard';

const download = vi.fn();
vi.mock('../../src/lib/api', () => ({
  downloadAdminDiagnosticArtifact: (...args: unknown[]) => download(...args),
}));

function incident(
  status: DiagnosticIncidentSummary['status'] = 'available'
): DiagnosticIncidentSummary {
  return {
    id: '01KZ8V0GMXQ4ZCSERPRT2X2K6M',
    platformErrorId: 'error-1',
    nodeId: 'node-1',
    workspaceId: 'workspace-1',
    status,
    occurrenceCount: 3,
    lastSeenAt: '2026-08-05T12:02:00.000Z',
    artifactCount: status === 'available' ? 1 : 0,
    totalBytes: status === 'available' ? 2048 : 0,
    manifest: {
      version: 1,
      incidentId: '01KZ8V0GMXQ4ZCSERPRT2X2K6M',
      nodeId: 'node-1',
      source: 'session-host',
      createdAt: '2026-08-05T12:00:00.000Z',
      collectors: [
        {
          name: 'structured-events',
          status: 'available',
          bytes: 1024,
          truncated: true,
          redactions: 3,
        },
        {
          name: 'workspace-lifecycle',
          status: 'failed',
          bytes: 0,
          truncated: false,
          redactions: 0,
          error: 'collector failed safely',
        },
      ],
      totalBytes: 1024,
      redactions: 3,
      anyTruncated: true,
    },
    preview: {
      safe: 'degraded',
      malicious: '<img src=x onerror=alert(1)>',
    },
    failureReason: status === 'failed' ? 'Snapshot quota reached' : null,
    expiresAt: '2026-08-12T12:00:00.000Z',
    createdAt: '2026-08-05T12:00:00.000Z',
    updatedAt: '2026-08-05T12:01:00.000Z',
    artifacts:
      status === 'available'
        ? [
            {
              id: 'artifact-1',
              kind: 'safe-vm-incident-v1',
              status: 'available',
              contentType: 'application/gzip',
              sizeBytes: 2048,
              checksumSha256: 'a'.repeat(64),
              createdAt: '2026-08-05T12:00:00.000Z',
              updatedAt: '2026-08-05T12:01:00.000Z',
            },
          ]
        : [],
  };
}

describe('DiagnosticIncidentCard', () => {
  beforeEach(() => {
    download.mockReset();
    download.mockResolvedValue(undefined);
  });

  it.each([
    ['missing', null, 'No automatic VM evidence'],
    ['pending', incident('pending'), 'still being collected or uploaded'],
    ['failed', incident('failed'), 'Snapshot quota reached'],
    ['expired', incident('expired'), 'retention limit'],
  ] as const)('renders the %s evidence state explicitly', (label, value, copy) => {
    render(<DiagnosticIncidentCard errorId="error-1" incident={value} />);
    expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    expect(screen.getByText(new RegExp(copy, 'i'))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /download safe evidence/i })).toBeNull();
  });

  it('renders collector accounting and malicious preview text without creating markup', () => {
    const { container } = render(
      <DiagnosticIncidentCard errorId="error-1" incident={incident()} />
    );
    expect(screen.getByText('structured-events')).toBeInTheDocument();
    expect(screen.getByText(/1.0 KiB · 3 redactions · truncated/)).toBeInTheDocument();
    expect(screen.getByText('collector failed safely')).toBeInTheDocument();
    expect(screen.getByText(/<img src=x onerror=alert\(1\)>/)).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText(/separate live node debug package/i)).toBeInTheDocument();
  });

  it('renders the sanitized incident contract without any shared secret canary', () => {
    const safeIncident = incident();
    safeIncident.preview = Object.fromEntries(
      canaryFixture.map(({ name }) => [name, '[REDACTED]'])
    );
    const { container } = render(
      <DiagnosticIncidentCard errorId="error-1" incident={safeIncident} />
    );

    const rendered = container.textContent ?? '';
    for (const { fragments } of canaryFixture) {
      expect(rendered).not.toContain(fragments.join(''));
    }
    expect(rendered).toContain('[REDACTED]');
  });

  it('suppresses duplicate downloads and announces success', async () => {
    let release!: () => void;
    download.mockReturnValueOnce(new Promise<void>((resolve) => (release = resolve)));
    render(<DiagnosticIncidentCard errorId="error-1" incident={incident()} />);
    const button = screen.getByRole('button', { name: /download safe evidence/i });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(download).toHaveBeenCalledTimes(1);
    expect(button).toBeDisabled();
    release();
    expect(await screen.findByRole('status')).toHaveTextContent('downloaded');
    expect(button).not.toBeDisabled();
  });

  it('announces download failures and allows a retry', async () => {
    download.mockRejectedValueOnce(new Error('Private artifact is unavailable'));
    render(<DiagnosticIncidentCard errorId="error-1" incident={incident()} />);
    const button = screen.getByRole('button', { name: /download safe evidence/i });
    fireEvent.click(button);
    expect(await screen.findByRole('alert')).toHaveTextContent('Private artifact is unavailable');
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);
    await waitFor(() => expect(download).toHaveBeenCalledTimes(2));
  });
});
