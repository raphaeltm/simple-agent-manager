import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import { SetupsBody } from '../../../../src/pages/insights/AgentSetupsTab';
import { makeSetups } from '../../../playwright/insights-setups-fixtures';

vi.mock('../../../../src/hooks/useQueryScope', () => ({ useQueryScope: () => 'viewer' }));
vi.mock('../../../../src/hooks/useToast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));

describe('Agent setups admission disclosure', () => {
  it('shows known incomplete tokens without inventing reported usage', () => {
    const data = { ...makeSetups('p', '30d', 'profile', 'empty'), usageAdmissionLimited: true };
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <SetupsBody data={data} projectId="p" />
        </MemoryRouter>
      </QueryClientProvider>
    );
    expect(
      screen.getByText(
        'Some token usage is incomplete. Token totals and comparisons may be understated.'
      )
    ).toBeInTheDocument();
    expect(screen.getByTestId('insights-setups-empty')).toBeInTheDocument();
  });

  it('preserves older responses without admission metadata', () => {
    const data = makeSetups('p', '30d', 'profile', 'empty');
    delete data.usageAdmissionLimited;
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <SetupsBody data={data} projectId="p" />
        </MemoryRouter>
      </QueryClientProvider>
    );
    expect(screen.queryByText(/Some token usage is incomplete/)).not.toBeInTheDocument();
    expect(screen.getByTestId('insights-setups-empty')).toBeInTheDocument();
  });
});
