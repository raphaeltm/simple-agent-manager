/**
 * Without Cloudflare AI Gateway a monthly AI dollar cap cannot be enforced, so the UI must not
 * offer one that looks active: the budget settings hide the cap input, say why, and never send
 * a cap (the API refuses it); onboarding's SAM-managed AI step drops the field. With a gateway
 * both are unchanged (the control in each block).
 */
import type { UserAiBudgetResponse } from '@simple-agent-manager/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mockFetchUserAiBudget = vi.fn();
const mockUpdateUserAiBudget = vi.fn();
const mockFetchAIProxyConfig = vi.fn();
vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  fetchUserAiBudget: (...args: unknown[]) => mockFetchUserAiBudget(...args),
  updateUserAiBudget: (...args: unknown[]) => mockUpdateUserAiBudget(...args),
  fetchAIProxyConfig: (...args: unknown[]) => mockFetchAIProxyConfig(...args),
}));
vi.mock('../../../src/components/AuthProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/components/AuthProvider')>()),
  useAuth: () => ({ user: { id: 'admin-1' }, isSuperadmin: true, isLoading: false }),
}));

import { AiBudgetSettingsSection } from '../../../src/components/ai-usage/AiBudgetSettingsSection';
import { AgentStep } from '../../../src/components/onboarding/choose-path/AgentStep';
import { INITIAL_FORM } from '../../../src/components/onboarding/choose-path/step-actions';
import { AdminAIProxy } from '../../../src/pages/AdminAIProxy';

function budget(overrides: Partial<UserAiBudgetResponse> = {}): UserAiBudgetResponse {
  return {
    settings: {
      dailyInputTokenLimit: null,
      dailyOutputTokenLimit: null,
      monthlyCostCapUsd: 12.5,
      alertThresholdPercent: 80,
    },
    isCustom: true,
    dailyUsage: { inputTokens: 1_000, outputTokens: 500 },
    effectiveLimits: { dailyInputTokenLimit: 500_000, dailyOutputTokenLimit: 200_000 },
    monthCostUsd: 3,
    monthlyCostCapAvailable: true,
    utilization: { dailyInputPercent: 0.2, dailyOutputPercent: 0.3, monthlyCostPercent: 24 },
    exceeded: false,
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('AI budget settings monthly cap', () => {
  async function openEditor(response: UserAiBudgetResponse) {
    mockFetchUserAiBudget.mockResolvedValue(response);
    mockUpdateUserAiBudget.mockResolvedValue({ success: true });
    render(<AiBudgetSettingsSection />);
    fireEvent.click(await screen.findByRole('button', { name: /configure/i }));
  }

  it('offers and saves the cap with AI Gateway (unchanged)', async () => {
    await openEditor(budget());
    expect(screen.getByText('Monthly Cost Cap')).toBeTruthy();
    const input = screen.getByLabelText('Monthly Cost Cap (USD)') as HTMLInputElement;
    expect(input.value).toBe('12.5');
    expect(screen.queryByTestId('monthly-cap-unavailable')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(mockUpdateUserAiBudget).toHaveBeenCalled());
    expect(mockUpdateUserAiBudget.mock.calls[0]?.[0]).toMatchObject({ monthlyCostCapUsd: 12.5 });
  });

  it('hides the cap, explains why, and saves without one when it is unavailable', async () => {
    await openEditor(
      budget({
        monthlyCostCapAvailable: false,
        utilization: { dailyInputPercent: 0.2, dailyOutputPercent: 0.3, monthlyCostPercent: null },
      })
    );
    const note = screen.getByTestId('monthly-cap-unavailable');
    expect(note.textContent).toContain('Monthly cost caps are not available on this installation');
    // The saved cap is named as not enforced, so it cannot look active.
    expect(note.textContent).toContain('$12.50 is not enforced here');
    // ...and the save side effect is stated beside Save too.
    expect(screen.getByTestId('monthly-cap-cleared-on-save').textContent).toContain('$12.50');
    expect(screen.getByText('Set personal token limits for AI proxy usage')).toBeTruthy();
    expect(screen.queryByLabelText('Monthly Cost Cap (USD)')).toBeNull();
    expect(screen.queryByText('Monthly Cost Cap')).toBeNull();
    // Liveness: the daily limits are still editable.
    expect(screen.getByLabelText('Daily Input Token Limit')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(mockUpdateUserAiBudget).toHaveBeenCalled());
    expect(mockUpdateUserAiBudget.mock.calls[0]?.[0]).toMatchObject({ monthlyCostCapUsd: null });
  });
});

describe('onboarding SAM-managed AI limits', () => {
  function serveCapabilities(monthlyCostCap: boolean) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/api/config/platform-capabilities')) {
          return Response.json({ speechToText: true, textToSpeech: true, monthlyCostCap });
        }
        throw new Error(`unexpected request ${url}`);
      })
    );
  }

  function renderStep(monthlyCostCapUsd = '', setForm = vi.fn()): void {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    render(
      <AgentStep
        form={{
          ...INITIAL_FORM,
          selectedAgent: 'claude-code',
          selectedAuthMethod: 'sam',
          monthlyCostCapUsd,
        }}
        setForm={setForm}
        samAvailable
        saving={false}
        onSave={vi.fn()}
        onConnected={vi.fn()}
      />,
      { wrapper }
    );
  }

  it('offers a monthly cap with AI Gateway (unchanged)', async () => {
    serveCapabilities(true);
    renderStep();
    expect(await screen.findByLabelText('Daily input tokens')).toBeTruthy();
    await waitFor(() => expect(screen.getByLabelText('Monthly cap (USD)')).toBeTruthy());
  });

  it('drops the monthly cap field when the installation cannot enforce one', async () => {
    serveCapabilities(false);
    renderStep();
    await waitFor(() => expect(screen.queryByLabelText('Monthly cap (USD)')).toBeNull());
    expect(screen.getByLabelText('Daily input tokens')).toBeTruthy();
  });

  it('clears a cap typed before the installation answered that it cannot enforce one', async () => {
    serveCapabilities(false);
    const setForm = vi.fn();
    renderStep('50', setForm);
    await waitFor(() => expect(setForm).toHaveBeenCalled());
    const update = setForm.mock.calls.at(-1)?.[0] as (
      prev: typeof INITIAL_FORM
    ) => typeof INITIAL_FORM;
    expect(update({ ...INITIAL_FORM, monthlyCostCapUsd: '50' }).monthlyCostCapUsd).toBe('');
  });

  it('keeps a typed cap where one can be enforced (control)', async () => {
    serveCapabilities(true);
    const setForm = vi.fn();
    renderStep('50', setForm);
    await waitFor(() => expect(screen.getByLabelText('Monthly cap (USD)')).toBeTruthy());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(setForm).not.toHaveBeenCalled();
  });
});

describe('admin AI proxy page', () => {
  function renderPage(monthlyCostCapAvailable: boolean) {
    mockFetchAIProxyConfig.mockResolvedValue({
      defaultModel: '@cf/meta/llama-4-scout-17b-16e-instruct',
      source: 'default',
      updatedAt: null,
      hasAnthropicCredential: false,
      hasOpenAICredential: false,
      hasUnifiedBilling: false,
      billingMode: 'auto',
      monthlyCostCapAvailable,
      models: [
        {
          id: '@cf/meta/llama-4-scout-17b-16e-instruct',
          label: 'Llama 4 Scout 17B',
          provider: 'workers-ai',
          tier: 'low-cost',
          costPer1kInputTokens: 0.00027,
          costPer1kOutputTokens: 0.00085,
          available: true,
        },
      ],
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <AdminAIProxy />
      </QueryClientProvider>
    );
  }

  it('tells the admin when monthly caps are unavailable', async () => {
    renderPage(false);
    const notice = await screen.findByTestId('admin-monthly-cap-unavailable');
    expect(notice.textContent).toContain(
      'Monthly cost caps are not available on this installation.'
    );
    expect(notice.textContent).toContain('CF_API_TOKEN');
    expect(notice.textContent).toContain('Daily token limits still apply.');
  });

  it('shows no notice with AI Gateway, while the page still renders (control)', async () => {
    renderPage(true);
    expect(await screen.findByText('Billing Mode')).toBeTruthy();
    expect(screen.queryByTestId('admin-monthly-cap-unavailable')).toBeNull();
  });
});
