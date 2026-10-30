import { act, cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

/**
 * Suspense/code-splitting behaviour of the router.
 *
 * This lives in its own file because `React.lazy` memoises a resolved component for the
 * lifetime of the module graph: once a route has been visited, it no longer suspends.
 * Vitest isolates modules per test file, so a dedicated file is the only way to observe
 * the *first* paint of a route. For the same reason each test below uses a DIFFERENT
 * route — reusing one would make a later test silently non-discriminating.
 */
import { loadOrder, preload, renderAt } from '../helpers/app-preload-mocks';

vi.mock('../../src/pages/ProjectSettings', async () => {
  const { Outlet } = await import('react-router');
  loadOrder.push('settings');
  return {
    ProjectSettings: () => <Outlet />,
    ProjectSettingsRuntime: () => <div data-testid="runtime-tab" />,
  };
});

afterEach(() => {
  cleanup();
});

it('warms settings alongside a pending project shell without fetching the chat chunk', async () => {
  renderAt('/projects/project-1/settings/runtime');
  await waitFor(() => {
    expect(loadOrder).toContain('Project');
    expect(loadOrder).toContain('settings');
  });
  expect(loadOrder).not.toContain('project-chat');
  expect(screen.queryByTestId('runtime-tab')).not.toBeInTheDocument();
  await act(async () => preload.release());
  expect(await screen.findByTestId('runtime-tab')).toBeInTheDocument();
  expect(loadOrder).not.toContain('project-chat');
});
