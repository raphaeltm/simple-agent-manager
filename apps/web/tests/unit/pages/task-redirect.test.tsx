/**
 * `/projects/:id/tasks/:taskId`: a task with a chat opens that chat; one without (it never
 * started) opens its project, which lands on the Overview (inbox slice F2).
 */
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getTaskSessions: vi.fn() }));
vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  getTaskSessions: mocks.getTaskSessions,
}));
vi.mock('../../../src/pages/ProjectContext', () => ({
  useProjectContext: () => ({ projectId: 'p1', project: null, reload: async () => {} }),
}));

import { TaskRedirect } from '../../../src/pages/TaskRedirect';

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/projects/:id/tasks/:taskId" element={<TaskRedirect />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('TaskRedirect', () => {
  beforeEach(() => mocks.getTaskSessions.mockReset());

  it('opens the project (its Overview) for a task that has no chat', async () => {
    mocks.getTaskSessions.mockResolvedValue({ sessions: [] });
    renderAt('/projects/p1/tasks/t1');
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/projects\/p1$/));
    expect(mocks.getTaskSessions).toHaveBeenCalledWith('p1', 't1');
  });

  it('opens the chat for a task that has one (control)', async () => {
    mocks.getTaskSessions.mockResolvedValue({ sessions: [{ sessionId: 's9' }] });
    renderAt('/projects/p1/tasks/t1');
    await waitFor(() =>
      expect(screen.getByTestId('where')).toHaveTextContent('/projects/p1/chat/s9')
    );
  });
});
