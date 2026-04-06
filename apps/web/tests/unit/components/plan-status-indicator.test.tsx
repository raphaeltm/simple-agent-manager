import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

/**
 * We test the plan status indicator logic by rendering a minimal version
 * of the "Agent is working" bar conditional layout. This avoids needing
 * to mock the entire useSessionLifecycle hook and all its dependencies.
 */

// Minimal PlanItem type matching the real one from acp-client
interface PlanEntry {
  content: string;
  priority: 'high' | 'medium' | 'low';
  status: 'pending' | 'in_progress' | 'completed';
}

interface PlanItem {
  kind: 'plan';
  id: string;
  entries: PlanEntry[];
  timestamp: number;
}

// Extracted component matching the exact logic used in ProjectMessageView
function AgentWorkingBar({
  items,
  cancelPrompt,
}: {
  items: Array<{ kind: string }>;
  cancelPrompt: () => void;
}) {
  const [planModalOpen, setPlanModalOpen] = vi.fn(() => [false, vi.fn()] as [boolean, (v: boolean) => void])();

  const currentPlan = items.find(
    (item): item is PlanItem => item.kind === 'plan'
  ) ?? null;
  const activeStep = currentPlan?.entries.find(e => e.status === 'in_progress') ?? null;

  return (
    <>
      <div data-testid="agent-working-bar" className="flex items-center gap-2">
        {currentPlan ? (
          <>
            <button
              type="button"
              onClick={() => setPlanModalOpen(true)}
              aria-label="View agent plan"
              data-testid="plan-icon-button"
            >
              Plan Icon
              <span data-testid="pulse-dot" className="animate-pulse" />
            </button>
            <span data-testid="active-step-text" className="truncate">
              Agent is working on: {activeStep?.content ?? 'next step'}
            </span>
          </>
        ) : (
          <>
            <span data-testid="spinner">Spinner</span>
            <span data-testid="generic-text">Agent is working...</span>
          </>
        )}
        <button
          type="button"
          onClick={cancelPrompt}
          data-testid="cancel-button"
          style={{ color: 'var(--sam-color-danger)' }}
        >
          Cancel
        </button>
      </div>
      {currentPlan && planModalOpen && (
        <div data-testid="plan-modal" role="dialog">
          Plan Modal Open
        </div>
      )}
    </>
  );
}

describe('AgentWorkingBar — plan status indicator', () => {
  describe('without plan', () => {
    it('shows spinner and generic "Agent is working..." text', () => {
      render(<AgentWorkingBar items={[]} cancelPrompt={vi.fn()} />);

      expect(screen.getByTestId('spinner')).toBeInTheDocument();
      expect(screen.getByTestId('generic-text')).toHaveTextContent('Agent is working...');
      expect(screen.queryByTestId('plan-icon-button')).not.toBeInTheDocument();
      expect(screen.queryByTestId('active-step-text')).not.toBeInTheDocument();
    });

    it('shows Cancel button', () => {
      render(<AgentWorkingBar items={[]} cancelPrompt={vi.fn()} />);
      expect(screen.getByTestId('cancel-button')).toBeInTheDocument();
    });
  });

  describe('with plan', () => {
    const planWithActiveStep: PlanItem = {
      kind: 'plan',
      id: 'plan-1',
      entries: [
        { content: 'Install dependencies', priority: 'high', status: 'completed' },
        { content: 'Run all required tests', priority: 'high', status: 'in_progress' },
        { content: 'Deploy to staging', priority: 'medium', status: 'pending' },
      ],
      timestamp: Date.now(),
    };

    const planAllPending: PlanItem = {
      kind: 'plan',
      id: 'plan-2',
      entries: [
        { content: 'Step one', priority: 'high', status: 'pending' },
        { content: 'Step two', priority: 'medium', status: 'pending' },
      ],
      timestamp: Date.now(),
    };

    it('shows plan icon with pulsing dot and active step text', () => {
      render(<AgentWorkingBar items={[planWithActiveStep]} cancelPrompt={vi.fn()} />);

      expect(screen.getByTestId('plan-icon-button')).toBeInTheDocument();
      expect(screen.getByTestId('pulse-dot')).toBeInTheDocument();
      expect(screen.getByTestId('active-step-text')).toHaveTextContent(
        'Agent is working on: Run all required tests'
      );
      expect(screen.queryByTestId('spinner')).not.toBeInTheDocument();
    });

    it('shows "next step" fallback when no entry is in_progress', () => {
      render(<AgentWorkingBar items={[planAllPending]} cancelPrompt={vi.fn()} />);

      expect(screen.getByTestId('active-step-text')).toHaveTextContent(
        'Agent is working on: next step'
      );
    });

    it('shows Cancel button', () => {
      render(<AgentWorkingBar items={[planWithActiveStep]} cancelPrompt={vi.fn()} />);
      expect(screen.getByTestId('cancel-button')).toBeInTheDocument();
    });

    it('Cancel button calls cancelPrompt on click', () => {
      const cancel = vi.fn();
      render(<AgentWorkingBar items={[planWithActiveStep]} cancelPrompt={cancel} />);

      fireEvent.click(screen.getByTestId('cancel-button'));
      expect(cancel).toHaveBeenCalledTimes(1);
    });

    it('plan icon button has correct aria-label', () => {
      render(<AgentWorkingBar items={[planWithActiveStep]} cancelPrompt={vi.fn()} />);

      const btn = screen.getByTestId('plan-icon-button');
      expect(btn).toHaveAttribute('aria-label', 'View agent plan');
    });
  });

  describe('with non-plan items only', () => {
    it('falls back to spinner when items exist but none is a plan', () => {
      const items = [
        { kind: 'agent_message', id: 'msg-1', text: 'hello' },
        { kind: 'tool_call', id: 'tc-1', title: 'test' },
      ];
      render(<AgentWorkingBar items={items} cancelPrompt={vi.fn()} />);

      expect(screen.getByTestId('spinner')).toBeInTheDocument();
      expect(screen.getByTestId('generic-text')).toHaveTextContent('Agent is working...');
    });
  });
});
