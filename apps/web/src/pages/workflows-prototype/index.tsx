/**
 * PROTOTYPE ONLY — Workflows UX exploration (task 01M59TPKHAYJP0GNC5AWH66DYH,
 * idea 01M59MBMZJVYHPHH1GJ7X8TZT1). Dev-only route /prototype/workflows/*.
 * Synthetic data, no API calls. Never merge: delete this directory and the
 * route in App.tsx (rule 37).
 */
import { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router';

import { NewChat, ResearchChat, StepChat } from './chat-screens';
import { Cover } from './cover';
import { RunPage } from './run-page';
import { SavedWorkflowPage, StartSheet } from './saved-workflow';
import { WorkflowsHome } from './workflows-home';

const Alternatives = lazy(() => import('./alternatives'));
const Diagrams = lazy(() => import('./diagrams'));

export function WorkflowsPrototype() {
  return (
    <div
      style={{ height: '100vh', overflow: 'hidden' }}
      className="text-fg-primary"
      data-prototype="workflows"
    >
      <Suspense fallback={null}>
        <Routes>
          <Route index element={<Cover />} />
          <Route path="b/chat" element={<ResearchChat />} />
          <Route path="b/new-chat" element={<NewChat />} />
          <Route path="b/step-chat" element={<StepChat />} />
          <Route path="b/workflows" element={<WorkflowsHome tab="runs" />} />
          <Route path="b/workflows/saved" element={<WorkflowsHome tab="saved" />} />
          <Route path="b/workflows/saved/:workflowId" element={<SavedWorkflowPage />} />
          <Route path="b/workflows/saved/:workflowId/start" element={<StartSheet />} />
          <Route path="b/workflows/runs/:runId" element={<RunPage />} />
          <Route path="a/*" element={<Alternatives option="A" />} />
          <Route path="c/*" element={<Alternatives option="C" />} />
          <Route path="diagrams/:name" element={<Diagrams />} />
          <Route path="*" element={<Cover />} />
        </Routes>
      </Suspense>
    </div>
  );
}
