import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ credentials: [] as unknown[] }));

vi.mock('../../../../src/hooks/useQueryScope', () => ({ useQueryScope: () => 'user-1' }));
vi.mock('../../../../src/hooks/useCredentials', () => ({
  useCredentials: () => ({
    credentials: mocks.credentials,
    loading: false,
    isRefreshing: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

import { GcpApiIssuesBanner } from '../../../../src/components/accounts/GcpApiIssuesBanner';

const gcpCredential = (apiIssues: unknown[]) => ({
  id: 'cred-gcp',
  provider: 'gcp',
  connected: true,
  createdAt: '2026-11-05T00:00:00.000Z',
  gcp: {
    authType: 'workload-identity',
    gcpProjectId: 'owner-project',
    serviceAccountEmail: 'sam@owner-project.iam.gserviceaccount.com',
    defaultZone: 'us-central1-a',
    apiIssues,
  },
});

describe('GcpApiIssuesBanner', () => {
  beforeEach(() => {
    mocks.credentials = [];
  });

  it('points the owner at their Google Cloud connection when an API may be off', () => {
    mocks.credentials = [
      gcpCredential([
        { service: 'cloudbilling.googleapis.com', label: 'Cloud Billing', reason: 'api_disabled' },
      ]),
    ];
    const onReview = vi.fn();
    render(<GcpApiIssuesBanner onReview={onReview} />);

    expect(screen.getByTestId('gcp-api-issues-banner')).toHaveTextContent(
      'Your Google Cloud project owner-project may be missing an API SAM needs: Cloud Billing.'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(onReview).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['no Google Cloud connection', () => []],
    ['a connection with no API issues', () => [gcpCredential([])]],
  ])('renders nothing for %s', (_name, credentials) => {
    mocks.credentials = credentials();
    const { container } = render(
      <div data-testid="host">
        <GcpApiIssuesBanner onReview={vi.fn()} />
      </div>
    );
    // Liveness: the host rendered; the banner chose to render nothing.
    expect(screen.getByTestId('host')).toBeInTheDocument();
    expect(container.querySelector('[data-testid="gcp-api-issues-banner"]')).toBeNull();
  });
});
