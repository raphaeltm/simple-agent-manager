import type { AgentInfo, TaskMode } from '@simple-agent-manager/shared';
import { type RefObject, useEffect, useRef } from 'react';

import { type NoProfilesQuickStart, resolveWizardRuntime } from './profileWizardHelpers';

/** The quick start for a project with exactly one configured agent, otherwise none. */
export function soleAgentQuickStart(
  agents: AgentInfo[],
  suggestProfileName: (agentType: string | null, workType: TaskMode | null) => string,
  onCreate: (() => Promise<unknown>) | undefined,
  instantAvailable: boolean | null
): NoProfilesQuickStart | undefined {
  const soleAgent = agents.length === 1 ? agents[0] : undefined;
  if (!soleAgent || !onCreate) return undefined;
  const runtime =
    instantAvailable === null ? null : resolveWizardRuntime('conversation', null, instantAvailable);
  return {
    agentName: soleAgent.name,
    profileName: suggestProfileName(soleAgent.id, 'conversation'),
    runtimeLabel:
      runtime === null
        ? null
        : runtime === 'cf-container'
          ? 'in an Instant container'
          : 'on a Cloud VM',
    onCreate,
  };
}

/**
 * The no-profiles gate's quick start, and focus for the box once it unlocks: the gate unmounts
 * with focus on its button, so after a one-click create the focus moves to the composer.
 */
export function useSoleAgentQuickStart({
  agents,
  suggestProfileName,
  onCreate,
  instantAvailable,
  inputDisabled,
  containerRef,
}: Readonly<{
  agents: AgentInfo[];
  suggestProfileName: (agentType: string | null, workType: TaskMode | null) => string;
  onCreate: (() => Promise<unknown>) | undefined;
  instantAvailable: boolean | null;
  inputDisabled: boolean;
  containerRef: RefObject<HTMLElement | null>;
}>): NoProfilesQuickStart | undefined {
  const focusPending = useRef(false);
  useEffect(() => {
    if (inputDisabled || !focusPending.current) return;
    focusPending.current = false;
    containerRef.current?.querySelector('textarea')?.focus();
  }, [containerRef, inputDisabled]);
  const create =
    onCreate &&
    (async () => {
      focusPending.current = true;
      try {
        const created = await onCreate();
        if (!created) focusPending.current = false;
        return created;
      } catch (err) {
        // A failed create leaves the gate up; a later unlock by another route keeps its focus.
        focusPending.current = false;
        throw err;
      }
    });
  return soleAgentQuickStart(agents, suggestProfileName, create, instantAvailable);
}
