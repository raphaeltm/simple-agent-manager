/**
 * "Connect with Codex" trigger button.
 *
 * Checks the guided-setup availability gate (`GET /config`) once on mount. When
 * the flow is enabled it renders a button that opens {@link CodexConnectModal};
 * otherwise it renders nothing so the manual auth.json paste remains the only
 * control (rule 24 — this augments, it does not duplicate, the Codex credential
 * field). Failures to read the gate are treated as "disabled".
 */
import { Button } from '@simple-agent-manager/ui';
import { useEffect, useRef, useState } from 'react';

import { getCodexSetupConfig } from '../lib/api';
import { CodexConnectModal } from './CodexConnectModal';

interface CodexConnectTriggerProps {
  /** Forwarded to the modal; fires after the credential is captured + saved. */
  onConnected?: () => void;
  /**
   * Credential scope. The guided flow only saves USER-scoped credentials in v1,
   * so it is hidden in project-scoped contexts to avoid silently overwriting the
   * user default (the manual auth.json paste stays available there).
   */
  scope?: 'user' | 'project';
}

export function CodexConnectTrigger({ onConnected, scope = 'user' }: CodexConnectTriggerProps) {
  const [enabled, setEnabled] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const checkedRef = useRef(false);

  useEffect(() => {
    if (checkedRef.current) return;
    checkedRef.current = true;
    let active = true;
    void getCodexSetupConfig()
      .then((config) => {
        if (active) setEnabled(config.enabled === true);
      })
      .catch(() => {
        // Gate unreadable (route absent / network) — keep the guided button hidden.
        if (active) setEnabled(false);
      });
    return () => {
      active = false;
    };
  }, []);

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
        Connect with Codex
      </Button>
      <p className="text-xs text-fg-muted m-0">
        Sign in to your ChatGPT subscription in a guided terminal — no manual auth.json needed.
      </p>
      <CodexConnectModal
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
