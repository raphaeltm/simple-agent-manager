/** Test-only entry point. These are real page/components; only external APIs are mocked. */
import '../../../src/app.css';
import '../../../src/index.css';

import { QueryClientProvider } from '@tanstack/react-query';
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';

import { AuthProvider } from '../../../src/components/AuthProvider';
import {
  TaskSubmitForm,
  type TaskSubmitOptions,
} from '../../../src/components/task/TaskSubmitForm';
import { queryClient } from '../../../src/lib/query-client';
import { CreateWorkspace } from '../../../src/pages/CreateWorkspace';
import { Nodes } from '../../../src/pages/Nodes';

const surface = new URLSearchParams(location.search).get('surface');
const initialPath = surface === 'nodes' ? '/nodes' : '/workspaces/new';

function TaskHarness() {
  const [submitted, setSubmitted] = useState<unknown>(null);
  const submit = (action: string) => async (title: string, options: TaskSubmitOptions) => {
    setSubmitted({ action, title, options });
  };
  return (
    <>
      <p>Standalone TaskSubmitForm component audit (currently unused by production routes)</p>
      <TaskSubmitForm
        projectId="creation-project"
        hasCloudCredentials
        onRunNow={submit('run')}
        onSaveToBacklog={submit('backlog')}
      />
      <output data-testid="task-submission" style={{ overflowWrap: 'anywhere' }}>
        {submitted ? JSON.stringify(submitted) : ''}
      </output>
    </>
  );
}

function Destination() {
  return <output data-testid="destination">{useLocation().pathname}</output>;
}

document.documentElement.dataset.uiTheme = 'sam';
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <AuthProvider>
      <MemoryRouter initialEntries={[initialPath]}>
        <main style={{ padding: 12, maxWidth: 1100, margin: 'auto' }}>
          {surface === 'task' ? (
            <TaskHarness />
          ) : (
            <Routes>
              <Route path="/nodes" element={<Nodes />} />
              <Route path="/workspaces/new" element={<CreateWorkspace />} />
              <Route path="*" element={<Destination />} />
            </Routes>
          )}
        </main>
      </MemoryRouter>
    </AuthProvider>
  </QueryClientProvider>
);
