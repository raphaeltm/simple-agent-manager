/**
 * Admin Costs after Insights slice H: LLM spend only. Compute spend lives on Health & cost at
 * each machine's recorded price, so the old flat vCPU-hour estimate must not come back here.
 */
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/components/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'admin-1', email: 'a@example.com', name: 'Admin' } }),
}));

const mocks = vi.hoisted(() => ({ fetchAdminCosts: vi.fn() }));
vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  fetchAdminCosts: mocks.fetchAdminCosts,
}));

import { AdminCosts } from '../../../src/pages/AdminCosts';
import { QueryTestWrapper } from '../../test-utils/query-test-utils';

describe('AdminCosts', () => {
  it('points compute at Health & cost and shows no vCPU-hour estimate', async () => {
    mocks.fetchAdminCosts.mockResolvedValue({
      llm: {
        totalCostUsd: 12.5,
        totalRequests: 40,
        totalInputTokens: 1000,
        totalOutputTokens: 500,
        cachedRequests: 0,
        errorRequests: 0,
        byModel: [],
        byDay: [],
        byUser: [],
      },
      projection: {
        projectedMonthlyCostUsd: 30,
        dailyAverageCostUsd: 1,
        daysElapsed: 16,
        daysInMonth: 30,
      },
      period: 'current-month',
      periodLabel: 'November 2026',
    });
    render(
      <MemoryRouter>
        <AdminCosts />
      </MemoryRouter>,
      { wrapper: QueryTestWrapper }
    );

    const link = await screen.findByTestId('costs-compute-link');
    expect(link).toHaveAttribute('href', '/admin/health-cost');
    expect(link).toHaveTextContent('View on Health & cost');
    expect(screen.getByText('$12.50')).toBeInTheDocument(); // liveness: the LLM cards rendered
    expect(document.body).not.toHaveTextContent(/vCPU/i);
  });
});
