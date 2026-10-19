/**
 * PROTOTYPE ONLY — routes for the two alternative information architectures.
 * Lazy-loaded from index.tsx so Option B screens stay light.
 */
import { Navigate, Route, Routes } from 'react-router';

import { OptionAChat, OptionANewChat, OptionAPlans } from './option-a';
import { OptionCHome, OptionCRun, OptionCRunbook } from './option-c';
import type { IaOption } from './shell';

export default function Alternatives({ option }: { option: IaOption }) {
  if (option === 'A') {
    return (
      <Routes>
        <Route path="chat" element={<OptionAChat />} />
        <Route path="new-chat" element={<OptionANewChat />} />
        <Route path="plans" element={<OptionAPlans />} />
        <Route path="*" element={<Navigate to="chat" replace />} />
      </Routes>
    );
  }
  return (
    <Routes>
      <Route path="run" element={<OptionCRun />} />
      <Route path="runbook" element={<OptionCRunbook />} />
      <Route path="home" element={<OptionCHome />} />
      <Route path="*" element={<Navigate to="run" replace />} />
    </Routes>
  );
}
