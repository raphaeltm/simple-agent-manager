import type { AgentDefinition } from '@simple-agent-manager/shared';
import { Input } from '@simple-agent-manager/ui';
import { useState } from 'react';

import { getSuccessCloseDelayMs } from '../../CodexConnectModal';
import { AgentCredentialConnectTrigger } from '../../CodexConnectTrigger';

/** Agents whose subscription sign-in SAM can run for the user (open a link, enter a code). */
const GUIDED_SIGN_IN_AGENTS = ['openai-codex', 'claude-code'] as const;
type GuidedSignInAgent = (typeof GUIDED_SIGN_IN_AGENTS)[number];

export function isGuidedSignInAgent(agentId: string | null): agentId is GuidedSignInAgent {
  return (GUIDED_SIGN_IN_AGENTS as readonly string[]).includes(agentId ?? '');
}

interface SubscriptionConnectProps {
  agentId: string;
  oauthSupport: NonNullable<AgentDefinition['oauthSupport']>;
  token: string;
  onTokenChange: (value: string) => void;
  onConnected: () => void;
}

/**
 * The quick path first: for Claude Code and Codex, SAM runs the provider's sign-in in a sandbox
 * and the user only opens a link and enters a code (the same flow as Settings → Agents). Pasting
 * a setup token or auth.json stays available below it, and is the only option where the guided
 * flow is unavailable on this installation.
 */
export function SubscriptionConnect({
  agentId,
  oauthSupport,
  token,
  onTokenChange,
  onConnected,
}: SubscriptionConnectProps) {
  const [guidedShown, setGuidedShown] = useState(false);
  const isCodex = agentId === 'openai-codex';
  return (
    <div className="mb-3">
      {isGuidedSignInAgent(agentId) && (
        <div className="mb-3">
          <AgentCredentialConnectTrigger
            agentType={agentId}
            // Move on once the modal has shown its success state and closed itself; advancing
            // now would unmount it before the user sees that the sign-in worked.
            onConnected={() => window.setTimeout(onConnected, getSuccessCloseDelayMs())}
            onAvailabilityChange={setGuidedShown}
          />
        </div>
      )}
      <label
        htmlFor="onboarding-oauth-token"
        className="block text-xs font-medium text-fg-muted mb-1"
      >
        {guidedShown
          ? isCodex
            ? 'Or paste the contents of ~/.codex/auth.json'
            : 'Or paste a token from "claude setup-token"'
          : isCodex
            ? 'Contents of ~/.codex/auth.json'
            : 'OAuth token'}
      </label>
      {isCodex ? (
        <textarea
          id="onboarding-oauth-token"
          rows={guidedShown ? 3 : 6}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          value={token}
          onChange={(e) => onTokenChange(e.target.value)}
          placeholder="Paste the full contents of ~/.codex/auth.json"
          className="w-full px-3 py-2 rounded border border-border-default bg-surface text-fg-primary text-xs font-mono outline-none focus:border-accent"
        />
      ) : (
        <Input
          id="onboarding-oauth-token"
          type="password"
          autoComplete="off"
          value={token}
          onChange={(e) => onTokenChange(e.target.value)}
          placeholder='Paste your token from "claude setup-token"'
        />
      )}
      {!guidedShown && (
        <p className="text-xs text-fg-muted/70 mt-1">{oauthSupport.setupInstructions}</p>
      )}
      <a
        href={oauthSupport.subscriptionUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="text-xs text-accent hover:underline mt-1 inline-block"
      >
        View subscription plans
      </a>
    </div>
  );
}
