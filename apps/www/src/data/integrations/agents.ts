/**
 * Coding agents. Copy lives in agents.json. Source of truth: AGENT_CATALOG in
 * packages/shared/src/agents.ts, models in packages/shared/src/model-catalog.ts, sign-in modes in
 * apps/web/src/components/AgentSettingsCard.tsx (supportsSamProvider, supportsOAuthProvider) and
 * custom endpoints in packages/shared/src/harness-capabilities.ts.
 * tests/integrations-catalog.test.ts checks the agent list and model badges against those files.
 */
import agents from './agents.json';
import { asIntegration, type Integration } from './types';

export const agentIntegrations: Integration[] = agents.map(asIntegration);
