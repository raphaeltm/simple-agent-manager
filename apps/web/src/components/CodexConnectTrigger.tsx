/**
 * Guided credential setup trigger button.
 *
 * Checks the guided-setup availability gate (`GET /config`) once on mount. When
 * the flow is enabled for the requested agent it renders a button that opens the
 * native setup modal; otherwise it renders nothing so the manual credential field
 * remains the only control. Failures to read the gate are treated as disabled.
 */
import { Button } from '@simple-agent-manager/ui';
import { useEffect, useRef, useState } from 'react';

import {
  getAgentCredentialSetupConfig,
  type GuidedSetupAgentType,
  setupConfigSupportsAgent,
} from '../lib/api';
import { AgentCredentialConnectModal } from './CodexConnectModal';

interface AgentCredentialConnectTriggerProps {
  agentType: GuidedSetupAgentType;
  /** Forwarded to the modal; fires after the credential is captured + saved. */
  onConnected?: () => void;
  /**
   * Credential scope. The guided flow only saves USER-scoped credentials in v1,
   * so it is hidden in project-scoped contexts to avoid silently overwriting the
   * user default (the manual credential paste stays available there).
   */
  scope?: 'user' | 'project';
}

type CodexConnectTriggerProps = Omit<AgentCredentialConnectTriggerProps, 'agentType'>;

const TRIGGER_COPY: Record<GuidedSetupAgentType, { button: string; description: string }> = {
  'openai-codex': {
    button: 'Connect with Codex',
    description:
      'Sign in to your ChatGPT subscription with a secure verification code — no manual auth.json needed.',
  },
  'claude-code': {
    button: 'Connect with Claude Code',
    description: 'Sign in to your Claude subscription — no manual setup-token paste needed.',
  },
};

export function AgentCredentialConnectTrigger({
  agentType,
  onConnected,
  scope = 'user',
}: AgentCredentialConnectTriggerProps) {
  const [enabled, setEnabled] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const checkedRef = useRef(false);
  const copy = TRIGGER_COPY[agentType];

  useEffect(() => {
    if (checkedRef.current) return;
    checkedRef.current = true;
    let active = true;
    void getAgentCredentialSetupConfig()
      .then((config) => {
        if (active) setEnabled(setupConfigSupportsAgent(config, agentType));
      })
      .catch(() => {
        // Gate unreadable (route absent / network) — keep the guided button hidden.
        if (active) setEnabled(false);
      });
    return () => {
      active = false;
    };
  }, [agentType]);

  if (!enabled || scope !== 'user') {
    return null;
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Button
        type="button"
        variant="primary"
        size="sm"
        onClick={() => setModalOpen(true)}
        className="self-start"
      >
        {copy.button}
      </Button>
      <p className="text-xs text-fg-muted m-0">{copy.description}</p>
      <AgentCredentialConnectModal
        agentType={agentType}
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        onConnected={() => {
          // Do NOT close here — the modal shows its "Connected" success state and
          // self-closes via onClose after a short delay. Closing now would unmount
          // it before success ever renders. Just refresh the parent's credentials.
          onConnected?.();
        }}
      />
    </div>
  );
}

export function CodexConnectTrigger(props: CodexConnectTriggerProps) {
  return <AgentCredentialConnectTrigger agentType="openai-codex" {...props} />;
}
