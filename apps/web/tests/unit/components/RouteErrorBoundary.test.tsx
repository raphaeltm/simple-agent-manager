import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RouteErrorBoundary } from '../../../src/components/RouteErrorBoundary';

// Mock error reporter
vi.mock('../../../src/lib/error-reporter', () => ({
  reportRawError: vi.fn(),
}));

function ThrowingComponent({ message }: { message: string }) {
  throw new Error(message);
}

function GoodComponent() {
  return <div>All good</div>;
}

describe('RouteErrorBoundary', () => {
  // Suppress React's console.error for expected error boundaries
  const originalError = console.error;
  beforeAll(() => {
    console.error = (...args: unknown[]) => {
      const msg = typeof args[0] === 'string' ? args[0] : '';
      if (msg.includes('Error Boundary') || msg.includes('The above error')) return;
      originalError(...args);
    };
  });
  afterAll(() => {
    console.error = originalError;
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders children when no error occurs', () => {
    render(
      <RouteErrorBoundary>
        <GoodComponent />
      </RouteErrorBoundary>,
    );
    expect(screen.getByText('All good')).toBeInTheDocument();
  });

  it('shows error UI when a child component throws', () => {
    render(
      <RouteErrorBoundary>
        <ThrowingComponent message="Test crash" />
      </RouteErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.getByText('An error occurred while rendering this section.')).toBeInTheDocument();
    expect(screen.getByText('Test crash')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('resets the boundary when "Try again" is clicked', async () => {
    let shouldThrow = true;

    function ConditionalThrow() {
      if (shouldThrow) {
        throw new Error('Conditional crash');
      }
      return <div>Recovered</div>;
    }

    render(
      <RouteErrorBoundary>
        <ConditionalThrow />
      </RouteErrorBoundary>,
    );

    // Should show error UI
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();

    // Fix the error condition
    shouldThrow = false;

    // Click "Try again"
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Try again' }));

    // Should now render the child
    expect(screen.getByText('Recovered')).toBeInTheDocument();
    expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
  });

  it('reports errors to the error reporter', async () => {
    const { reportRawError } = await import('../../../src/lib/error-reporter');

    render(
      <RouteErrorBoundary label="test-route">
        <ThrowingComponent message="Reported error" />
      </RouteErrorBoundary>,
    );

    expect(reportRawError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Reported error' }),
      'route-error-boundary:test-route',
      expect.objectContaining({ componentStack: expect.any(String) }),
    );
  });

  it('includes label in error report when provided', async () => {
    const { reportRawError } = await import('../../../src/lib/error-reporter');

    render(
      <RouteErrorBoundary label="dashboard">
        <ThrowingComponent message="dashboard crash" />
      </RouteErrorBoundary>,
    );

    expect(reportRawError).toHaveBeenCalledWith(
      expect.any(Error),
      'route-error-boundary:dashboard',
      expect.any(Object),
    );
  });

  it('uses generic label when no label prop is provided', async () => {
    const { reportRawError } = await import('../../../src/lib/error-reporter');

    render(
      <RouteErrorBoundary>
        <ThrowingComponent message="no label crash" />
      </RouteErrorBoundary>,
    );

    expect(reportRawError).toHaveBeenCalledWith(
      expect.any(Error),
      'route-error-boundary',
      expect.any(Object),
    );
  });
});
