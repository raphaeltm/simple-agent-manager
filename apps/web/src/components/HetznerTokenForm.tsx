import type { CredentialResponse } from '@simple-agent-manager/shared';

import { SingleTokenCredentialForm } from './SingleTokenCredentialForm';

interface HetznerTokenFormProps {
  credential?: CredentialResponse | null;
  onUpdate: () => void;
}

/** Form for adding/updating/deleting a Hetzner API token (single-token provider). */
export function HetznerTokenForm({ credential, onUpdate }: HetznerTokenFormProps) {
  return (
    <SingleTokenCredentialForm
      provider="hetzner"
      credential={credential}
      onUpdate={onUpdate}
      title="Hetzner"
      noun="token"
      tokenLabel="Hetzner API Token"
      tokenId="hetzner-token"
      placeholder="Enter your Hetzner Cloud API token"
      help={
        <>
          Get your API token from{' '}
          <a
            href="https://console.hetzner.cloud/projects"
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent"
          >
            Hetzner Cloud Console
          </a>
          {' '}&gt; Your Project &gt; Security &gt; API Tokens
        </>
      }
    />
  );
}
