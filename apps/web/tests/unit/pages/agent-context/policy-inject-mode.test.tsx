import type { ProjectPolicy } from '@simple-agent-manager/shared';
import { formatPolicyDirectiveLine, formatPolicyIndexLine } from '@simple-agent-manager/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  updatePolicy: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../../../src/lib/api', () => ({
  updatePolicy: mocks.updatePolicy,
  deletePolicy: vi.fn(),
}));
vi.mock('../../../../src/hooks/useToast', () => ({
  useToast: () => ({ success: mocks.success, error: mocks.error }),
}));

import { PoliciesTab } from '../../../../src/pages/AgentContextPage/PoliciesTab';

function policy(overrides: Partial<ProjectPolicy> = {}): ProjectPolicy {
  return {
    id: 'pol-1',
    category: 'rule',
    title: 'Staging is the default validation path',
    content: 'Deploy to staging before merging.',
    source: 'explicit',
    sourceSessionId: null,
    confidence: 0.95,
    active: true,
    scope: 'always',
    expiresAt: null,
    injectMode: 'pinned',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('Policies tab inject mode', () => {
  beforeEach(() => {
    mocks.updatePolicy.mockReset().mockResolvedValue({ updated: true, policyId: 'pol-1' });
    mocks.success.mockReset();
    mocks.error.mockReset();
  });

  it('shows the characters a pinned policy adds, measured with the API renderer', () => {
    const p = policy();
    render(<PoliciesTab policies={[p]} allPolicies={[p]} projectId="proj" onRefresh={vi.fn()} />);
    const chars = formatPolicyDirectiveLine(p).length + 1;
    expect(screen.getByText(`Adds ${chars} characters to every agent session.`)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Pinned' }).getAttribute('aria-pressed')).toBe(
      'true'
    );
    expect(screen.getByLabelText('Policy size in agent sessions').textContent).toContain(
      `${chars} characters sent to every agent session from 1 pinned policy`
    );
  });

  it('unpins through the policy API and refreshes', async () => {
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    const p = policy();
    render(<PoliciesTab policies={[p]} allPolicies={[p]} projectId="proj" onRefresh={onRefresh} />);
    fireEvent.click(screen.getByRole('button', { name: 'On demand' }));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    expect(mocks.updatePolicy).toHaveBeenCalledWith('proj', 'pol-1', { injectMode: 'on_demand' });
    expect(mocks.success).toHaveBeenCalledWith('Policy set to on demand');
  });

  it('re-pins an on-demand policy and shows its title-line size', async () => {
    const p = policy({ injectMode: 'on_demand' });
    render(<PoliciesTab policies={[p]} allPolicies={[p]} projectId="proj" onRefresh={vi.fn()} />);
    const chars = formatPolicyIndexLine(p).length + 1;
    expect(
      screen.getByText(new RegExp(`Title only in every session \\(${chars} characters\\)`))
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Pinned' }));
    await waitFor(() =>
      expect(mocks.updatePolicy).toHaveBeenCalledWith('proj', 'pol-1', { injectMode: 'pinned' })
    );
  });

  it('does not call the API when the current mode is chosen again, and reports failures', async () => {
    const p = policy();
    render(<PoliciesTab policies={[p]} allPolicies={[p]} projectId="proj" onRefresh={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Pinned' }));
    expect(mocks.updatePolicy).not.toHaveBeenCalled();

    mocks.updatePolicy.mockRejectedValueOnce(new Error('Forbidden'));
    fireEvent.click(screen.getByRole('button', { name: 'On demand' }));
    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith('Forbidden'));
  });

  it('leaves expired and inactive policies out of the session-size summary', () => {
    const live = policy();
    const expired = policy({ id: 'pol-2', expiresAt: 1 });
    const inactive = policy({ id: 'pol-3', active: false });
    render(
      <PoliciesTab
        policies={[live]}
        allPolicies={[live, expired, inactive]}
        projectId="proj"
        onRefresh={vi.fn()}
      />
    );
    expect(screen.getByLabelText('Policy size in agent sessions').textContent).toContain(
      'from 1 pinned policy'
    );
  });
});
